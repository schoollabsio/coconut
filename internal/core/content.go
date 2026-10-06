package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jschool/coconut/internal/protocol"
)

// ---------------------------------------------------------------------------
// Content library
//
// Every show_content document is persisted under the agent's directory:
//
//	<workspace>/.coconut/agents/<slug>/content/<name>
//
// The directory IS the index: an entry's id is its file name and the sort
// order is mtime descending, so re-showing a document under the same name
// overwrites it and floats it to the top. The library is per-agent, not
// per-session — every session of an agent sees the same entries.
// ---------------------------------------------------------------------------

func contentDirFor(workspace, slug string) string {
	return filepath.Join(agentDirFor(workspace, slug), "content")
}

// sanitizeContentName reduces an agent-supplied path to a safe flat file
// name inside the content dir: basename only, stray separators and NULs
// mapped to underscores, no dotfiles. "" when nothing usable remains.
func sanitizeContentName(p string) string {
	base := filepath.Base(strings.TrimSpace(p))
	base = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == 0 {
			return '_'
		}
		return r
	}, base)
	base = strings.TrimLeft(base, ".") // no dotfiles; also defangs ".."
	if base == "" {
		return ""
	}
	return base
}

// contentEntryName resolves the library file name for a show_content call:
// the sanitized agent-chosen name ("content" when empty), with an .html
// suffix when the doc is HTML but the name doesn't say so — an entry's
// display format derives from its extension on later selections.
func contentEntryName(path, format string) string {
	name := sanitizeContentName(path)
	if name == "" {
		name = "content"
	}
	if format == "html" {
		if l := strings.ToLower(name); !strings.HasSuffix(l, ".html") && !strings.HasSuffix(l, ".htm") {
			name += ".html"
		}
	}
	return name
}

// contentFormatForName derives the display format from a library file name.
func contentFormatForName(name string) string {
	l := strings.ToLower(name)
	if strings.HasSuffix(l, ".html") || strings.HasSuffix(l, ".htm") {
		return "html"
	}
	return "markdown"
}

// scanContentLibraryLocked inventories the agent's content dir, newest
// first. Missing dir → nil. Actor-only.
func (e *Engine) scanContentLibraryLocked() []protocol.ContentEntry {
	if e.state.workspacePath == "" || e.state.agentSlug == "" {
		return nil
	}
	entries, err := os.ReadDir(contentDirFor(e.state.workspacePath, e.state.agentSlug))
	if err != nil {
		return nil
	}
	out := make([]protocol.ContentEntry, 0, len(entries))
	for _, ent := range entries {
		if ent.IsDir() || strings.HasPrefix(ent.Name(), ".") {
			continue
		}
		fi, err := ent.Info()
		if err != nil {
			continue
		}
		out = append(out, protocol.ContentEntry{
			Name:      ent.Name(),
			Format:    contentFormatForName(ent.Name()),
			SizeBytes: fi.Size(),
			UpdatedAt: fi.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// rescanContentLibraryLocked refreshes state.contentLibrary from disk and
// emits content.library.changed. Actor-only.
func (e *Engine) rescanContentLibraryLocked() {
	e.state.contentLibrary = e.scanContentLibraryLocked()
	e.emitEvent(protocol.EvContentLibraryChanged, protocol.ContentLibraryPayload{Entries: e.state.contentLibrary}, "")
}

// persistContentLocked writes one library entry atomically (PID-tmp +
// rename; multiple windows share the dir). Name is identity: an existing
// entry of the same name is overwritten, which also floats it to the top
// of the mtime-sorted list. Best-effort: failures notify but never block
// display. Actor-only.
func (e *Engine) persistContentLocked(name, content string) {
	dir := contentDirFor(e.state.workspacePath, e.state.agentSlug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		e.notify("error", "content library: "+err.Error())
		return
	}
	path := filepath.Join(dir, name)
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		e.notify("error", "content library: "+err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		e.notify("error", "content library: "+err.Error())
	}
}

// dedupeContentName picks a free name for a Mode B snapshot copy: the name
// itself when free (or holding identical bytes — re-showing the same file
// just bumps mtime), otherwise stem-2.ext, stem-3.ext, …
func dedupeContentName(dir, name string, data []byte) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for candidate, i := name, 2; ; i++ {
		existing, err := os.ReadFile(filepath.Join(dir, candidate))
		switch {
		case errors.Is(err, os.ErrNotExist):
			return candidate
		case err == nil && bytes.Equal(existing, data):
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
}

// loadContentEntryLocked reads a library entry into state.content. Returns
// false when missing/unreadable/oversize. Actor-only; emits nothing —
// callers decide between a snapshot (session restore) and content.updated
// (interactive select).
func (e *Engine) loadContentEntryLocked(name string) bool {
	path := filepath.Join(contentDirFor(e.state.workspacePath, e.state.agentSlug), name)
	data, err := os.ReadFile(path)
	if err != nil || len(data) > showContentMaxBytes {
		return false
	}
	doc := &protocol.ContentDoc{Path: name, Content: string(data), Format: contentFormatForName(name), UpdatedAt: nowMs()}
	if fi, err := os.Stat(path); err == nil {
		doc.UpdatedAt = fi.ModTime().UnixMilli()
	}
	e.state.content = doc
	return true
}

// reconcileContentSelectionLocked picks the panel content after a session
// (re)build: the transcript's last show_content (already restored from args
// by rebuildToolCallsLocked) wins; otherwise the library's newest entry.
// Actor-only; the result reaches the frontend via the snapshot.
func (e *Engine) reconcileContentSelectionLocked() {
	if e.state.content != nil || len(e.state.contentLibrary) == 0 {
		return
	}
	e.loadContentEntryLocked(e.state.contentLibrary[0].Name)
}

// cmdContentSelect displays a library entry in the content panel.
func (e *Engine) cmdContentSelect(cmd protocol.Command, respond chan []byte) {
	var p protocol.ContentSelectPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Name == "" || sanitizeContentName(p.Name) != p.Name {
		respond <- respondErr(cmd, "bad_payload", "content.select needs a valid {name}")
		return
	}
	if e.state.workspacePath == "" || e.state.agentSlug == "" {
		respond <- respondErr(cmd, "no_workspace", "pick a workspace first")
		return
	}
	if !e.loadContentEntryLocked(p.Name) {
		respond <- respondErr(cmd, "not_found", "no readable content entry "+p.Name)
		return
	}
	e.emitEvent(protocol.EvContentUpdated, e.state.content, cmd.ID)
	respond <- respondOK(cmd, e.state.content)
}
