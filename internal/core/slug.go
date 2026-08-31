package core

import (
	"os"
	"path/filepath"
	"strings"
)

// ---------------------------------------------------------------------------
// Session naming → on-disk layout
//
// Sessions are stored inside the workspace:
//
//	<workspace>/.custard/sessions/<slug>/<pi-timestamp>_<uuid>.jsonl
//
// The slug derives from the user-entered session name ("My Session" →
// "my-session"). Renames take effect on the live session immediately (via
// pi's set_session_name), but the physical directory move is DEFERRED to the
// next sidecar launch: pi caches the session file's absolute path and may
// rewrite it during compaction, so moving it mid-session could split the
// transcript across two directories.
// ---------------------------------------------------------------------------

// Slugify maps a display name to a directory-safe slug: lowercase ASCII
// alphanumerics, everything else collapses to single dashes. Empty results
// fall back to "session".
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
		return "session"
	}
	return s
}

// sessionDirFor returns the pi --session-dir for a workspace+slug.
func sessionDirFor(workspace, slug string) string {
	return filepath.Join(workspace, ".custard", "sessions", slug)
}

// ensureSessionDir creates the session dir and a .custard/.gitignore that
// keeps transcripts out of accidental commits (the ignore file itself stays
// committable).
func ensureSessionDir(workspace, slug string) (string, error) {
	dir := sessionDirFor(workspace, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	ignore := filepath.Join(workspace, ".custard", ".gitignore")
	if _, err := os.Stat(ignore); os.IsNotExist(err) {
		if err := os.WriteFile(ignore, []byte("*\n!.gitignore\n"), 0o644); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// applyPendingRename performs a deferred session-dir move at launch time
// (before pi starts, so no process holds the old path). It rewrites
// LastSessionFile to the new location. If the target dir already exists the
// move is skipped — old transcripts stay valid via their absolute path and
// new sessions simply start in the new dir.
func applyPendingRename(workspace string, ws *workspaceState) {
	if ws.PendingSlug == "" || ws.PendingSlug == ws.SessionSlug {
		ws.PendingSlug = ""
		return
	}
	oldDir := sessionDirFor(workspace, ws.SessionSlug)
	newDir := sessionDirFor(workspace, ws.PendingSlug)
	if dirExists(oldDir) && !dirExists(newDir) {
		if err := os.Rename(oldDir, newDir); err == nil {
			if ws.LastSessionFile != "" {
				ws.LastSessionFile = filepath.Join(newDir, filepath.Base(ws.LastSessionFile))
			}
		}
	}
	ws.SessionSlug = ws.PendingSlug
	ws.PendingSlug = ""
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// adoptLegacySessionFile moves a transcript that lives OUTSIDE the
// workspace (e.g. in the pre-workspace-storage global sessions dir) into the
// workspace's session dir at launch time, before pi has it open.
func adoptLegacySessionFile(workspace string, ws *workspaceState) {
	if ws.LastSessionFile == "" || !fileExists(ws.LastSessionFile) {
		return
	}
	root := filepath.Join(workspace, ".custard", "sessions") + string(filepath.Separator)
	if strings.HasPrefix(ws.LastSessionFile, root) {
		return // already inside the workspace
	}
	dst := filepath.Join(sessionDirFor(workspace, ws.SessionSlug), filepath.Base(ws.LastSessionFile))
	if fileExists(dst) {
		return // name clash: leave the original where it is
	}
	if err := os.Rename(ws.LastSessionFile, dst); err == nil {
		ws.LastSessionFile = dst
	}
}
