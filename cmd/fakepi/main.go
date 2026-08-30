// Command fakepi is a scripted, wire-compatible stand-in for
// `pi --mode rpc`, used by custard development and integration tests
// to exercise the full backend without making LLM calls.
//
// It reads JSONL commands on stdin and writes JSONL responses/events
// on stdout, framed per docs/rpc.md: records are split on '\n' only
// and a single trailing '\r' is stripped (bufio.Scanner's ScanLines
// does exactly this and, unlike Node readline, does not split on
// U+2028/U+2029). Nothing but protocol JSON is written to stdout;
// diagnostics go to stderr.
//
// Usage:
//
//	go run ./cmd/fakepi [-scenario testdata/scenarios/todo-app.json]
//
// Without -scenario, every prompt gets a small canned reply flow.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// maxLineSize bounds a single JSONL record (rpc.md: use a 10MB buffer).
const maxLineSize = 10 * 1024 * 1024

// Command is one parsed stdin record.
type Command struct {
	Type string          // the "type" field, e.g. "prompt"
	ID   json.RawMessage // optional "id", echoed verbatim in the response
	Msg  map[string]any  // full decoded object
}

func parseCommand(line []byte) (Command, error) {
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return Command{}, err
	}
	c := Command{Msg: m}
	if t, ok := m["type"].(string); ok {
		c.Type = t
	}
	if id, ok := m["id"]; ok {
		// Round-trip the id so strings/numbers are echoed unchanged.
		b, _ := json.Marshal(id)
		c.ID = b
	}
	return c, nil
}

// writer serializes all stdout writes (dispatch loop, scenario engine
// and canned flows may all emit concurrently).
type writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *writer) writeJSON(v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.enc.Encode(v); err != nil {
		fmt.Fprintf(os.Stderr, "fakepi: stdout write failed: %v\n", err)
	}
}

type server struct {
	w  *writer
	st *state

	aborted   atomic.Bool // set by `abort`; engine skips emits until the next waitFor match
	streaming atomic.Bool // true between agent_start and agent_end/agent_settled

	// Waiters registered by the scenario engine. At most one of each is
	// active at a time (the engine is sequential).
	mu         sync.Mutex
	cmdWaiter  *cmdWaiter
	respWaiter *respWaiter

	cmdCh chan Command
	done  chan struct{} // closed when stdin reaches EOF

	// engineDone reports the scenario engine has finished (or was never
	// started), so abort handling doesn't wait for it to re-park.
	engineDone atomic.Bool
}

func newServer() *server {
	return &server{
		w:     &writer{enc: json.NewEncoder(os.Stdout)},
		st:    newState(),
		cmdCh: make(chan Command),
		done:  make(chan struct{}),
	}
}

func main() {
	scenarioPath := flag.String("scenario", "", "path to a scenario JSON file (optional)")
	flag.Parse()

	s := newServer()

	if *scenarioPath != "" {
		scen, err := loadScenario(*scenarioPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakepi: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "fakepi: loaded scenario %q (%d steps)\n", scen.Name, len(scen.Steps))
		go (&engine{s: s, scen: scen}).run()
	} else {
		s.engineDone.Store(true)
		fmt.Fprintln(os.Stderr, "fakepi: no scenario; all prompts get the canned reply")
	}

	go s.readLoop()
	s.run()
}

// readLoop scans stdin and forwards parsed commands. Per rpc.md framing
// we split on '\n' only; ScanLines additionally strips one trailing '\r',
// which is exactly the tolerated CRLF input form.
func (s *server) readLoop() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), maxLineSize)
	for sc.Scan() {
		line := bytes.TrimSuffix(sc.Bytes(), []byte("\r"))
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		c, err := parseCommand(line)
		if err != nil {
			s.w.writeJSON(map[string]any{
				"type":    "response",
				"command": "parse",
				"success": false,
				"error":   "Failed to parse command: " + err.Error(),
			})
			continue
		}
		s.cmdCh <- c
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "fakepi: stdin read: %v\n", err)
	}
	close(s.cmdCh)
}

func (s *server) run() {
	for c := range s.cmdCh {
		s.dispatch(c)
	}
	close(s.done) // release any blocked scenario waits
}

func (s *server) dispatch(c Command) {
	switch c.Type {
	case "extension_ui_response":
		// A client answer to an extension_ui_request, not a command:
		// pi does not send a response envelope for it.
		s.handleUIResponse(c)
	case "prompt", "steer", "follow_up":
		s.handlePrompt(c)
	case "abort":
		s.handleAbort(c)
	case "new_session":
		s.st.clear()
		s.aborted.Store(false)
		s.respondOK(c, map[string]any{"cancelled": false})
	case "get_state":
		s.respondOK(c, s.stateData())
	case "get_messages":
		s.respondOK(c, map[string]any{"messages": s.st.snapshotMessages()})
	case "set_session_name":
		name, _ := c.Msg["name"].(string)
		s.st.setName(name)
		s.respondOK(c, nil)
	case "get_session_stats":
		s.respondOK(c, s.statsData())
	case "get_commands":
		s.respondOK(c, map[string]any{"commands": []any{}})
	case "bash":
		s.respondOK(c, map[string]any{"output": "", "exitCode": 0, "cancelled": false, "truncated": false})
	case "":
		s.respondErr(c, "missing command type")
	default:
		s.respondErr(c, "fakepi: unknown command: "+c.Type)
	}
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

func (s *server) handlePrompt(c Command) {
	msg, _ := c.Msg["message"].(string)
	s.st.addUserMessage(msg)
	// The matched/unmatched command gets its success response immediately,
	// before any scripted emission starts.
	s.respondOK(c, nil)
	if s.tryMatchCmdWaiter(c) {
		return // scenario engine takes over from its waitFor step
	}
	go s.cannedFlow()
}

func (s *server) handleAbort(c Command) {
	first := !s.aborted.Swap(true)
	// Unstick any pending dialog so the scenario engine isn't stranded;
	// pi effectively resolves the blocked extension call on abort too.
	s.mu.Lock()
	if rw := s.respWaiter; rw != nil {
		s.respWaiter = nil
		rw.ch <- "cancelled"
	}
	parked := s.cmdWaiter != nil // engine idle at a waitFor: nothing to cancel
	s.mu.Unlock()
	// Mid-flow: wait (bounded) until the engine has skipped the rest of
	// the aborted flow and re-parked at the flow's waitFor, so a client
	// that re-prompts right after the abort response hits the armed
	// scenario instead of the canned fallback.
	if first && !parked && !s.engineDone.Load() {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			s.mu.Lock()
			reParked := s.cmdWaiter != nil
			s.mu.Unlock()
			if reParked || s.engineDone.Load() {
				break
			}
			time.Sleep(time.Millisecond)
		}
	}
	s.respondOK(c, nil)
	// Close out an in-flight flow so isStreaming and clients settle.
	if first && s.streaming.Load() {
		s.emitEvent(map[string]any{"type": "agent_end", "messages": []any{}, "willRetry": false})
		s.emitEvent(map[string]any{"type": "agent_settled"})
	}
}

func (s *server) handleUIResponse(c Command) {
	id, _ := c.Msg["id"].(string)
	result := "cancelled"
	if conf, ok := c.Msg["confirmed"].(bool); ok && conf {
		result = "confirmed"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if rw := s.respWaiter; rw != nil && rw.id == id {
		s.respWaiter = nil
		rw.ch <- result // buffered; never blocks
		return
	}
	fmt.Fprintf(os.Stderr, "fakepi: extension_ui_response %q: no pending request\n", id)
}

// tryMatchCmdWaiter reports whether the command satisfies the engine's
// current waitFor step; if so it hands the command to the engine.
func (s *server) tryMatchCmdWaiter(c Command) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.cmdWaiter
	if w == nil || !w.matches(c) {
		return false
	}
	s.cmdWaiter = nil
	w.ch <- c // buffered; never blocks
	return true
}

// ---------------------------------------------------------------------------
// Canned fallback flow
// ---------------------------------------------------------------------------

// cannedFlow is emitted for any prompt/steer/follow_up that does not match
// the scenario's current waitFor (or when no scenario is loaded at all).
func (s *server) cannedFlow() {
	const reply = "[fakepi] default reply — no scripted step matched your prompt."
	half := len(reply) / 2
	s.emitEvent(map[string]any{"type": "agent_start"})
	s.emitEvent(map[string]any{"type": "turn_start"})
	s.emitEvent(map[string]any{"type": "message_start", "message": map[string]any{
		"role": "assistant", "content": []any{map[string]any{"type": "text", "text": ""}},
	}})
	s.emitEvent(textDelta(reply[:half]))
	time.Sleep(20 * time.Millisecond)
	s.emitEvent(textDelta(reply[half:]))
	s.emitEvent(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{
		"type": "text_end", "contentIndex": 0, "content": reply,
	}})
	s.emitEvent(map[string]any{"type": "message_end"})
	s.emitEvent(map[string]any{"type": "turn_end", "toolResults": []any{}})
	s.emitEvent(map[string]any{"type": "agent_end", "messages": []any{}, "willRetry": false})
	s.emitEvent(map[string]any{"type": "agent_settled"})
}

// ---------------------------------------------------------------------------
// Responses / state views
// ---------------------------------------------------------------------------

func (s *server) respond(c Command, success bool, data any, errStr string) {
	r := map[string]any{"type": "response", "command": c.Type, "success": success}
	if c.ID != nil {
		r["id"] = c.ID
	}
	if data != nil {
		r["data"] = data
	}
	if errStr != "" {
		r["error"] = errStr
	}
	s.w.writeJSON(r)
}

func (s *server) respondOK(c Command, data any)    { s.respond(c, true, data, "") }
func (s *server) respondErr(c Command, msg string) { s.respond(c, false, nil, msg) }

func fakeModel() map[string]any {
	return map[string]any{
		"id":            "fake-1",
		"name":          "FakePi Model",
		"api":           "fake-messages",
		"provider":      "fake",
		"baseUrl":       "http://localhost/",
		"reasoning":     true,
		"input":         []string{"text"},
		"contextWindow": 200000,
		"maxTokens":     8192,
		"cost":          map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
	}
}

func (s *server) stateData() map[string]any {
	d := map[string]any{
		"model":                 fakeModel(),
		"thinkingLevel":         "medium",
		"isStreaming":           s.streaming.Load(),
		"isCompacting":          false,
		"steeringMode":          "one-at-a-time",
		"followUpMode":          "one-at-a-time",
		"sessionFile":           nil,
		"sessionId":             "fake-session",
		"autoCompactionEnabled": true,
		"messageCount":          s.st.count(),
		"pendingMessageCount":   0,
	}
	if name := s.st.name(); name != "" {
		d["sessionName"] = name
	}
	return d
}

func (s *server) statsData() map[string]any {
	users, assistants := s.st.roleCounts()
	return map[string]any{
		"sessionFile":       nil,
		"sessionId":         "fake-session",
		"userMessages":      users,
		"assistantMessages": assistants,
		"toolCalls":         0,
		"toolResults":       0,
		"totalMessages":     users + assistants,
		"tokens":            map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
		"cost":              0,
	}
}

// ---------------------------------------------------------------------------
// Emission helpers shared by engine and canned flow
// ---------------------------------------------------------------------------

// emitEvent updates session state derived from the event, then writes it.
func (s *server) emitEvent(ev map[string]any) {
	s.observeEvent(ev)
	s.w.writeJSON(ev)
}

func textDelta(delta string) map[string]any {
	return map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type": "text_delta", "contentIndex": 0, "delta": delta,
		},
	}
}

// sleepOrAbort sleeps for ms in small ticks so `abort` interrupts long
// scripted delays promptly.
func (s *server) sleepOrAbort(ms int) {
	if ms <= 0 {
		return
	}
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	for time.Now().Before(deadline) {
		if s.aborted.Load() {
			return
		}
		t := time.Until(deadline)
		if t > 10*time.Millisecond {
			t = 10 * time.Millisecond
		}
		time.Sleep(t)
	}
}
