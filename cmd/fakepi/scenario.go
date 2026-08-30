package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Scenario is a JSON script of steps executed in order. See README.md
// for the format reference.
type Scenario struct {
	Name  string `json:"name"`
	Steps []Step `json:"steps"`
}

// Step is exactly one of: waitFor, waitForResponse, emit (+delayMs),
// or emitIf (+delayMs applied to each event in the group).
type Step struct {
	WaitFor         *WaitFor       `json:"waitFor"`
	WaitForResponse string         `json:"waitForResponse"`
	Emit            map[string]any `json:"emit"`
	EmitIf          *EmitIf        `json:"emitIf"`
	DelayMs         int            `json:"delayMs"`
}

// WaitFor blocks until an inbound command matches. Command matches the
// pi command type ("prompt", "steer", "follow_up", ...); messageContains
// and messageContainsAll substring-match the command's "message" field.
type WaitFor struct {
	Command            string   `json:"command"`
	MessageContains    string   `json:"messageContains"`
	MessageContainsAll []string `json:"messageContainsAll"`
}

// EmitIf emits Events only when the most recent waitForResponse result
// equals Response ("confirmed" or "cancelled").
type EmitIf struct {
	Response string           `json:"response"`
	Events   []map[string]any `json:"events"`
}

func loadScenario(path string) (*Scenario, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read scenario: %w", err)
	}
	var scen Scenario
	if err := json.Unmarshal(b, &scen); err != nil {
		return nil, fmt.Errorf("parse scenario %s: %w", path, err)
	}
	if scen.Name == "" {
		scen.Name = path
	}
	return &scen, nil
}

// cmdWaiter is a registered waitFor step; matches is consulted by the
// dispatch loop for every inbound command.
type cmdWaiter struct {
	command            string
	messageContains    string
	messageContainsAll []string
	ch                 chan Command // buffered(1); receives the matched command
}

func (w *cmdWaiter) matches(c Command) bool {
	cmdType := c.Type
	// steer/follow_up are treated like prompt for scenario matching.
	if cmdType == "steer" || cmdType == "follow_up" {
		cmdType = "prompt"
	}
	if w.command != "" && cmdType != w.command {
		return false
	}
	msg, _ := c.Msg["message"].(string)
	if w.messageContains != "" && !strings.Contains(msg, w.messageContains) {
		return false
	}
	for _, sub := range w.messageContainsAll {
		if !strings.Contains(msg, sub) {
			return false
		}
	}
	return true
}

// respWaiter is a registered waitForResponse step, keyed by the
// extension_ui_request id it waits on.
type respWaiter struct {
	id string
	ch chan string // buffered(1); receives "confirmed" or "cancelled"
}

// engine executes a Scenario concurrently with command dispatch, so
// blocking steps never starve unrelated commands (get_state etc.).
type engine struct {
	s    *server
	scen *Scenario
}

func (e *engine) run() {
	defer e.s.engineDone.Store(true)
	lastResponse := ""
	flowStart := 0 // index of the waitFor that began the in-flight flow
	for i := 0; i < len(e.scen.Steps); i++ {
		step := e.scen.Steps[i]
		select {
		case <-e.s.done:
			return
		default:
		}
		switch {
		case step.WaitFor != nil:
			if e.s.aborted.Load() {
				// The previous flow was aborted mid-emission. Rewind to
				// its waitFor so the next matching prompt replays the
				// scripted flow instead of stranding the scenario
				// between steps. Clearing the latch here is safe: nothing
				// emits until the waitFor matches.
				i = flowStart - 1 // for-loop i++ lands on flowStart
				e.s.aborted.Store(false)
				continue
			}
			if !e.awaitCommand(step.WaitFor) {
				return
			}
			flowStart = i
			e.s.aborted.Store(false)
		case step.WaitForResponse != "":
			r, ok := e.awaitUIResponse(step.WaitForResponse)
			if !ok {
				return
			}
			lastResponse = r
		case step.EmitIf != nil:
			if step.EmitIf.Response == lastResponse {
				for _, ev := range step.EmitIf.Events {
					e.emitDelayed(ev, step.DelayMs)
				}
			}
		case step.Emit != nil:
			e.emitDelayed(step.Emit, step.DelayMs)
		default:
			fmt.Fprintf(os.Stderr, "fakepi: scenario step %d has no recognized kind, skipping\n", i)
		}
	}
	fmt.Fprintf(os.Stderr, "fakepi: scenario %q finished; further prompts get the canned reply\n", e.scen.Name)
}

func (e *engine) emitDelayed(ev map[string]any, delayMs int) {
	e.s.sleepOrAbort(delayMs)
	if e.s.aborted.Load() {
		return // aborted: scripted emission is cancelled
	}
	e.s.emitEvent(ev)
}

func (e *engine) awaitCommand(w *WaitFor) bool {
	cw := &cmdWaiter{
		command:            w.Command,
		messageContains:    w.MessageContains,
		messageContainsAll: w.MessageContainsAll,
		ch:                 make(chan Command, 1),
	}
	e.s.mu.Lock()
	e.s.cmdWaiter = cw
	e.s.mu.Unlock()
	select {
	case <-e.s.done:
		return false
	case <-cw.ch:
		return true
	}
}

func (e *engine) awaitUIResponse(id string) (string, bool) {
	// If the flow was aborted before this step registered (the dispatch
	// loop's abort handler can only resolve an already-registered
	// waiter), resolve as cancelled so the scenario isn't stranded.
	if e.s.aborted.Load() {
		return "cancelled", true
	}
	rw := &respWaiter{id: id, ch: make(chan string, 1)}
	e.s.mu.Lock()
	e.s.respWaiter = rw
	e.s.mu.Unlock()
	select {
	case <-e.s.done:
		return "", false
	case r := <-rw.ch:
		return r, true
	}
}
