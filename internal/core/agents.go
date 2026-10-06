package core

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jschool/coconut/internal/protocol"
)

// ---------------------------------------------------------------------------
// Workspace scan: discover agents + their sessions under .coconut/agents/.
// Display names resolve in order: state.json → the session file's
// session_info.name → humanized slug.
// ---------------------------------------------------------------------------

// scanAgentsLocked inventories the current workspace. Actor-only (mutates
// nothing, but reads e.state).
func (e *Engine) scanAgentsLocked() []protocol.AgentSummary {
	workspace := e.state.workspacePath
	if workspace == "" {
		return nil
	}
	migrateLegacyLayout(workspace)
	ws := e.state.app.ws(workspace)

	root := filepath.Join(workspace, ".coconut", "agents")
	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}

	var out []protocol.AgentSummary
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		slug := d.Name()
		files, _ := filepath.Glob(filepath.Join(root, slug, "sessions", "*.jsonl"))

		sessions := make([]protocol.SessionSummary, 0, len(files))
		for _, f := range files {
			fi, err := os.Stat(f)
			if err != nil {
				continue
			}
			head := parseSessionHead(f)
			// pi creates a transcript on every launch and abandons it when
			// switch_session restores a previous one; hide those empties.
			if !head.hasMessages {
				continue
			}
			started := head.startedAt
			if started.IsZero() {
				started = fi.ModTime()
			}
			sessions = append(sessions, protocol.SessionSummary{
				File:       f,
				StartedAt:  started.UTC().Format(time.RFC3339),
				ModifiedAt: fi.ModTime().UTC().Format(time.RFC3339),
				SizeBytes:  fi.Size(),
				Preview:    head.preview,
			})
		}
		// Newest activity first.
		sort.Slice(sessions, func(i, j int) bool { return sessions[i].ModifiedAt > sessions[j].ModifiedAt })

		name := ""
		if a := ws.Agents[slug]; a != nil {
			name = a.Name
		}
		if name == "" && len(sessions) > 0 {
			name = parseSessionHead(sessions[0].File).name // newest file's name wins
		}
		if name == "" {
			name = humanizeSlug(slug)
		}
		current := slug == ws.LastAgent
		if current && ws.LastAgent != "" {
			if a := ws.Agents[slug]; a != nil {
				for i := range sessions {
					sessions[i].Current = sessions[i].File == a.LastSessionFile
				}
			}
		}
		out = append(out, protocol.AgentSummary{
			Slug:            slug,
			Name:            name,
			Current:         current,
			Sessions:        sessions,
			HasSystemPrompt: fileExists(systemPromptPath(workspace, slug)),
		})
	}

	// Current agent first, then by most recent activity.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Current != out[j].Current {
			return out[i].Current
		}
		return latestActivity(out[i]) > latestActivity(out[j])
	})
	return out
}

func latestActivity(a protocol.AgentSummary) string {
	if len(a.Sessions) == 0 {
		return ""
	}
	return a.Sessions[0].ModifiedAt
}

// sessionHead is the useful prefix of a pi session transcript: when it
// started, its recorded name, the first user message (as a preview), and
// whether it contains any messages at all.
type sessionHead struct {
	startedAt   time.Time
	name        string
	preview     string
	hasMessages bool
}

// sessionLine mirrors pi's session JSONL envelope (v3), fields we need only.
type sessionLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Name      string `json:"name"`
	Message   struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// parseSessionHead reads the first portion of a session JSONL for metadata.
// Best-effort: any parse trouble just yields zero values.
func parseSessionHead(path string) sessionHead {
	var head sessionHead
	f, err := os.Open(path)
	if err != nil {
		return head
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		var line sessionLine
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			continue
		}
		switch line.Type {
		case "session":
			if t, err := time.Parse(time.RFC3339, line.Timestamp); err == nil {
				head.startedAt = t
			}
		case "session_info":
			if line.Name != "" {
				head.name = line.Name
			}
		case "message":
			head.hasMessages = true
			if line.Message.Role == "user" && head.preview == "" {
				head.preview = extractPreview(line.Message.Content)
			}
		}
		if !head.startedAt.IsZero() && head.preview != "" && head.name != "" {
			break
		}
	}
	return head
}

// extractPreview pulls displayable text out of a pi message content field
// (array of parts, or a plain string), truncated for list display.
func extractPreview(raw json.RawMessage) string {
	var text string
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		for _, p := range parts {
			if p.Type == "text" && p.Text != "" {
				text = p.Text
				break
			}
		}
	} else {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			text = s
		}
	}
	text = strings.Join(strings.Fields(text), " ") // collapse whitespace/newlines
	const max = 140
	if len(text) > max {
		text = text[:max-1] + "…"
	}
	return text
}
