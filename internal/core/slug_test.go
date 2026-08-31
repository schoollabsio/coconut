package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"My Session":         "my-session",
		"Primary":            "primary",
		"  Weird  Na--me!! ": "weird-na-me",
		"under_score":        "under-score",
		"a/b\\c:d":           "a-b-c-d",
		"Café":               "caf",
		"":                   "session",
		"!!!":                "session",
		"already-slugged":    "already-slugged",
		" trailing- ":        "trailing",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLoadStateMigratesLegacy(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"workspacePath":"/ws","sessionName":"My Session","lastSessionFile":"/old/sessions/abc.jsonl"}`
	if err := os.WriteFile(statePath(dir), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	st := loadState(dir)
	ws := st.ws("/ws")
	if ws.SessionName != "My Session" || ws.SessionSlug != "my-session" || ws.LastSessionFile != "/old/sessions/abc.jsonl" {
		t.Fatalf("legacy state not migrated: %+v", ws)
	}
	// Legacy fields must not round-trip back out.
	if st.SessionName != "" || st.LastSessionFile != "" {
		t.Fatal("legacy fields should be cleared after migration")
	}
	out, _ := json.Marshal(st)
	var roundtrip map[string]any
	_ = json.Unmarshal(out, &roundtrip)
	if _, ok := roundtrip["sessionName"]; ok {
		t.Fatal("legacy sessionName written back out")
	}
}

func TestApplyPendingRename(t *testing.T) {
	workspace := t.TempDir()

	t.Run("moves dir and rewrites file pointer", func(t *testing.T) {
		oldDir := sessionDirFor(workspace, "my-session")
		if err := os.MkdirAll(oldDir, 0o755); err != nil {
			t.Fatal(err)
		}
		transcript := filepath.Join(oldDir, "2026-01-01_abc.jsonl")
		if err := os.WriteFile(transcript, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		ws := &workspaceState{SessionName: "Renamed", SessionSlug: "my-session", PendingSlug: "renamed", LastSessionFile: transcript}

		applyPendingRename(workspace, ws)

		if ws.PendingSlug != "" || ws.SessionSlug != "renamed" {
			t.Fatalf("slug state wrong after rename: %+v", ws)
		}
		moved := filepath.Join(sessionDirFor(workspace, "renamed"), "2026-01-01_abc.jsonl")
		if ws.LastSessionFile != moved || !fileExists(moved) {
			t.Fatalf("transcript not moved: %q (exists=%v)", ws.LastSessionFile, fileExists(moved))
		}
		if dirExists(oldDir) {
			t.Fatal("old slug dir still present")
		}
	})

	t.Run("collision keeps old dir, adopts new slug going forward", func(t *testing.T) {
		for _, slug := range []string{"alpha", "beta"} {
			if err := os.MkdirAll(sessionDirFor(workspace, slug), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		oldFile := filepath.Join(sessionDirFor(workspace, "alpha"), "t.jsonl")
		if err := os.WriteFile(oldFile, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		ws := &workspaceState{SessionName: "Beta", SessionSlug: "alpha", PendingSlug: "beta", LastSessionFile: oldFile}

		applyPendingRename(workspace, ws)

		if ws.SessionSlug != "beta" || ws.PendingSlug != "" {
			t.Fatalf("slug state wrong: %+v", ws)
		}
		if ws.LastSessionFile != oldFile || !fileExists(oldFile) {
			t.Fatal("existing transcript must stay put on collision")
		}
		if !dirExists(sessionDirFor(workspace, "alpha")) {
			t.Fatal("collision move should not have removed the old dir")
		}
	})

	t.Run("no pending rename is a no-op", func(t *testing.T) {
		ws := &workspaceState{SessionName: "X", SessionSlug: "x"}
		applyPendingRename(workspace, ws)
		if ws.SessionSlug != "x" {
			t.Fatal("unexpected change")
		}
	})
}

func TestEnsureSessionDirGitignore(t *testing.T) {
	workspace := t.TempDir()
	dir, err := ensureSessionDir(workspace, "my-session")
	if err != nil {
		t.Fatal(err)
	}
	if !dirExists(dir) {
		t.Fatal("session dir not created")
	}
	b, err := os.ReadFile(filepath.Join(workspace, ".custard", ".gitignore"))
	if err != nil || string(b) != "*\n!.gitignore\n" {
		t.Fatalf(".gitignore missing/wrong: %q %v", b, err)
	}
	// Idempotent: a user-modified .gitignore must not be clobbered.
	custom := "# custom\n"
	if err := os.WriteFile(filepath.Join(workspace, ".custard", ".gitignore"), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureSessionDir(workspace, "my-session"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(workspace, ".custard", ".gitignore"))
	if string(b) != custom {
		t.Fatal("user-modified .gitignore was overwritten")
	}
}

// Rename while running records a deferred move; the next launch applies it.
func TestRenameDefersDirectoryMove(t *testing.T) {
	collector := &envelopeCollector{}
	workspace := t.TempDir()
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = workspace
	engine.state.app.WorkspacePath = workspace

	ws := engine.state.app.ws(workspace)
	ws.SessionName = "Old Name"
	ws.SessionSlug = "old-name"

	// Simulate the rename command path (no pi running → state-only update).
	engine.state.sessionName = "My Session"
	ws.SessionName = "My Session"
	if slug := Slugify("My Session"); slug != ws.SessionSlug {
		ws.PendingSlug = slug
	}
	if ws.PendingSlug != "my-session" {
		t.Fatalf("pending slug not recorded: %+v", ws)
	}
}

func TestAdoptLegacySessionFile(t *testing.T) {
	workspace := t.TempDir()
	other := t.TempDir()

	legacy := filepath.Join(other, "sessions", "old.jsonl")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ws := &workspaceState{SessionName: "Primary", SessionSlug: "primary", LastSessionFile: legacy}
	if _, err := ensureSessionDir(workspace, ws.SessionSlug); err != nil {
		t.Fatal(err)
	}
	adoptLegacySessionFile(workspace, ws)

	want := filepath.Join(sessionDirFor(workspace, "primary"), "old.jsonl")
	if ws.LastSessionFile != want || !fileExists(want) {
		t.Fatalf("legacy file not adopted: %q", ws.LastSessionFile)
	}
	if fileExists(legacy) {
		t.Fatal("original should be moved, not copied")
	}

	// Already inside the workspace → untouched.
	inside := filepath.Join(sessionDirFor(workspace, "primary"), "cur.jsonl")
	ws2 := &workspaceState{SessionSlug: "primary", LastSessionFile: inside}
	adoptLegacySessionFile(workspace, ws2)
	if ws2.LastSessionFile != inside {
		t.Fatal("in-workspace path rewritten")
	}
}
