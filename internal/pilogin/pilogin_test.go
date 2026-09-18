package pilogin

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// fakeHelper is a scripted stand-in for the coconut-login helper.
// It speaks the same JSONL protocol over two os.Pipe pairs.
type fakeHelper struct {
	in  *bufio.Reader // helper reads requests (pipe A read-end)
	out *os.File      // helper writes responses/events (pipe B write-end)
}

// newFakeHelper wires up pipes and a Client.
//   pipe A: client writes (cIn) → helper reads (hIn)
//   pipe B: helper writes (hOut) → client reads (cOut)
func newFakeHelper(t *testing.T) (*Client, *fakeHelper) {
	t.Helper()
	hIn, cIn, err := os.Pipe() // hIn = read-end, cIn = write-end
	if err != nil {
		t.Fatal(err)
	}
	cOut, hOut, err := os.Pipe() // cOut = read-end, hOut = write-end
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = hIn.Close()
		_ = cIn.Close()
		_ = cOut.Close()
		_ = hOut.Close()
	})

	f := &fakeHelper{in: bufio.NewReader(hIn), out: hOut}
	client := NewWithPipes(cIn, cOut) // client stdin = cIn, stdout = cOut
	t.Cleanup(func() { _ = client.Close() })
	return client, f
}

// serve runs the fake helper script in a goroutine; when the script
// returns, the helper's write-end closes, signalling EOF to the client.
func (f *fakeHelper) serve(t *testing.T, script func(f *fakeHelper)) {
	t.Helper()
	go func() {
		defer f.out.Close() // helper exits → client sees EOF
		script(f)
	}()
}

// readReq reads one request record from the helper's stdin.
func (f *fakeHelper) readReq(t *testing.T) (map[string]any, bool) {
	t.Helper()
	line, err := f.in.ReadBytes('\n')
	if err != nil {
		t.Errorf("helper read: %v", err)
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		t.Errorf("helper decode: %v", err)
		return nil, false
	}
	return m, true
}

func (f *fakeHelper) emit(t *testing.T, m map[string]any) {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Errorf("helper marshal: %v", err)
		return
	}
	if _, err := f.out.Write(append(b, '\n')); err != nil {
		t.Errorf("helper write: %v", err)
	}
}

func TestStatusRoundTrip(t *testing.T) {
	client, f := newFakeHelper(t)
	f.serve(t, func(f *fakeHelper) {
		req, ok := f.readReq(t)
		if !ok {
			return
		}
		if req["type"] != "status" {
			t.Errorf("expected status request, got %v", req["type"])
			return
		}
		f.emit(t, map[string]any{"type": "ready"})
		f.emit(t, map[string]any{
			"type":        "status_result",
			"id":          req["id"],
			"providers":   []any{map[string]any{"id": "anthropic", "name": "Anthropic", "auth": map[string]any{"apiKey": true, "oauth": true}}},
			"credentials": []any{map[string]any{"providerId": "github-copilot", "type": "oauth"}},
		})
		time.Sleep(50 * time.Millisecond)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := client.Command(ctx, "status", nil)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !resp.OK || resp.Type != "status_result" {
		t.Fatalf("bad response: %+v", resp)
	}
	var body struct {
		Providers   []map[string]any `json:"providers"`
		Credentials []map[string]any `json:"credentials"`
	}
	if err := json.Unmarshal(resp.Raw, &body); err != nil || len(body.Providers) != 1 {
		t.Fatalf("bad raw: %v %+v", err, body)
	}

	// The ready event should have arrived on the event channel.
	sel := make(chan Event, 1)
	go func() { sel <- <-client.Events() }()
	select {
	case ev := <-sel:
		if ev.Type != "ready" {
			t.Fatalf("expected ready event, got %s", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("no ready event")
	}
}

func TestLoginWithPromptAndDone(t *testing.T) {
	client, f := newFakeHelper(t)
	f.serve(t, func(f *fakeHelper) {
		req, ok := f.readReq(t)
		if !ok {
			return
		}
		loginID, _ := req["id"].(string)
		if req["type"] != "login" || req["provider"] != "github-copilot" {
			t.Errorf("bad login request: %v", req)
			return
		}
		f.emit(t, map[string]any{"type": "notify", "id": loginID, "event": map[string]any{"type": "device_code", "userCode": "XXXX-YYYY"}})
		f.emit(t, map[string]any{"type": "prompt", "id": "p-1", "loginId": loginID, "prompt": map[string]any{"type": "manual_code", "label": "Enter the code"}})
		// Wait for the answer.
		ans, ok := f.readReq(t)
		if !ok {
			return
		}
		if ans["type"] != "prompt_response" || ans["id"] != "p-1" || ans["value"] != "CODE" {
			t.Errorf("bad prompt response: %v", ans)
			return
		}
		f.emit(t, map[string]any{"type": "done", "id": loginID, "credential": map[string]any{"type": "oauth"}})
		time.Sleep(50 * time.Millisecond)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		time.Sleep(100 * time.Millisecond)
		if err := client.Send(map[string]any{"type": "prompt_response", "id": "p-1", "value": "CODE"}); err != nil {
			t.Error(err)
		}
	}()

	resp, err := client.Command(ctx, "login", map[string]any{"provider": "github-copilot", "authType": "oauth"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if !resp.OK || resp.Type != "done" {
		t.Fatalf("expected done, got %s ok=%v", resp.Type, resp.OK)
	}

	// notify + prompt events must have been routed to the event channel.
	got := map[string]bool{}
	deadline := time.Now().Add(2 * time.Second)
	for len(got) < 2 && time.Now().Before(deadline) {
		select {
		case ev := <-client.Events():
			got[ev.Type] = true
		}
	}
	if !got["notify"] || !got["prompt"] {
		t.Fatalf("missing events: %v", got)
	}
}

func TestCancelledAndError(t *testing.T) {
	client, f := newFakeHelper(t)
	f.serve(t, func(f *fakeHelper) {
		req, ok := f.readReq(t)
		if !ok {
			return
		}
		f.emit(t, map[string]any{"type": "cancelled", "id": req["id"], "message": "user cancelled"})
		req2, ok := f.readReq(t)
		if !ok {
			return
		}
		f.emit(t, map[string]any{"type": "error", "id": req2["id"], "message": "boom"})
		time.Sleep(50 * time.Millisecond)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.Command(ctx, "login", map[string]any{"provider": "anthropic"})
	if err != nil || resp.OK || resp.Type != "cancelled" || !strings.Contains(resp.Message, "cancelled") {
		t.Fatalf("expected cancelled: %v %+v", err, resp)
	}

	resp2, err := client.Command(ctx, "logout", map[string]any{"provider": "anthropic"})
	if err != nil || resp2.OK || resp2.Type != "error" || resp2.Message != "boom" {
		t.Fatalf("expected error: %v %+v", err, resp2)
	}
}

func TestCommandIDBridgesIdentity(t *testing.T) {
	client, f := newFakeHelper(t)
	f.serve(t, func(f *fakeHelper) {
		req, ok := f.readReq(t)
		if !ok {
			return
		}
		loginID, _ := req["id"].(string)
		if loginID != "frontend-123" {
			t.Errorf("helper should see the caller-chosen id, got %v", req["id"])
		}
		// The helper echoes the request id in its events + response.
		f.emit(t, map[string]any{"type": "notify", "id": loginID, "event": map[string]any{"type": "device_code"}})
		f.emit(t, map[string]any{"type": "prompt", "id": "p-1", "loginId": loginID, "prompt": map[string]any{"type": "manual_code"}})
		ans, ok := f.readReq(t)
		if !ok || ans["type"] != "cancel" || ans["id"] != "frontend-123" {
			t.Errorf("bad cancel: %v", ans)
			return
		}
		f.emit(t, map[string]any{"type": "cancelled", "id": loginID, "message": "user cancelled"})
		time.Sleep(50 * time.Millisecond)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		time.Sleep(150 * time.Millisecond)
		_ = client.Send(map[string]any{"type": "cancel", "id": "frontend-123"})
	}()

	resp, err := client.CommandID(ctx, "frontend-123", "login", map[string]any{"provider": "github-copilot"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if resp.Type != "cancelled" || resp.ID != "frontend-123" {
		t.Fatalf("expected cancelled@frontend-123, got %s@%s", resp.Type, resp.ID)
	}

	// Events must carry the caller's id (this is what lets the frontend
	// match them to its flow state).
	var sawNotify, sawPrompt bool
	deadline := time.Now().Add(2 * time.Second)
	for !sawNotify || !sawPrompt {
		select {
		case ev := <-client.Events():
			switch ev.Type {
		case "notify", "prompt":
			var head struct {
				ID      string `json:"id"`
				LoginID string `json:"loginId"`
			}
			_ = json.Unmarshal(ev.Raw, &head)
			keyed := head.ID == "frontend-123" || head.LoginID == "frontend-123"
			if !keyed {
				t.Fatalf("event not keyed by the caller id: %s", ev.Raw)
			}
			if ev.Type == "notify" {
				sawNotify = true
			} else {
				sawPrompt = true
			}
		}
		case <-time.After(time.Until(deadline)):
			t.Fatalf("missing events: notify=%v prompt=%v", sawNotify, sawPrompt)
		}
	}
}

func TestHelperExitFailsPending(t *testing.T) {
	client, f := newFakeHelper(t)
	f.serve(t, func(f *fakeHelper) {
		f.readReq(t) // consume one request, then the helper exits (EOF)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := client.Command(ctx, "status", nil)
	if err == nil {
		t.Fatal("expected an error after helper exit")
	}
}
