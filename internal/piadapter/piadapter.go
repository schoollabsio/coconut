// Package piadapter wraps the pi sidecar process and its JSONL RPC
// protocol (pi docs/rpc.md). It owns the process lifecycle, command/
// response correlation, and the raw event stream. It deliberately knows
// nothing about custard's domain; normalization lives in internal/core.
package piadapter

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
)

// Event is a single non-response JSONL record from pi (agent events,
// extension_ui_request dialogs, etc.). Raw carries the full record for
// the normalizer.
type Event struct {
	Type string // e.g. "agent_start", "message_update", "extension_ui_request"
	Raw  json.RawMessage
}

// Response answers a command sent via Command().
type Response struct {
	ID      string
	Command string
	Success bool
	Data    json.RawMessage
	Err     string
}

// Client is a single pi sidecar session. Not safe to reuse after exit.
type Client struct {
	stdin  io.WriteCloser
	stdout io.Reader
	wait   func() error // process wait; nil for pipe-based clients

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan Response

	nextID atomic.Uint64

	events  chan Event
	exited  chan struct{}
	exitErr error

	readDone chan struct{}
}

// wireResponse mirrors pi's response envelope on the wire.
type wireResponse struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

// wireCommand is what we send; Type is the pi command name.
type wireCommand struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

// NewWithPipes builds a Client over existing streams (tests, fakes).
// stdin may be nil if only reading events.
func NewWithPipes(stdin io.WriteCloser, stdout io.Reader) *Client {
	c := &Client{
		stdin:    stdin,
		stdout:   stdout,
		pending:  make(map[string]chan Response),
		events:   make(chan Event, 256),
		exited:   make(chan struct{}),
		readDone: make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Events returns the raw event stream. Closed when the sidecar exits.
func (c *Client) Events() <-chan Event { return c.events }

// Exited is closed when the read loop ends (process exited or streams
// closed). ExitErr reports why, if known.
func (c *Client) Exited() <-chan struct{} { return c.exited }

func (c *Client) ExitErr() error { return c.exitErr }

// Command sends a pi command and waits for its response. The ctx bounds
// the wait. fields are merged into the command object (e.g. "message"
// for "prompt").
func (c *Client) Command(ctx context.Context, name string, fields map[string]any) (Response, error) {
	id := fmt.Sprintf("c%d", c.nextID.Add(1))

	obj := map[string]any{"type": name, "id": id}
	for k, v := range fields {
		obj[k] = v
	}

	ch := make(chan Response, 1)
	c.pendingMu.Lock()
	if c.isClosedLocked() {
		c.pendingMu.Unlock()
		return Response{}, errors.New("piadapter: sidecar not running")
	}
	c.pending[id] = ch
	c.pendingMu.Unlock()

	if err := c.writeJSON(obj); err != nil {
		c.dropPending(id)
		return Response{}, fmt.Errorf("piadapter: write %s: %w", name, err)
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		c.dropPending(id)
		return Response{}, ctx.Err()
	case <-c.exited:
		return Response{}, errors.New("piadapter: sidecar exited mid-command")
	}
}

// Send writes a fire-and-forget message that expects no response
// (e.g. extension_ui_response).
func (c *Client) Send(obj map[string]any) error {
	return c.writeJSON(obj)
}

func (c *Client) writeJSON(obj any) error {
	if c.stdin == nil {
		return errors.New("piadapter: no stdin")
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

// readLoop decodes JSONL records. Framing per rpc.md: split on '\n'
// only, strip a single trailing '\r'. bufio.Reader.ReadBytes complies.
func (c *Client) readLoop() {
	defer close(c.readDone)
	defer close(c.events)
	defer close(c.exited)
	defer c.failAllPending(errors.New("piadapter: sidecar exited"))

	reader := bufio.NewReaderSize(c.stdout, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = trimRecord(line)
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

func trimRecord(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// route classifies a record as command response (by id) or event.
func (c *Client) route(line []byte) {
	// Cheap classification: responses always carry "type":"response".
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		// Not valid JSON: surface as a synthetic event so the core can
		// log it without killing the stream.
		c.emit(Event{Type: "malformed_line", Raw: json.RawMessage(strQuote(string(line)))})
		return
	}

	if head.Type == "response" {
		var wr wireResponse
		if err := json.Unmarshal(line, &wr); err != nil {
			c.emit(Event{Type: "malformed_response", Raw: json.RawMessage(strQuote(string(line)))})
			return
		}
		resp := Response{ID: wr.ID, Command: wr.Command, Success: wr.Success, Data: wr.Data, Err: wr.Error}
		c.pendingMu.Lock()
		ch, ok := c.pending[wr.ID]
		if ok {
			delete(c.pending, wr.ID)
		}
		c.pendingMu.Unlock()
		if ok {
			ch <- resp
		}
		// Responses for ids we are not waiting on (e.g. aborted waits)
		// are dropped by design.
		return
	}

	c.emit(Event{Type: head.Type, Raw: json.RawMessage(append([]byte(nil), line...))})
}

func (c *Client) emit(ev Event) {
	select {
	case c.events <- ev:
	default:
		// Never block the read loop; a full channel means the core is
		// wedged. Drop is preferable to deadlock; core resyncs via
		// snapshot on sequence gaps anyway.
	}
}

func (c *Client) failAllPending(err error) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	for id, ch := range c.pending {
		ch <- Response{ID: id, Success: false, Err: err.Error()}
		delete(c.pending, id)
	}
}

// Close terminates the sidecar (if it owns a process) and closes stdin.
func (c *Client) Close() error {
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	return nil
}

func strQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ---------------------------------------------------------------------------
// Process-backed client
// ---------------------------------------------------------------------------

// ProcessConfig describes how to launch the sidecar.
type ProcessConfig struct {
	Binary string   // path to pi binary (bundled custard-pi or system "pi")
	Args   []string // full argument list (see LaunchArgs)
	Env    []string // extra environment (merged over os.Environ by caller)
	Dir    string   // working directory (the workspace)
}

// StartProcess spawns the sidecar and returns a ready Client plus the
// underlying cmd for lifecycle management.
func StartProcess(cfg ProcessConfig, extraEnv []string) (*Client, *exec.Cmd, error) {
	cmd := exec.Command(cfg.Binary, cfg.Args...)
	cmd.Dir = cfg.Dir
	cmd.Env = extraEnv

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("piadapter: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("piadapter: stdout pipe: %w", err)
	}
	// Stderr is inherited for now (useful during development); pi writes
	// only protocol JSON to stdout, so this is safe.

	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("piadapter: start %s: %w", cfg.Binary, err)
	}

	c := NewWithPipes(stdin, stdout)
	go func() {
		err := cmd.Wait()
		if err != nil {
			c.exitErr = err
		}
		// readLoop closing exited is the authoritative signal.
	}()
	return c, cmd, nil
}
