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
		"":                   "agent",
		"!!!":                "agent",
		"already-slugged":    "already-slugged",
		" trailing- ":        "trailing",
		"Frontend Agent":     "frontend-agent",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLoadStateMigratesLegacyV1(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"workspacePath":"/ws","sessionName":"My Session","lastSessionFile":"/old/sessions/abc.jsonl"}`
	if err := os.WriteFile(statePath(dir), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	st := loadState(dir)
	ws := st.ws("/ws")
	a := ws.Agents["my-session"]
	if a == nil || a.Name != "My Session" || a.LastSessionFile != "/old/sessions/abc.jsonl" {
		t.Fatalf("v1 state not migrated to agents: %+v", ws)
	}
	if ws.LastAgent != "my-session" {
		t.Fatalf("lastAgent not set: %+v", ws)
	}
	out, _ := json.Marshal(st)
	var roundtrip map[string]any
	_ = json.Unmarshal(out, &roundtrip)
	if _, ok := roundtrip["sessionName"]; ok {
		t.Fatal("legacy sessionName written back out")
	}
}

func TestLoadStateMigratesLegacyV2(t *testing.T) {
	dir := t.TempDir()
	v2 := `{"workspacePath":"/ws","workspaces":{"/ws":{"sessionName":"Renamed","sessionSlug":"old-slug","pendingSlug":"renamed","lastSessionFile":"/ws/.coconut/sessions/old-slug/x.jsonl"}}}`
	if err := os.WriteFile(statePath(dir), []byte(v2), 0o644); err != nil {
		t.Fatal(err)
	}

	st := loadState(dir)
	ws := st.ws("/ws")
	a := ws.Agents["old-slug"]
	if a == nil || a.Name != "Renamed" || a.PendingSlug != "renamed" || a.LastSessionFile == "" {
		t.Fatalf("v2 state not migrated to agents: %+v", ws.Agents)
	}
	if ws.SessionName != "" || ws.SessionSlug != "" || ws.LastAgent != "old-slug" {
		t.Fatalf("legacy v2 fields not cleared: %+v", ws)
	}
}

func TestApplyPendingRename(t *testing.T) {
	workspace := t.TempDir()

	t.Run("moves agent dir, rewrites file pointer, reports new slug", func(t *testing.T) {
		oldDir := sessionsDirFor(workspace, "old-name")
		if err := os.MkdirAll(oldDir, 0o755); err != nil {
			t.Fatal(err)
		}
		transcript := filepath.Join(oldDir, "2026-01-01_abc.jsonl")
		if err := os.WriteFile(transcript, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		a := &agentState{Name: "New Name", PendingSlug: "new-name", LastSessionFile: transcript}

		got := applyPendingRename(workspace, "old-name", a)

		if got != "new-name" || a.PendingSlug != "" {
			t.Fatalf("effective slug = %q, pending = %q", got, a.PendingSlug)
		}
		moved := filepath.Join(sessionsDirFor(workspace, "new-name"), "2026-01-01_abc.jsonl")
		if a.LastSessionFile != moved || !fileExists(moved) {
			t.Fatalf("transcript not moved: %q", a.LastSessionFile)
		}
		if dirExists(agentDirFor(workspace, "old-name")) {
			t.Fatal("old agent dir still present")
		}
	})

	t.Run("collision cancels the move, keeps old slug", func(t *testing.T) {
		for _, slug := range []string{"alpha", "beta"} {
			if err := os.MkdirAll(sessionsDirFor(workspace, slug), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		oldFile := filepath.Join(sessionsDirFor(workspace, "alpha"), "t.jsonl")
		if err := os.WriteFile(oldFile, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		a := &agentState{Name: "Beta", PendingSlug: "beta", LastSessionFile: oldFile}

		if got := applyPendingRename(workspace, "alpha", a); got != "alpha" {
			t.Fatalf("collision should keep old slug, got %q", got)
		}
		if a.LastSessionFile != oldFile || !fileExists(oldFile) {
			t.Fatal("existing transcript must stay put on collision")
		}
	})

	t.Run("nothing on disk yet adopts the new slug", func(t *testing.T) {
		a := &agentState{Name: "Fresh", PendingSlug: "fresh"}
		if got := applyPendingRename(workspace, "never-used", a); got != "fresh" {
			t.Fatalf("pre-write rename should adopt new slug, got %q", got)
		}
	})

	t.Run("no pending rename is a no-op", func(t *testing.T) {
		a := &agentState{Name: "X"}
		if got := applyPendingRename(workspace, "x", a); got != "x" {
			t.Fatalf("unexpected change: %q", got)
		}
	})
}

func TestMigrateLegacyLayout(t *testing.T) {
	workspace := t.TempDir()
	old := filepath.Join(workspace, ".coconut", "sessions", "primary")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "s.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	migrateLegacyLayout(workspace)

	moved := filepath.Join(sessionsDirFor(workspace, "primary"), "s.jsonl")
	if !fileExists(moved) {
		t.Fatal("legacy session not moved into agents layout")
	}
	if dirExists(filepath.Join(workspace, ".coconut", "sessions")) {
		t.Fatal("legacy sessions root should be removed once empty")
	}
}

func TestEnsureAgentDirGitignore(t *testing.T) {
	workspace := t.TempDir()
	dir, err := ensureAgentDir(workspace, "primary")
	if err != nil {
		t.Fatal(err)
	}
	if !dirExists(dir) || filepath.Base(filepath.Dir(dir)) != "primary" {
		t.Fatalf("sessions dir wrong: %q", dir)
	}
	b, err := os.ReadFile(filepath.Join(workspace, ".coconut", ".gitignore"))
	if err != nil || string(b) != "*\n!.gitignore\n" {
		t.Fatalf(".gitignore missing/wrong: %q %v", b, err)
	}
	custom := "# custom\n"
	if err := os.WriteFile(filepath.Join(workspace, ".coconut", ".gitignore"), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureAgentDir(workspace, "primary"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(workspace, ".coconut", ".gitignore"))
	if string(b) != custom {
		t.Fatal("user-modified .gitignore was overwritten")
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

	a := &agentState{Name: "Primary", LastSessionFile: legacy}
	if _, err := ensureAgentDir(workspace, "primary"); err != nil {
		t.Fatal(err)
	}
	adoptLegacySessionFile(workspace, "primary", a)

	want := filepath.Join(sessionsDirFor(workspace, "primary"), "old.jsonl")
	if a.LastSessionFile != want || !fileExists(want) {
		t.Fatalf("legacy file not adopted: %q", a.LastSessionFile)
	}
	if fileExists(legacy) {
		t.Fatal("original should be moved, not copied")
	}

	// Already inside the workspace → untouched.
	inside := filepath.Join(sessionsDirFor(workspace, "primary"), "cur.jsonl")
	a2 := &agentState{LastSessionFile: inside}
	adoptLegacySessionFile(workspace, "primary", a2)
	if a2.LastSessionFile != inside {
		t.Fatal("in-workspace path rewritten")
	}
}
