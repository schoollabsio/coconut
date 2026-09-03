package core

import (
	"os"
	"path/filepath"
	"strings"
)

// ---------------------------------------------------------------------------
// Agent naming → on-disk layout
//
// Agents are persistent, workspace-scoped identities; each owns a run of pi
// sessions:
//
//	<workspace>/.coconut/agents/<agent-slug>/sessions/<pi-timestamp>_<uuid>.jsonl
//
// The slug derives from the user-entered agent name ("Frontend Agent" →
// "frontend-agent"). Renames update the live session immediately (via pi's
// set_session_name), but the physical directory move is DEFERRED to the next
// sidecar launch: pi caches the session file's absolute path and may rewrite
// it during compaction, so moving it mid-session could split the transcript.
// ---------------------------------------------------------------------------

// Slugify maps a display name to a directory-safe slug: lowercase ASCII
// alphanumerics, everything else collapses to single dashes. Empty results
// fall back to "agent".
func Slugify(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	lastDash := true // suppresses leading dashes
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteByte('-')
			lastDash = true
		}
	}
	s := strings.TrimSuffix(b.String(), "-")
	if s == "" {
		return "agent"
	}
	return s
}

// humanizeSlug renders a slug as a display name ("frontend-agent" →
// "Frontend Agent") for agents discovered on disk with no recorded name.
func humanizeSlug(slug string) string {
	parts := strings.Split(slug, "-")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// agentDirFor returns the agent's root dir; sessionsDirFor its --session-dir.
func agentDirFor(workspace, slug string) string {
	return filepath.Join(workspace, ".coconut", "agents", slug)
}

func sessionsDirFor(workspace, slug string) string {
	return filepath.Join(agentDirFor(workspace, slug), "sessions")
}

// ensureAgentDir creates the agent's sessions dir and a .coconut/.gitignore
// that keeps transcripts out of accidental commits (the ignore file itself
// stays committable).
func ensureAgentDir(workspace, slug string) (string, error) {
	dir := sessionsDirFor(workspace, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	ignore := filepath.Join(workspace, ".coconut", ".gitignore")
	if _, err := os.Stat(ignore); os.IsNotExist(err) {
		if err := os.WriteFile(ignore, []byte("*\n!.gitignore\n"), 0o644); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// applyPendingRename performs a deferred agent-dir move at launch time
// (before pi starts, so no process holds the old path) and returns the
// agent's effective slug — the caller re-keys its map entry when it changes.
// LastSessionFile is rewritten to the new location. If the target dir
// already exists (another agent owns that slug) the move is cancelled: the
// display name still changes, but the directory stays put.
func applyPendingRename(workspace, slug string, a *agentState) string {
	if a.PendingSlug == "" || a.PendingSlug == slug {
		a.PendingSlug = ""
		return slug
	}
	newSlug := a.PendingSlug
	a.PendingSlug = ""
	oldDir := agentDirFor(workspace, slug)
	newDir := agentDirFor(workspace, newSlug)
	switch {
	case !dirExists(oldDir) && !dirExists(newDir):
		return newSlug // renamed before anything was written
	case dirExists(oldDir) && !dirExists(newDir):
		if err := os.Rename(oldDir, newDir); err == nil {
			if a.LastSessionFile != "" {
				a.LastSessionFile = filepath.Join(newDir, "sessions", filepath.Base(a.LastSessionFile))
			}
			return newSlug
		}
	}
	return slug // collision or failed move: keep the old directory
}

// adoptLegacySessionFile moves a transcript that lives OUTSIDE the
// workspace's .coconut/agents tree (e.g. in the pre-workspace-storage global
// sessions dir) into the agent's sessions dir at launch time, before pi has
// it open.
func adoptLegacySessionFile(workspace, slug string, a *agentState) {
	if a.LastSessionFile == "" || !fileExists(a.LastSessionFile) {
		return
	}
	root := filepath.Join(workspace, ".coconut", "agents") + string(filepath.Separator)
	if strings.HasPrefix(a.LastSessionFile, root) {
		return // already inside the workspace
	}
	dst := filepath.Join(sessionsDirFor(workspace, slug), filepath.Base(a.LastSessionFile))
	if fileExists(dst) {
		return // name clash: leave the original where it is
	}
	if err := os.Rename(a.LastSessionFile, dst); err == nil {
		a.LastSessionFile = dst
	}
}

// migrateLegacyLayout upgrades the pre-agents layout
// (.coconut/sessions/<slug>/*.jsonl) to .coconut/agents/<slug>/sessions/.
// Idempotent; collisions leave the legacy dir untouched.
func migrateLegacyLayout(workspace string) {
	legacyRoot := filepath.Join(workspace, ".coconut", "sessions")
	entries, err := os.ReadDir(legacyRoot)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		src := filepath.Join(legacyRoot, e.Name())
		dst := sessionsDirFor(workspace, e.Name())
		if dirExists(dst) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		_ = os.Rename(src, dst)
	}
	// Remove the legacy root if fully migrated.
	if rest, err := os.ReadDir(legacyRoot); err == nil && len(rest) == 0 {
		_ = os.Remove(legacyRoot)
	}
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
