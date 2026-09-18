package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jschool/coconut/internal/protocol"
)

// TestAuthStatusRealHelper drives the full engine → helper → ModelRuntime
// path against the REAL coconut-login binary. Opt-in: set
//
//	COCONUT_LOGIN_HELPER=/path/to/coconut-login
//	COCONUT_TEST_AGENT_DIR=/path/to/agent   // dir holding auth.json

func TestAuthStatusRealHelper(t *testing.T) {
	helper := os.Getenv("COCONUT_LOGIN_HELPER")
	agentDir := os.Getenv("COCONUT_TEST_AGENT_DIR")
	if helper == "" || agentDir == "" {
		t.Skip("set COCONUT_LOGIN_HELPER and COCONUT_TEST_AGENT_DIR to run")
	}
	if _, err := os.Stat(helper); err != nil {
		t.Fatalf("helper binary: %v", err)
	}

	t.Setenv("COCONUT_LOGIN_HELPER", helper)

	configDir := filepath.Dir(agentDir) // engine derives <configDir>/agent
	e, err := NewEngine(EngineConfig{
		ConfigDir: configDir,
		Emit:      func(any) {},
	})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	defer func() {
		cancel()
		e.Shutdown()
	}()

	// HandleCommand blocks until the actor answers, which doubles as the
	// readiness check.
	cmd := protocol.Command{Type: "command", ID: "1", Name: protocol.CmdAuthStatus}
	b, _ := json.Marshal(cmd)
	var resp protocol.CommandResponse
	if err := json.Unmarshal(e.HandleCommand(b), &resp); err != nil {
		t.Fatalf("response parse: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("auth.status failed: %s %s", resp.Error.Code, resp.Error.Message)
	}

	var body struct {
		Providers      []protocol.AuthProviderStatus `json:"providers"`
		Credentials    []protocol.CredentialInfo     `json:"credentials"`
		ActiveProvider string                        `json:"activeProvider"`
	}
	pb, _ := json.Marshal(resp.Payload)
	if err := json.Unmarshal(pb, &body); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(body.Providers) < 30 {
		t.Fatalf("expected 30+ providers, got %d", len(body.Providers))
	}
	copilot := findProvider(t, body.Providers, "github-copilot")
	t.Logf("github-copilot: configured=%v source=%s type=%s", copilot.Configured, copilot.Source, copilot.Type)
	for _, c := range body.Credentials {
		t.Logf("credential: %s (%s)", c.ProviderID, c.Type)
	}
	// If the agent dir has a Copilot credential, it must be visible.
	if _, err := os.Stat(filepath.Join(agentDir, "auth.json")); err == nil {
		if !copilot.Configured {
			t.Errorf("auth.json exists but github-copilot reports unconfigured")
		}
	}
}

// TestAuthModelsRealHelper is the models variant of the above.
func TestAuthModelsRealHelper(t *testing.T) {
	helper := os.Getenv("COCONUT_LOGIN_HELPER")
	agentDir := os.Getenv("COCONUT_TEST_AGENT_DIR")
	if helper == "" || agentDir == "" {
		t.Skip("set COCONUT_LOGIN_HELPER and COCONUT_TEST_AGENT_DIR to run")
	}

	t.Setenv("COCONUT_LOGIN_HELPER", helper)

	configDir := filepath.Dir(agentDir)
	e, err := NewEngine(EngineConfig{ConfigDir: configDir, Emit: func(any) {}})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	defer func() {
		cancel()
		e.Shutdown()
	}()
	cmd := protocol.Command{
		Type:    "command",
		ID:      "2",
		Name:    protocol.CmdAuthModels,
		Payload: json.RawMessage(`{"provider":"github-copilot"}`),
	}
	b, _ := json.Marshal(cmd)
	var resp protocol.CommandResponse
	if err := json.Unmarshal(e.HandleCommand(b), &resp); err != nil {
		t.Fatalf("response parse: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("auth.models failed: %s %s", resp.Error.Code, resp.Error.Message)
	}
	var body struct {
		Models []protocol.AuthModel `json:"models"`
	}
	pb, _ := json.Marshal(resp.Payload)
	if err := json.Unmarshal(pb, &body); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(body.Models) == 0 {
		t.Fatalf("expected models, got none")
	}
	for _, m := range body.Models[:5] {
		t.Logf("model: %s (%s) ctx=%d", m.ID, m.Provider, m.ContextWindow)
	}
}

// TestAuthLoginFlowRealHelper drives the full engine → helper login
// pipeline against the REAL coconut-login binary: the step/prompt events
// must be keyed by the command's loginId (not the helper's internal id),
// and a cancel carrying that loginId must actually abort the in-flight
// login. Regression: the helper request id and the frontend loginId used
// to live in two different id spaces, so every event was silently dropped
// and cancel was a no-op (the "waiting for provider" hang).
//
//	COCONUT_LOGIN_HELPER=/path/to/coconut-login
func TestAuthLoginFlowRealHelper(t *testing.T) {
	helper := os.Getenv("COCONUT_LOGIN_HELPER")
	if helper == "" {
		t.Skip("set COCONUT_LOGIN_HELPER to run")
	}
	if _, err := os.Stat(helper); err != nil {
		t.Fatalf("helper binary: %v", err)
	}
	t.Setenv("COCONUT_LOGIN_HELPER", helper)

	// Fresh agent dir: no stored credential, so the OAuth flow really runs.
	configDir := t.TempDir()

	events := make(chan protocol.Event, 128)
	e, err := NewEngine(EngineConfig{
		ConfigDir: configDir,
		Emit:      func(env any) { events <- env.(protocol.Event) },
	})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	defer func() {
		cancel()
		e.Shutdown()
	}()

	loginID := "login-test-1"
	cmd := protocol.Command{
		Type:    "command",
		ID:      loginID,
		Name:    protocol.CmdAuthLogin,
		Payload: json.RawMessage(`{"provider":"github-copilot","authType":"oauth"}`),
	}
	b, _ := json.Marshal(cmd)
	var resp protocol.CommandResponse
	if err := json.Unmarshal(e.HandleCommand(b), &resp); err != nil {
		t.Fatalf("response parse: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("auth.login failed: %s %s", resp.Error.Code, resp.Error.Message)
	}

	// Wait for the prompt event (the user-input gate). Every auth event in
	// between must be keyed by OUR loginId.
	deadline := time.Now().Add(60 * time.Second)
	for {
		select {
		case ev := <-events:
			t.Logf("event: %s", ev.Name)
			if !strings.HasPrefix(ev.Name, "auth.login") {
				continue
			}
			var pl struct {
				LoginID  string `json:"loginId"`
				PromptID string `json:"promptId"`
			}
			pb, _ := json.Marshal(ev.Payload)
			_ = json.Unmarshal(pb, &pl)
			if pl.LoginID != loginID {
				t.Fatalf("event %s keyed by %q, want %q (id-space mismatch)", ev.Name, pl.LoginID, loginID)
			}
			switch ev.Name {
			case protocol.EvAuthLoginPrompt:
				if pl.PromptID == "" {
					t.Fatal("prompt event without promptId")
				}
				goto cancelled
			case protocol.EvAuthLoginFailed, protocol.EvAuthLoginCancelled:
				t.Fatalf("login ended early: %s", ev.Name)
			}
		case <-time.After(time.Until(deadline)):
			t.Fatal("timed out waiting for the login prompt")
		}
	}

cancelled:
	// Cancel with the FRONTEND loginId — must abort the in-flight login.
	c := protocol.Command{
		Type:    "command",
		ID:      "cancel-1",
		Name:    protocol.CmdAuthLoginCancel,
		Payload: json.RawMessage(`{"loginId":"` + loginID + `"}`),
	}
	cb, _ := json.Marshal(c)
	var cres protocol.CommandResponse
	if err := json.Unmarshal(e.HandleCommand(cb), &cres); err != nil {
		t.Fatalf("cancel response parse: %v", err)
	}
	if cres.Error != nil {
		t.Fatalf("auth.login.cancel failed: %s %s", cres.Error.Code, cres.Error.Message)
	}

	// Terminal cancelled event, keyed by the same loginId.
	deadline = time.Now().Add(20 * time.Second)
	for {
		select {
		case ev := <-events:
			t.Logf("event: %s", ev.Name)
			if ev.Name != protocol.EvAuthLoginCancelled {
				continue
			}
			var pl struct{ LoginID string `json:"loginId"` }
			pb, _ := json.Marshal(ev.Payload)
			if err := json.Unmarshal(pb, &pl); err != nil || pl.LoginID != loginID {
				t.Fatalf("cancelled keyed by %q, want %q", pl.LoginID, loginID)
			}
			return
		case <-time.After(time.Until(deadline)):
			t.Fatal("no cancelled event after cancel (cancel is a no-op?)")
		}
	}
}

func findProvider(t *testing.T, providers []protocol.AuthProviderStatus, id string) protocol.AuthProviderStatus {
	t.Helper()
	for _, p := range providers {
		if strings.EqualFold(p.ID, id) {
			return p
		}
	}
	t.Fatalf("provider %s not found", id)
	return protocol.AuthProviderStatus{}
}
