package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jschool/coconut/internal/protocol"
	"gopkg.in/yaml.v3"
)

// ConfigDir resolves the app config directory. COCONUT_CONFIG_DIR
// overrides (dev/tests); otherwise os.UserConfigDir()/coconut.
func ConfigDir() (string, error) {
	if dir := os.Getenv("COCONUT_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "coconut"), nil
}

// DefaultBashWhitelist mirrors the extension's read-only defaults; the
// default settings template includes these as the baseline.
var DefaultBashWhitelist = []string{
	"ls", "grep", "find", "cat", "head", "tail", "pwd", "wc",
	"file", "stat", "which", "echo",
	"git status", "git diff", "git log", "git show", "git branch",
}

// ---------------------------------------------------------------------------
// settings.yaml — user-editable configuration (validated)
// ---------------------------------------------------------------------------

// Settings is the parsed shape of settings.yaml. Provider endpoint
// configuration (baseUrl, headers, api, apiKey, authHeader, models) is
// translated into pi's models.json for the isolated sidecar config dir; a
// top-level APIKey for a built-in provider is injected via env instead.
type Settings struct {
	Provider      string                      `yaml:"provider"`
	Model         string                      `yaml:"model,omitempty"`
	APIKey        string                      `yaml:"apiKey,omitempty"`
	BashWhitelist []string                    `yaml:"bashWhitelist"`
	Providers     map[string]ProviderSettings `yaml:"providers,omitempty"`
}

// ProviderSettings maps onto a pi models.json provider entry. Unknown keys
// are captured in Extra and passed through to models.json untouched, so
// advanced pi fields (oauth, compat, modelOverrides, …) stay available.
type ProviderSettings struct {
	Name       string            `yaml:"name,omitempty"`
	BaseURL    string            `yaml:"baseUrl,omitempty"`
	API        string            `yaml:"api,omitempty"`
	APIKey     string            `yaml:"apiKey,omitempty"`
	AuthHeader *bool             `yaml:"authHeader,omitempty"`
	Headers    map[string]string `yaml:"headers,omitempty"`
	Models     []map[string]any  `yaml:"models,omitempty"`
	Extra      map[string]any    `yaml:",inline"`
}

// knownAPIs mirrors pi-ai's KnownApi type. Validated strictly because
// coconut launches pi with --no-extensions, so only built-in APIs can work.
var knownAPIs = map[string]bool{
	"openai-completions":      true,
	"openai-responses":        true,
	"azure-openai-responses":  true,
	"openai-codex-responses":  true,
	"anthropic-messages":      true,
	"mistral-conversations":   true,
	"bedrock-converse-stream": true,
	"google-generative-ai":    true,
	"google-vertex":           true,
	"pi-messages":             true,
}

func knownAPIList() []string {
	out := make([]string, 0, len(knownAPIs))
	for a := range knownAPIs {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// knownProviderEnv maps pi's built-in provider ids to the env vars pi
// checks for credentials (mirrors pi-ai's env-api-keys). The LAST entry is
// the canonical API-key variable. A nil slice means the provider uses
// ambient credentials (e.g. AWS).
var knownProviderEnv = map[string][]string{
	"anthropic":                  {"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"},
	"github-copilot":             {"COPILOT_GITHUB_TOKEN"},
	"openai":                     {"OPENAI_API_KEY"},
	"azure-openai-responses":     {"AZURE_OPENAI_API_KEY"},
	"openai-codex":               {"OPENAI_CODEX_API_KEY"},
	"google":                     {"GEMINI_API_KEY"},
	"google-vertex":              {"GOOGLE_CLOUD_API_KEY"},
	"groq":                       {"GROQ_API_KEY"},
	"cerebras":                   {"CEREBRAS_API_KEY"},
	"xai":                        {"XAI_API_KEY"},
	"deepseek":                   {"DEEPSEEK_API_KEY"},
	"nvidia":                     {"NVIDIA_API_KEY"},
	"openrouter":                 {"OPENROUTER_API_KEY"},
	"mistral":                    {"MISTRAL_API_KEY"},
	"huggingface":                {"HF_TOKEN"},
	"fireworks":                  {"FIREWORKS_API_KEY"},
	"together":                   {"TOGETHER_API_KEY"},
	"baseten":                    {"BASETEN_API_KEY"},
	"opencode":                   {"OPENCODE_API_KEY"},
	"opencode-go":                {"OPENCODE_API_KEY"},
	"kimi-coding":                {"KIMI_API_KEY"},
	"zai":                        {"ZAI_API_KEY"},
	"zai-coding-cn":              {"ZAI_CODING_CN_API_KEY"},
	"minimax":                    {"MINIMAX_API_KEY"},
	"minimax-cn":                 {"MINIMAX_CN_API_KEY"},
	"moonshotai":                 {"MOONSHOT_API_KEY"},
	"moonshotai-cn":              {"MOONSHOT_API_KEY"},
	"radius":                     {"RADIUS_API_KEY"},
	"vercel-ai-gateway":          {"AI_GATEWAY_API_KEY"},
	"ant-ling":                   {"ANT_LING_API_KEY"},
	"cloudflare-workers-ai":      {"CLOUDFLARE_API_KEY"},
	"cloudflare-ai-gateway":      {"CLOUDFLARE_API_KEY"},
	"qwen-token-plan":            {"QWEN_TOKEN_PLAN_API_KEY"},
	"qwen-token-plan-cn":         {"QWEN_TOKEN_PLAN_CN_API_KEY"},
	"qwen-token-plan-individual": {"QWEN_TOKEN_PLAN_API_KEY"},
	"xiaomi":                     {"XIAOMI_API_KEY"},
	"xiaomi-token-plan-cn":       {"XIAOMI_TOKEN_PLAN_CN_API_KEY"},
	"xiaomi-token-plan-ams":      {"XIAOMI_TOKEN_PLAN_AMS_API_KEY"},
	"xiaomi-token-plan-sgp":      {"XIAOMI_TOKEN_PLAN_SGP_API_KEY"},
	"amazon-bedrock":             nil, // ambient AWS credentials
}

func isKnownProvider(id string) bool {
	_, ok := knownProviderEnv[id]
	return ok
}

// Validate checks semantic correctness beyond YAML syntax. Errors block
// saving; warnings are shown but do not block. env is the environment
// lookup for credential checks (os.LookupEnv in prod).
func (s *Settings) Validate(env func(string) (string, bool)) []protocol.ConfigProblem {
	var out []protocol.ConfigProblem
	prob := func(sev, format string, args ...any) {
		out = append(out, protocol.ConfigProblem{Severity: sev, Message: fmt.Sprintf(format, args...)})
	}

	s.Provider = strings.TrimSpace(s.Provider)
	if s.Provider == "" {
		prob("error", "provider: required (a built-in like anthropic/openai, or a name defined under providers:)")
	} else if !isKnownProvider(s.Provider) {
		if _, defined := s.Providers[s.Provider]; !defined {
			prob("error", "provider %q: not a built-in pi provider and not defined under providers:", s.Provider)
		}
	}

	if s.Model != "" {
		if strings.ContainsAny(s.Model, "\n\r") {
			prob("error", "model: must be a single-line pattern")
		} else if i := strings.Index(s.Model, "/"); i > 0 && s.Provider != "openrouter" {
			// OpenRouter model IDs conventionally include their upstream vendor,
			// e.g. "qwen/qwen3.8-max". With OpenRouter selected, that slash
			// belongs to the raw model ID rather than denoting a pi provider/model
			// reference. Pi resolves these IDs against OpenRouter's catalog.
			if prefix := s.Model[:i]; !isKnownProvider(prefix) {
				if _, defined := s.Providers[prefix]; !defined {
					prob("error", "model %q: unknown provider prefix %q", s.Model, prefix)
				}
			}
		}
	}

	for i, w := range s.BashWhitelist {
		if strings.TrimSpace(w) == "" {
			prob("error", "bashWhitelist[%d]: empty entry", i)
		}
	}

	ids := make([]string, 0, len(s.Providers))
	for id := range s.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := s.Providers[id]
		custom := !isKnownProvider(id)

		if p.BaseURL != "" {
			u, err := url.Parse(p.BaseURL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				prob("error", "providers.%s.baseUrl: %q is not a valid http(s) URL", id, p.BaseURL)
			}
		}
		if p.API != "" && !knownAPIs[p.API] {
			prob("error", "providers.%s.api: %q is not a pi api (valid: %s)", id, p.API, strings.Join(knownAPIList(), ", "))
		}
		for k := range p.Headers {
			if strings.TrimSpace(k) == "" {
				prob("error", "providers.%s.headers: empty header name", id)
			}
		}
		for i, m := range p.Models {
			mid, ok := m["id"].(string)
			if !ok || strings.TrimSpace(mid) == "" {
				prob("error", "providers.%s.models[%d]: missing model id", id, i)
			}
		}
		if custom {
			if p.BaseURL == "" {
				prob("error", "providers.%s: baseUrl is required for a custom provider", id)
			}
			if p.API == "" {
				prob("error", "providers.%s: api is required for a custom provider (e.g. openai-completions)", id)
			}
			if len(p.Models) == 0 {
				prob("error", "providers.%s: custom providers need at least one models: entry (e.g. - id: my-model)", id)
			}
		}
		for k := range p.Extra {
			prob("warning", "providers.%s: unknown key %q (passed through to models.json)", id, k)
		}
	}

	// Credential visibility check (warning only — a proxy may need no key,
	// and OAuth/ambient setups are beyond our inspection).
	if s.Provider != "" {
		if p, overridden := s.Providers[s.Provider]; overridden {
			if p.APIKey == "" && s.APIKey == "" {
				prob("warning", "provider %q: no apiKey configured (fine if the endpoint needs no auth)", s.Provider)
			}
		} else if s.APIKey == "" {
			if names, known := knownProviderEnv[s.Provider]; known {
				if names == nil {
					prob("warning", "provider %q uses ambient cloud credentials; make sure they exist in your shell", s.Provider)
				} else {
					found := false
					for _, n := range names {
						if v, ok := env(n); ok && v != "" {
							found = true
							break
						}
					}
					if !found {
						prob("warning", "provider %q: no credential configured — sign in via Settings → Provider, or export %s", s.Provider, names[len(names)-1])
					}
				}
			}
		}
	}

	// Deprecation: a top-level apiKey for a BUILT-IN provider should live in
	// pi's credential store (auth.json), not this file. It still works (env
	// injection), and settings.save migrates it — this warning explains the
	// change. Custom providers keep their key in the providers: entry.
	if s.APIKey != "" && s.Provider != "" && isKnownProvider(s.Provider) {
		prob("warning", "apiKey for built-in provider %q is deprecated — the key will be moved to the credential store (auth.json); you can then remove apiKey: from this file", s.Provider)
	}
	return out
}

// parseSettingsYAML decodes strictly: unknown top-level keys are rejected;
// unknown provider-entry keys land in Extra (passed through to pi).
func parseSettingsYAML(text string) (Settings, []protocol.ConfigProblem) {
	var s Settings
	dec := yaml.NewDecoder(bytes.NewReader([]byte(text)))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		msg := strings.TrimPrefix(err.Error(), "yaml: ")
		return Settings{}, []protocol.ConfigProblem{{Severity: "error", Message: "invalid config: " + msg}}
	}
	return s, s.Validate(os.LookupEnv)
}

// HasErrors reports whether any problem blocks saving.
func HasErrors(ps []protocol.ConfigProblem) bool {
	for _, p := range ps {
		if p.Severity == "error" {
			return true
		}
	}
	return false
}

// DefaultSettingsYAML is written to settings.yaml on first run; its
// comments double as the config documentation shown in the settings modal.
var DefaultSettingsYAML = `# coconut settings

# Provider: a built-in pi provider (anthropic, openai, google, groq, mistral,
# xai, openrouter, deepseek, github-copilot, ...) or a name you define under
# "providers:" below.
provider: anthropic

# Model pattern (optional): bare id, provider/model, or provider/model:thinking.
# model: claude-sonnet-4-5

# DEPRECATED for built-in providers: sign in via Settings → Provider instead
# (credentials are stored in pi's credential store, auth.json — not here).
# Built-in providers can also read their usual env var (e.g.
# ANTHROPIC_API_KEY), which the sidecar inherits from your shell.
# Custom providers defined under providers: keep using their apiKey: entry.
apiKey: ""

# Custom endpoints and headers. Entries are written to pi's models.json;
# they can define new providers or override a built-in's endpoint.
# providers:
#   openrouter:
#     baseUrl: https://openrouter.ai/api/v1
#     api: openai-completions        # protocol the endpoint speaks
#     apiKey: sk-or-...              # literal key (stored in models.json)
#     authHeader: true               # send "Authorization: Bearer <apiKey>"
#     headers:
#       HTTP-Referer: https://example.com
#     models:
#       - id: anthropic/claude-sonnet-4
#       - id: openai/gpt-5
#         contextWindow: 200000
#
#   # Override a built-in's endpoint (e.g. a corporate proxy):
#   anthropic:
#     baseUrl: https://proxy.internal/anthropic
#     headers:
#       X-Tenant: blue

# Bash command prefixes the agent may run without approval.
bashWhitelist:
  - ls
  - cat
  - git status
  - git diff
  - git log
  - grep
  - find
  - head
  - tail
  - wc
`

func settingsPath(configDir string) string { return filepath.Join(configDir, "settings.yaml") }

// loadSettingsYAML loads settings.yaml, creating it from the template when
// missing. Returns the parsed config and the raw text (the settings modal
// edits raw text so user comments survive). An invalid on-disk config falls
// back to template defaults in memory while preserving the raw text.
func loadSettingsYAML(configDir string) (Settings, string) {
	data, err := os.ReadFile(settingsPath(configDir))
	if errors.Is(err, os.ErrNotExist) {
		data = []byte(DefaultSettingsYAML)
		_ = os.WriteFile(settingsPath(configDir), data, 0o600)
	}
	cfg, problems := parseSettingsYAML(string(data))
	if HasErrors(problems) {
		cfg, _ = parseSettingsYAML(DefaultSettingsYAML)
	}
	if cfg.BashWhitelist == nil {
		cfg.EnsureBashWhitelist(DefaultBashWhitelist...)
	}
	return cfg, string(data)
}

// saveSettingsYAML validates and, only when error-free, persists raw
// (0600). Problems are returned either way.
func saveSettingsYAML(configDir, raw string) (Settings, []protocol.ConfigProblem, error) {
	cfg, problems := parseSettingsYAML(raw)
	if HasErrors(problems) {
		return Settings{}, problems, nil
	}
	if cfg.BashWhitelist == nil {
		cfg.EnsureBashWhitelist(DefaultBashWhitelist...)
	}
	if err := os.WriteFile(settingsPath(configDir), []byte(raw), 0o600); err != nil {
		return Settings{}, problems, fmt.Errorf("settings: write: %w", err)
	}
	return cfg, problems, nil
}

// EnsureBashWhitelist inserts missing prefixes (e.g. from
// COCONUT_BASH_WHITELIST) into the in-memory config only.
func (s *Settings) EnsureBashWhitelist(prefixes ...string) {
	seen := map[string]bool{}
	for _, p := range s.BashWhitelist {
		seen[p] = true
	}
	for _, p := range prefixes {
		if !seen[p] {
			s.BashWhitelist = append(s.BashWhitelist, p)
			seen[p] = true
		}
	}
}

// ---------------------------------------------------------------------------
// state.json — app-owned bookkeeping (not user-editable)
// ---------------------------------------------------------------------------

// appState is persisted app bookkeeping: the last workspace plus, per
// workspace, the set of known agents and which one was last open.
type appState struct {
	WorkspacePath string                     `json:"workspacePath"`
	Workspaces    map[string]*workspaceState `json:"workspaces,omitempty"`

	// Legacy v1 flat fields (pre per-workspace tracking). Migrated into
	// Workspaces on load; never written back out.
	SessionName     string `json:"sessionName,omitempty"`
	LastSessionFile string `json:"lastSessionFile,omitempty"`
}

// workspaceState tracks one workspace's agents.
type workspaceState struct {
	LastAgent string                 `json:"lastAgent,omitempty"`
	Agents    map[string]*agentState `json:"agents,omitempty"`

	// Legacy v2 fields (single session per workspace, pre-agents).
	// Migrated into Agents on load.
	SessionName     string `json:"sessionName,omitempty"`
	SessionSlug     string `json:"sessionSlug,omitempty"`
	PendingSlug     string `json:"pendingSlug,omitempty"`
	LastSessionFile string `json:"lastSessionFile,omitempty"`
}

// agentState tracks one agent: display name, a deferred rename target, and
// the transcript to restore.
type agentState struct {
	Name            string `json:"name"`
	PendingSlug     string `json:"pendingSlug,omitempty"`     // deferred rename, applied at next launch
	LastSessionFile string `json:"lastSessionFile,omitempty"` // pi session transcript to restore
}

// ws returns the state entry for a workspace, creating one on first use.
// Returns a throwaway entry for an empty path.
func (a *appState) ws(path string) *workspaceState {
	if path == "" {
		return &workspaceState{}
	}
	if a.Workspaces == nil {
		a.Workspaces = map[string]*workspaceState{}
	}
	w := a.Workspaces[path]
	if w == nil {
		w = &workspaceState{}
		a.Workspaces[path] = w
	}
	return w
}

// agent returns the state entry for an agent slug, creating a defaulted
// entry on first use.
func (w *workspaceState) agent(slug string) *agentState {
	if w.Agents == nil {
		w.Agents = map[string]*agentState{}
	}
	a := w.Agents[slug]
	if a == nil {
		a = &agentState{Name: humanizeSlug(slug)}
		w.Agents[slug] = a
	}
	if a.Name == "" {
		a.Name = humanizeSlug(slug)
	}
	return a
}

func statePath(configDir string) string { return filepath.Join(configDir, "state.json") }

func loadState(configDir string) appState {
	var st appState
	b, err := os.ReadFile(statePath(configDir))
	if err != nil {
		return st
	}
	_ = json.Unmarshal(b, &st)
	// v1 → v2: fold the flat shape into the per-workspace map.
	if st.WorkspacePath != "" && (st.SessionName != "" || st.LastSessionFile != "") {
		name := st.SessionName
		if name == "" {
			name = "Primary"
		}
		st.Workspaces = map[string]*workspaceState{
			st.WorkspacePath: {
				SessionName:     name,
				SessionSlug:     Slugify(name),
				LastSessionFile: st.LastSessionFile,
			},
		}
	}
	st.SessionName = ""
	st.LastSessionFile = ""
	// v2 → v3: single session per workspace → agents map.
	for _, w := range st.Workspaces {
		if w.SessionName == "" && w.LastSessionFile == "" {
			continue
		}
		slug := w.SessionSlug
		if slug == "" {
			slug = Slugify(w.SessionName)
		}
		a := w.agent(slug)
		if w.SessionName != "" {
			a.Name = w.SessionName
		}
		a.PendingSlug = w.PendingSlug
		a.LastSessionFile = w.LastSessionFile
		if w.LastAgent == "" {
			w.LastAgent = slug
		}
		w.SessionName, w.SessionSlug, w.PendingSlug, w.LastSessionFile = "", "", "", ""
	}
	return st
}

func saveState(configDir string, st appState) error {
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: multiple engines (windows) share this file; a torn
	// write would corrupt the other's view. PID-suffixed tmp avoids
	// cross-process collisions; rename is atomic on POSIX.
	tmp := fmt.Sprintf("%s.%d.tmp", statePath(configDir), os.Getpid())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, statePath(configDir)); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
