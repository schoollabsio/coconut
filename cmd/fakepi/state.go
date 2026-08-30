package main

import (
	"strings"
	"sync"
	"time"
)

// state tracks the session-shaped data that get_state / get_messages
// report: accumulated user + assistant messages, the session name, and
// the in-flight partial assistant message being streamed via
// message_start / message_update / message_end events.
type state struct {
	mu          sync.Mutex
	messages    []map[string]any
	sessionName string
	partial     *strings.Builder // non-nil while an assistant message streams
}

func newState() *state { return &state{} }

func (st *state) addUserMessage(text string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.messages = append(st.messages, map[string]any{
		"role":      "user",
		"content":   text,
		"timestamp": time.Now().UnixMilli(),
	})
}

// observeEvent folds an emitted event into session state before it is
// written to stdout, so get_state/get_messages stay coherent with the
// event stream. It may enrich the event (message_end gains the assembled
// assistant message, mirroring rpc.md: "Treat message_end.message as
// authoritative").
func (s *server) observeEvent(ev map[string]any) {
	typ, _ := ev["type"].(string)
	switch typ {
	case "agent_start":
		s.streaming.Store(true)
	case "agent_end", "agent_settled":
		s.streaming.Store(false)
	case "message_start":
		s.st.beginAssistant()
	case "message_update":
		if ame, ok := ev["assistantMessageEvent"].(map[string]any); ok {
			if ame["type"] == "text_delta" {
				if d, _ := ame["delta"].(string); d != "" {
					s.st.appendDelta(d)
				}
			}
		}
	case "message_end":
		ev["message"] = s.st.endAssistant()
	}
}

func (st *state) beginAssistant() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.partial = &strings.Builder{}
}

func (st *state) appendDelta(d string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.partial != nil {
		st.partial.WriteString(d)
	}
}

// endAssistant finalizes the partial assistant message and appends it to
// the history. Returns the assembled AgentMessage-shaped object.
func (st *state) endAssistant() map[string]any {
	st.mu.Lock()
	defer st.mu.Unlock()
	text := ""
	if st.partial != nil {
		text = st.partial.String()
		st.partial = nil
	}
	msg := map[string]any{
		"role": "assistant",
		"content": []any{
			map[string]any{"type": "text", "text": text},
		},
		"api":      "fake-messages",
		"provider": "fake",
		"model":    "fake-1",
		"usage": map[string]any{
			"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
			"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
		},
		"stopReason": "stop",
		"timestamp":  time.Now().UnixMilli(),
	}
	st.messages = append(st.messages, msg)
	return msg
}

func (st *state) snapshotMessages() []map[string]any {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]map[string]any, len(st.messages))
	copy(out, st.messages)
	return out
}

func (st *state) count() int {
	st.mu.Lock()
	defer st.mu.Unlock()
	return len(st.messages)
}

func (st *state) roleCounts() (users, assistants int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, m := range st.messages {
		switch m["role"] {
		case "user":
			users++
		case "assistant":
			assistants++
		}
	}
	return
}

func (st *state) setName(name string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.sessionName = name
}

func (st *state) name() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.sessionName
}

func (st *state) clear() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.messages = nil
	st.partial = nil
	st.sessionName = "" // a fresh session has no name yet
}
