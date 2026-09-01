package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jschool/custard/internal/protocol"
)

// TestRealPiApprovalProbe drives the REAL bundled pi sidecar end-to-end:
// prompt → propose_edit tool call → extension_ui_request → bridged
// approval → approve → file modified. This is the round trip the GUI
// depends on; fakepi cannot catch extension/RPC drift in real pi.
//
// Gated: CUSTARD_TEST_REAL_PI=1. Provider credentials come from the
// user's real custard settings.yaml (copied into an isolated temp config
// dir — their app state is never touched).
func TestRealPiApprovalProbe(t *testing.T) {
	if os.Getenv("CUSTARD_TEST_REAL_PI") != "1" {
		t.Skip("set CUSTARD_TEST_REAL_PI=1 to run the real-pi probe")
	}
	if testing.Short() {
		t.Skip("integration test")
	}

	// Repo root → bundled sidecar + extension.
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	sidecar := filepath.Join(root, "build", "sidecar", "custard-pi")
	if _, err := os.Stat(sidecar); err != nil {
		t.Skipf("bundled sidecar not found at %s (run scripts/build-sidecar.sh)", sidecar)
	}
	t.Setenv("CUSTARD_PI_BINARY", sidecar)
	t.Setenv("CUSTARD_PI_SCENARIO", "")

	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "README.md"), []byte("# Before\nhello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Copy the user's custard settings (provider/endpoint/key) into an
	// isolated config dir so the probe neither mutates their app state nor
	// needs env credentials.
	home, _ := os.UserHomeDir()
	srcSettings := filepath.Join(home, "Library", "Application Support", "custard", "settings.yaml")
	yamlBytes, err := os.ReadFile(srcSettings)
	if err != nil {
		t.Skipf("no custard settings.yaml at %s", srcSettings)
	}
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "settings.yaml"), yamlBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{
		ConfigDir:     configDir,
		ExtensionPath: filepath.Join(root, "pi-extension", "custard.ts"),
		Emit:          collector.emit,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	go engine.Run(ctx)

	if resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace}); !resp.OK {
		t.Fatalf("workspace.set: %s", respBytes(resp))
	}

	// pi reads stdin commands as it boots, so we can prompt immediately;
	// the approval wait below covers sidecar init time.

	prompt := "Your ONLY allowed edit tool is propose_edit — bash is disabled for edits. Call the propose_edit tool exactly once now to replace the entire contents of README.md with '# After'. Do not ask questions, do not use bash, do not write prose — just make the propose_edit tool call."
	if resp := sendCommand(t, engine, protocol.CmdAgentStart, map[string]any{"prompt": prompt}); !resp.OK {
		t.Fatalf("agent.start: %s", respBytes(resp))
	}

	// THE ASSERTION THE BUG REPORT IS ABOUT: an approval request must appear.
	raw, ok := collector.waitFor(t, 120*time.Second, "approval.requested", isEvent(protocol.EvApprovalRequested))
	if !ok {
		dumpCollected(t, collector)
		t.Fatal("no approval.requested event from real pi round trip")
	}
	var approval protocol.ApprovalRequest
	if err := json.Unmarshal(raw, &approval); err != nil {
		t.Fatalf("approval payload: %v", err)
	}
	t.Logf("approval: kind=%s title=%q path=%s diffBytes=%d", approval.Kind, approval.Title, approval.Path, len(approval.Diff))
	if approval.Kind != protocol.ApprovalKindProposeEdit {
		dumpCollected(t, collector)
		t.Fatalf("expected propose_edit approval, got %q", approval.Kind)
	}

	// Approve → the file must actually change.
	if resp := sendCommand(t, engine, protocol.CmdApprovalRespond, map[string]any{"approvalId": approval.ID, "decision": "allow"}); !resp.OK {
		t.Fatalf("approval.respond: %s", respBytes(resp))
	}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(filepath.Join(workspace, "README.md"))
		if strings.Contains(string(data), "# After") {
			return // success
		}
		time.Sleep(250 * time.Millisecond)
	}
	dumpCollected(t, collector)
	t.Fatal("file was not modified after approval")
}

func respBytes(resp protocol.CommandResponse) string {
	b, _ := json.Marshal(resp)
	return string(b)
}

// dumpCollected prints the event stream tail for post-mortem debugging.
func dumpCollected(t *testing.T, c *envelopeCollector) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	start := 0
	if len(c.envs) > 40 {
		start = len(c.envs) - 40
	}
	for _, raw := range c.envs[start:] {
		s := string(raw)
		if len(s) > 300 {
			s = s[:300] + "…"
		}
		t.Log(s)
	}
}
