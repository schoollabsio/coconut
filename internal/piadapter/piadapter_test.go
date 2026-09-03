package piadapter

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

// fakeSidecar wires a client to in-memory pipes the test can drive.
type fakeSidecar struct {
	client   *Client
	toPi     *io.PipeReader // client's stdin
	fromPi   *io.PipeWriter // client's stdout
	writeBuf chan string
}

func newFakeSidecar() *fakeSidecar {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	f := &fakeSidecar{
		client:   NewWithPipes(stdinW, stdoutR),
		toPi:     stdinR,
		fromPi:   stdoutW,
		writeBuf: make(chan string, 64),
	}
	// Drain whatever the client writes so tests can inspect it.
	go func() {
		reader := bufio.NewReader(stdinR)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				close(f.writeBuf)
				return
			}
			f.writeBuf <- strings.TrimRight(line, "\r\n")
		}
	}()
	return f
}

func (f *fakeSidecar) emit(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(f.fromPi, line+"\n"); err != nil {
		t.Fatalf("emit: %v", err)
	}
}

func (f *fakeSidecar) nextWrite(t *testing.T) string {
	t.Helper()
	select {
	case line, ok := <-f.writeBuf:
		if !ok {
			t.Fatal("client stdin closed unexpectedly")
		}
		return line
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for client write")
		return ""
	}
}

func TestCommandResponseCorrelation(t *testing.T) {
	f := newFakeSidecar()
	defer f.client.Close()

	respCh := make(chan Response, 1)
	go func() {
		resp, err := f.client.Command(context.Background(), "get_state", nil)
		if err != nil {
			t.Errorf("command: %v", err)
		}
		respCh <- resp
	}()

	// Inspect the outgoing command and answer with the echoed id.
	sent := f.nextWrite(t)
	var cmd map[string]any
	if err := json.Unmarshal([]byte(sent), &cmd); err != nil {
		t.Fatalf("sent command not JSON: %v", err)
	}
	if cmd["type"] != "get_state" {
		t.Fatalf("command type = %v", cmd["type"])
	}
	id, _ := cmd["id"].(string)
	if id == "" {
		t.Fatal("command missing id")
	}

	f.emit(t, `{"type":"response","id":"`+id+`","command":"get_state","success":true,"data":{"sessionId":"x"}}`)

	select {
	case resp := <-respCh:
		if !resp.Success || resp.Command != "get_state" {
			t.Fatalf("bad response: %+v", resp)
		}
		var data struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(resp.Data, &data); err != nil || data.SessionID != "x" {
			t.Fatalf("bad data: %v %q", err, resp.Data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no response routed")
	}
}

func TestOutOfOrderResponses(t *testing.T) {
	f := newFakeSidecar()
	defer f.client.Close()

	type result struct {
		resp Response
		err  error
	}
	r1 := make(chan result, 1)
	r2 := make(chan result, 1)

	go func() {
		r, err := f.client.Command(context.Background(), "get_state", nil)
		r1 <- result{r, err}
	}()
	first := f.nextWrite(t)
	var c1 map[string]any
	_ = json.Unmarshal([]byte(first), &c1)

	go func() {
		r, err := f.client.Command(context.Background(), "get_messages", nil)
		r2 <- result{r, err}
	}()
	second := f.nextWrite(t)
	var c2 map[string]any
	_ = json.Unmarshal([]byte(second), &c2)

	// Respond to the second command first.
	f.emit(t, `{"type":"response","id":"`+c2["id"].(string)+`","command":"get_messages","success":true,"data":{"messages":[]}}`)
	f.emit(t, `{"type":"response","id":"`+c1["id"].(string)+`","command":"get_state","success":true}`)

	for i, ch := range []chan result{r1, r2} {
		select {
		case res := <-ch:
			if res.err != nil || !res.resp.Success {
				t.Fatalf("cmd %d: %+v err=%v", i, res.resp, res.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("cmd %d never resolved", i)
		}
	}
}

func TestEventsAndCRLF(t *testing.T) {
	f := newFakeSidecar()
	defer f.client.Close()

	// CRLF framing must be tolerated; blank lines skipped.
	f.emit(t, "{\"type\":\"agent_start\"}\r")
	f.emit(t, "")
	f.emit(t, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}`)

	for _, want := range []string{"agent_start", "message_update"} {
		select {
		case ev := <-f.client.Events():
			if ev.Type != want {
				t.Fatalf("event type = %q, want %q", ev.Type, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("missing event %q", want)
		}
	}
}

func TestSendFireAndForget(t *testing.T) {
	f := newFakeSidecar()
	defer f.client.Close()

	if err := f.client.Send(map[string]any{"type": "extension_ui_response", "id": "u1", "confirmed": true}); err != nil {
		t.Fatalf("send: %v", err)
	}
	sent := f.nextWrite(t)
	var msg map[string]any
	if err := json.Unmarshal([]byte(sent), &msg); err != nil {
		t.Fatalf("sent not JSON: %v", err)
	}
	if msg["type"] != "extension_ui_response" || msg["confirmed"] != true {
		t.Fatalf("unexpected payload: %v", msg)
	}
}

func TestExitFailsPendingAndCloses(t *testing.T) {
	f := newFakeSidecar()

	errCh := make(chan error, 1)
	go func() {
		_, err := f.client.Command(context.Background(), "get_state", nil)
		errCh <- err
	}()
	_ = f.nextWrite(t) // command in flight

	// Simulate process exit: close the event stream.
	_ = f.fromPi.Close()

	select {
	case <-f.client.Exited():
	case <-time.After(2 * time.Second):
		t.Fatal("Exited never closed")
	}
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("pending command should fail on exit")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending command never resolved after exit")
	}
	// Events channel must drain-close.
	for range f.client.Events() {
	}
}

func TestCommandContextTimeout(t *testing.T) {
	f := newFakeSidecar()
	defer f.client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := f.client.Command(ctx, "get_state", nil)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	_ = f.nextWrite(t) // drain so the goroutine writer doesn't block
}

func TestLaunchSpecArgs(t *testing.T) {
	spec := BuildLaunchSpec(
		SidecarSettings{
			Provider:      "anthropic",
			Model:         "sonnet",
			APIKey:        "sk-test",
			BashWhitelist: []string{"make", "go build"},
			SessionName:   "demo",
		},
		"/ws", "/cfg/agent", "/cfg/sessions", "/ext/coconut.ts", "/bin/coconut-pi",
	)
	joined := strings.Join(spec.Args, " ")
	for _, want := range []string{
		"--mode rpc", "--no-extensions", "-e /ext/coconut.ts",
		"--tools read,run,grep,find,ls,propose_edit,show_content",
		"--provider anthropic", "--model sonnet",
		"--session-dir /cfg/sessions", "--name demo",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("args missing %q: %s", want, joined)
		}
	}
	envJoined := strings.Join(spec.Env, "\n")
	for _, want := range []string{
		"PI_CODING_AGENT_DIR=/cfg/agent",
		"ANTHROPIC_API_KEY=sk-test",
		"COCONUT_BASH_WHITELIST=make,go build",
		"PI_SKIP_VERSION_CHECK=1",
	} {
		if !strings.Contains(envJoined, want) {
			t.Errorf("env missing %q", want)
		}
	}
	if spec.Dir != "/ws" || spec.Binary != "/bin/coconut-pi" {
		t.Errorf("bad spec: %+v", spec)
	}
}

func TestMergedEnvOverride(t *testing.T) {
	t.Setenv("COCONUT_TEST_KEEP", "orig")
	t.Setenv("COCONUT_TEST_SWAP", "orig")
	merged := MergedEnv([]string{"COCONUT_TEST_SWAP=new", "COCONUT_TEST_ADD=yes"})

	seen := map[string]string{}
	for _, kv := range merged {
		if i := strings.IndexByte(kv, '='); i > 0 {
			seen[kv[:i]] = kv[i+1:]
		}
	}
	if seen["COCONUT_TEST_KEEP"] != "orig" {
		t.Error("unrelated var lost")
	}
	if seen["COCONUT_TEST_SWAP"] != "new" {
		t.Error("override did not win")
	}
	if seen["COCONUT_TEST_ADD"] != "yes" {
		t.Error("addition missing")
	}
}
