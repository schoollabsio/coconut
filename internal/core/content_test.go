package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jschool/coconut/internal/protocol"
)

func TestSanitizeContentName(t *testing.T) {
	cases := map[string]string{
		"report.md":      "report.md",
		"docs/report.md": "report.md", // basename only
		"../escape.md":   "escape.md", // traversal defanged
		`..\win\x.md`:    "_win_x.md", // windows separators neutralized too
		".hidden":        "hidden",    // no dotfiles
		"..":             "",
		".":              "",
		"":               "",
		"   ":            "",
		"my report.md":   "my report.md", // spaces are fine
	}
	for in, want := range cases {
		if got := sanitizeContentName(in); got != want {
			t.Errorf("sanitizeContentName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestContentEntryName(t *testing.T) {
	cases := []struct {
		path, format, want string
	}{
		{"report.md", "markdown", "report.md"},
		{"", "markdown", "content"},
		{"report", "html", "report.html"},   // suffix so re-selection derives html
		{"page.html", "html", "page.html"},   // already carries the extension
		{"page.htm", "markdown", "page.htm"}, // .htm stays (still derives html)
	}
	for _, c := range cases {
		if got := contentEntryName(c.path, c.format); got != c.want {
			t.Errorf("contentEntryName(%q, %q) = %q, want %q", c.path, c.format, got, c.want)
		}
	}
}

// bareContentEngine builds an engine without running the actor (the tested
// methods are actor-only by convention; single-threaded tests are safe).
func bareContentEngine(t *testing.T, workspace, slug string) (*Engine, *envelopeCollector) {
	t.Helper()
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = workspace
	engine.state.agentSlug = slug
	return engine, collector
}

// Mode A (path+content): persists into the library and emits both events.
func TestPromoteShowContentPersistsToLibrary(t *testing.T) {
	workspace := t.TempDir()
	engine, collector := bareContentEngine(t, workspace, "bot")

	engine.promoteShowContent(toolStartInfo{Path: "report.md", Content: "# Report", Format: "markdown"})

	data, err := os.ReadFile(filepath.Join(contentDirFor(workspace, "bot"), "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "# Report" {
		t.Fatalf("file = %q", data)
	}
	doc := engine.state.content
	if doc == nil || doc.Path != "report.md" || doc.Content != "# Report" || doc.Format != "markdown" {
		t.Fatalf("content = %+v", doc)
	}
	if len(engine.state.contentLibrary) != 1 || engine.state.contentLibrary[0].Name != "report.md" {
		t.Fatalf("library = %+v", engine.state.contentLibrary)
	}
	if _, _, ok := collector.find(t, isEvent(protocol.EvContentUpdated)); !ok {
		t.Fatal("content.updated not emitted")
	}
	if _, _, ok := collector.find(t, isEvent(protocol.EvContentLibraryChanged)); !ok {
		t.Fatal("content.library.changed not emitted")
	}
}

// Mode B (file): snapshot-copied into the library; a same-named source with
// different bytes dedupes instead of clobbering.
func TestPromoteShowContentFileSnapshot(t *testing.T) {
	workspace := t.TempDir()
	src := filepath.Join(workspace, "PLAN.md")
	if err := os.WriteFile(src, []byte("# Plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, _ := bareContentEngine(t, workspace, "bot")

	engine.promoteShowContent(toolStartInfo{File: "PLAN.md"})

	doc := engine.state.content
	if doc == nil || doc.Path != "PLAN.md" || doc.SourcePath != "PLAN.md" || doc.Content != "# Plan" {
		t.Fatalf("doc = %+v", doc)
	}
	if _, err := os.Stat(filepath.Join(contentDirFor(workspace, "bot"), "PLAN.md")); err != nil {
		t.Fatal("snapshot copy missing from the library")
	}

	// Re-showing the same unchanged file reuses the entry (no -2 suffix).
	engine.promoteShowContent(toolStartInfo{File: "PLAN.md"})
	if engine.state.content.Path != "PLAN.md" {
		t.Fatalf("identical re-show should reuse entry, got %q", engine.state.content.Path)
	}

	// A different file with the same base name dedupes.
	other := filepath.Join(workspace, "docs", "PLAN.md")
	if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("# Different"), 0o644); err != nil {
		t.Fatal(err)
	}
	engine.promoteShowContent(toolStartInfo{File: "docs/PLAN.md"})
	if engine.state.content.Path != "PLAN-2.md" {
		t.Fatalf("dedupe = %q, want PLAN-2.md", engine.state.content.Path)
	}
	if n := len(engine.scanContentLibraryLocked()); n != 2 {
		t.Fatalf("expected 2 library entries, got %d", n)
	}
}

// Scan sorts newest first and skips dotfiles/subdirs.
func TestScanContentLibrarySortedRecentFirst(t *testing.T) {
	workspace := t.TempDir()
	dir := contentDirFor(workspace, "bot")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "old.md")
	newer := filepath.Join(dir, "new.html")
	for _, p := range []string{old, newer} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".hidden"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	engine, _ := bareContentEngine(t, workspace, "bot")
	entries := engine.scanContentLibraryLocked()
	if len(entries) != 2 || entries[0].Name != "new.html" || entries[1].Name != "old.md" {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].Format != "html" || entries[1].Format != "markdown" {
		t.Fatalf("formats = %q, %q", entries[0].Format, entries[1].Format)
	}
}

// content.select displays a library entry; traversal and unknown names are
// rejected.
func TestContentSelectCommand(t *testing.T) {
	workspace := t.TempDir()
	engine, collector := newBareEngine(t, workspace, "bot")
	dir := contentDirFor(workspace, "bot")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "report.md"), []byte("# R"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := sendCommand(t, engine, protocol.CmdContentSelect, map[string]any{"name": "report.md"})
	if !resp.OK {
		t.Fatalf("select failed: %+v", resp.Error)
	}
	var doc protocol.ContentDoc
	unmarshalPayload(t, resp, &doc)
	if doc.Content != "# R" || doc.Path != "report.md" || doc.Format != "markdown" {
		t.Fatalf("doc = %+v", doc)
	}
	if _, ok := collector.waitFor(t, 2*time.Second, "content.updated", isEvent(protocol.EvContentUpdated)); !ok {
		t.Fatal("content.updated not emitted")
	}

	resp = sendCommand(t, engine, protocol.CmdContentSelect, map[string]any{"name": "../x"})
	if resp.OK {
		t.Fatal("traversal should be rejected")
	}
	resp = sendCommand(t, engine, protocol.CmdContentSelect, map[string]any{"name": "missing.md"})
	if resp.OK || resp.Error == nil || resp.Error.Code != "not_found" {
		t.Fatalf("expected not_found, got ok=%v err=%+v", resp.OK, resp.Error)
	}
}

// agent.reset semantics: the cached library clears, the files survive, and
// a rescan (what cmdAgentReset does) repopulates them.
func TestResetKeepsLibraryOnDisk(t *testing.T) {
	workspace := t.TempDir()
	engine, _ := bareContentEngine(t, workspace, "bot")
	engine.promoteShowContent(toolStartInfo{Path: "report.md", Content: "# R", Format: "markdown"})

	engine.state.resetAgent()
	if engine.state.contentLibrary != nil {
		t.Fatal("resetAgent should clear the cached library")
	}
	engine.rescanContentLibraryLocked()
	if len(engine.state.contentLibrary) != 1 || engine.state.contentLibrary[0].Name != "report.md" {
		t.Fatalf("library after reset+rescan = %+v", engine.state.contentLibrary)
	}
}

// After a session (re)build the transcript's last shown doc wins; with none,
// the library's newest entry is selected.
func TestReconcileContentSelection(t *testing.T) {
	workspace := t.TempDir()
	engine, _ := bareContentEngine(t, workspace, "bot")
	dir := contentDirFor(workspace, "bot")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "old.md")
	newest := filepath.Join(dir, "new.md")
	for name, p := range map[string]string{"# Old": old, "# New": newest} {
		if err := os.WriteFile(p, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}

	engine.rescanContentLibraryLocked()
	engine.reconcileContentSelectionLocked()
	if engine.state.content == nil || engine.state.content.Path != "new.md" || engine.state.content.Content != "# New" {
		t.Fatalf("should select newest entry, got %+v", engine.state.content)
	}

	// Restored transcript content (set by restoreContentFromArgs) wins.
	engine.state.content = &protocol.ContentDoc{Path: "from-transcript.md", Content: "x"}
	engine.reconcileContentSelectionLocked()
	if engine.state.content.Path != "from-transcript.md" {
		t.Fatalf("transcript content should win, got %+v", engine.state.content)
	}
}
