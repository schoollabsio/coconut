// Package pilogin wraps the coconut-login helper process (a headless
// driver for pi's ModelRuntime auth flows, see pi-login/helper.ts) and
// its JSONL protocol. It owns the process lifecycle and command/response
// correlation. It deliberately knows nothing about coconut's domain;
// normalization lives in internal/core (auth.go).
//
// Wire protocol (one JSON object per line):
//
//	requests  (stdin) : {"type":"login"|"set_api_key"|"logout"|"status"|
//	                    "models"|"prompt_response"|"cancel", "id":...}
//	responses (stdout): {"type":"done"|"cancelled"|"error"|"ack"|
//	                    "status_result"|"models_result", "id":...}
//	events    (stdout): {"type":"ready"|"notify"|"prompt", ...}
//
// Unlike pi's RPC (type:"response" envelope), helper responses carry
// their own result type, so routing is by TYPE name: the six response
// types above resolve a pending request by id; everything else is an
// event.
package pilogin

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// Event is an asynchronous helper record (ready, notify, prompt).
type Event struct {
	Type string
	Raw  json.RawMessage
}

// Response answers a request sent via Command(). Raw carries the full
// record for the caller to unmarshal; Message is populated for
// cancelled/error results.
type Response struct {
	ID      string
	Type    string // done | cancelled | error | ack | status_result | models_result
	OK      bool
	Message string
	Raw     json.RawMessage
}

type pendingResult struct {
	resp Response
	err  error
}

// responseTypes are the record types that resolve a pending request.
var responseTypes = map[string]bool{
	"done":          true,
	"cancelled":     true,
	"error":         true,
	"ack":           true,
	"status_result": true,
	"models_result": true,
}

type Client struct {
	stdin  io.WriteCloser
	stdout io.Reader

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan pendingResult

	nextID atomic.Uint64

	events  chan Event
	exited  chan struct{}
	exitErr error
}

// NewWithPipes builds a Client over existing streams (tests, fakes).
func NewWithPipes(stdin io.WriteCloser, stdout io.Reader) *Client {
	c := &Client{
		stdin:   stdin,
		stdout:  stdout,
		pending: make(map[string]chan pendingResult),
		events:  make(chan Event, 256),
		exited:  make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Events returns the helper event stream. Closed when the helper exits.
func (c *Client) Events() <-chan Event { return c.events }

// Exited is closed when the read loop ends. ExitErr reports why, if known.
func (c *Client) Exited() <-chan struct{} { return c.exited }

func (c *Client) ExitErr() error { return c.exitErr }

// Command sends a helper request with an auto-generated id and waits for
// its response. The ctx bounds the wait. fields are merged into the
// request object.
func (c *Client) Command(ctx context.Context, name string, fields map[string]any) (Response, error) {
	return c.CommandID(ctx, "", name, fields)
}

// CommandID is Command with a caller-chosen correlation id. The id appears
// in the helper's response AND in the events it emits while the request
// runs (notify/prompt carry it), so the caller can bridge it to its own
// identity (e.g. the frontend command id a login flow is keyed by).
// An empty id falls back to auto-generation.
func (c *Client) CommandID(ctx context.Context, id, name string, fields map[string]any) (Response, error) {
	if id == "" {
		id = fmt.Sprintf("h%d", c.nextID.Add(1))
	}

	obj := map[string]any{"type": name, "id": id}
	for k, v := range fields {
		obj[k] = v
	}

	ch := make(chan pendingResult, 1)
	c.pendingMu.Lock()
	if c.isClosedLocked() {
		c.pendingMu.Unlock()
		return Response{}, errors.New("pilogin: helper not running")
	}
	c.pending[id] = ch
	c.pendingMu.Unlock()

	if err := c.writeJSON(obj); err != nil {
		c.dropPending(id)
		return Response{}, fmt.Errorf("pilogin: write %s: %w", name, err)
	}

	select {
	case res := <-ch:
		return res.resp, res.err
	case <-ctx.Done():
		c.dropPending(id)
		return Response{}, ctx.Err()
	case <-c.exited:
		return Response{}, errors.New("pilogin: helper exited mid-command")
	}
}

// Send writes a fire-and-forget request that expects no response
// (prompt_response, cancel).
func (c *Client) Send(obj map[string]any) error {
	return c.writeJSON(obj)
}

func (c *Client) writeJSON(obj any) error {
	if c.stdin == nil {
		return errors.New("pilogin: no stdin")
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(b)
	return err
}

func (c *Client) dropPending(id string) {
	c.pendingMu.Lock()
	delete(c.pending, id)
	c.pendingMu.Unlock()
}

func (c *Client) isClosedLocked() bool {
	select {
	case <-c.exited:
		return true
	default:
		return false
	}
}

// readLoop decodes JSONL records and routes them by type name.
func (c *Client) readLoop() {
	defer close(c.events)
	defer close(c.exited)
	defer c.failAllPending(errors.New("pilogin: helper exited"))

	reader := bufio.NewReaderSize(c.stdout, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = trimLine(line)
			if len(line) > 0 {
				c.route(line)
			}
		}
		if err != nil {
			if err != io.EOF {
				c.exitErr = err
			}
			return
		}
	}
}

func trimLine(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

func (c *Client) route(line []byte) {
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return // helper stdout is protocol-only; ignore garbage
	}

	if !responseTypes[head.Type] {
		c.emit(Event{Type: head.Type, Raw: json.RawMessage(append([]byte(nil), line...))})
		return
	}

	resp := Response{ID: head.ID, Type: head.Type, Raw: json.RawMessage(append([]byte(nil), line...))}
	switch head.Type {
	case "done", "ack", "status_result", "models_result":
		resp.OK = true
	case "cancelled":
		resp.Message = jsonGetMessage(line)
		resp.OK = false
	case "error":
		resp.Message = jsonGetMessage(line)
		resp.OK = false
	}

	c.pendingMu.Lock()
	ch, ok := c.pending[resp.ID]
	if ok {
		delete(c.pending, resp.ID)
	}
	c.pendingMu.Unlock()
	if ok {
		ch <- pendingResult{resp: resp}
	}
}

// jsonGetMessage pulls the "message" field out of a record.
func jsonGetMessage(line []byte) string {
	var m struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(line, &m)
	return m.Message
}

func (c *Client) emit(ev Event) {
	select {
	case c.events <- ev:
	default:
	}
}

func (c *Client) failAllPending(err error) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	for id, ch := range c.pending {
		ch <- pendingResult{err: err}
		delete(c.pending, id)
	}
}

// Close closes stdin (the helper exits on stdin EOF).
func (c *Client) Close() error {
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Process launch + binary resolution
// ---------------------------------------------------------------------------

// StartProcess spawns the helper with the given environment and returns
// the client plus the underlying cmd for lifecycle management.
func StartProcess(binary string, env []string) (*Client, *exec.Cmd, error) {
	cmd := exec.Command(binary)
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("pilogin: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("pilogin: stdout pipe: %w", err)
	}
	// Stderr is inherited: the helper writes diagnostics there only.

	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("pilogin: start %s: %w", binary, err)
	}

	c := NewWithPipes(stdin, stdout)
	go func() {
		err := cmd.Wait()
		if err != nil {
			c.exitErr = err
		}
	}()
	return c, cmd, nil
}

// MergedEnv returns os.Environ plus extra KEY=VALUE entries.
func MergedEnv(extra []string) []string {
	return append(os.Environ(), extra...)
}

// ResolveLoginHelper locates the coconut-login binary: the COCONUT_LOGIN_HELPER
// override, next to the app binary (packaged), or under build/sidecar/ (dev).
func ResolveLoginHelper(selfPath string) string {
	if p := os.Getenv("COCONUT_LOGIN_HELPER"); p != "" {
		return p
	}
	if selfPath != "" {
		dir := filepath.Dir(selfPath)
		if p := filepath.Join(dir, "coconut-login"); isRegular(p) {
			return p
		}
		for i := 0; i < 6; i++ {
			if p := filepath.Join(dir, "build", "sidecar", "coconut-login"); isRegular(p) {
				if abs, err := filepath.Abs(p); err == nil {
					return abs
				}
				return p
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "coconut-login" // PATH fallback
}

func isRegular(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}
