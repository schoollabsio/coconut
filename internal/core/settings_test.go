package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func noEnv(string) (string, bool) { return "", false }

func withEnv(pairs ...string) func(string) (string, bool) {
	m := map[string]string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		m[pairs[i]] = pairs[i+1]
	}
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func errorsOf(ps []string) []string { return ps } // readability alias

func problemsFor(t *testing.T, text string, env func(string) (string, bool)) (Settings, []string) {
	t.Helper()
	var s Settings
	dec := yaml.NewDecoder(strings.NewReader(text))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		return Settings{}, []string{"parse: " + err.Error()}
	}
	var msgs []string
	for _, p := range s.Validate(env) {
		msgs = append(msgs, p.Severity+": "+p.Message)
	}
	return s, msgs
}

func hasSeverity(msgs []string, sev string) bool {
	for _, m := range msgs {
		if strings.HasPrefix(m, sev+":") {
			return true
		}
	}
	return false
}

func containsMsg(msgs []string, sub string) bool {
	for _, m := range msgs {
		if strings.Contains(m, sub) {
			return true
		}
	}
	return false
}

func TestValidateValidMinimal(t *testing.T) {
	_, msgs := problemsFor(t, "provider: anthropic\napiKey: sk-ant-test\nbashWhitelist:\n  - ls\n", noEnv)
	if len(msgs) != 0 {
		t.Fatalf("expected no problems, got %v", msgs)
	}
}

func TestValidateMissingProvider(t *testing.T) {
	_, msgs := problemsFor(t, "bashWhitelist: [ls]\n", noEnv)
	if !containsMsg(msgs, "provider: required") {
		t.Fatalf("expected provider-required error, got %v", msgs)
	}
}

func TestValidateUnknownProvider(t *testing.T) {
	_, msgs := problemsFor(t, "provider: madeupcorp\n", noEnv)
	if !containsMsg(msgs, `provider "madeupcorp"`) {
		t.Fatalf("expected unknown-provider error, got %v", msgs)
	}
}

func TestValidateCustomProviderComplete(t *testing.T) {
	yaml := `
provider: myproxy
providers:
  myproxy:
    baseUrl: https://proxy.example.com/v1
    api: openai-completions
    apiKey: sk-x
    authHeader: true
    headers:
      X-Tenant: blue
    models:
      - id: my-model
bashWhitelist: [ls]
`
	s, msgs := problemsFor(t, yaml, noEnv)
	if hasSeverity(msgs, "error") {
		t.Fatalf("expected no errors, got %v", msgs)
	}
	p := s.Providers["myproxy"]
	if p.API != "openai-completions" || p.Headers["X-Tenant"] != "blue" {
		t.Fatalf("provider parsed wrong: %+v", p)
	}
	if p.AuthHeader == nil || !*p.AuthHeader {
		t.Fatalf("authHeader not parsed: %+v", p)
	}
}

func TestValidateCustomProviderMissingPieces(t *testing.T) {
	yaml := "provider: myproxy\nproviders:\n  myproxy: {}\n"
	_, msgs := problemsFor(t, yaml, noEnv)
	for _, want := range []string{"baseUrl is required", "api is required", "models:"} {
		if !containsMsg(msgs, want) {
			t.Fatalf("expected %q in %v", want, msgs)
		}
	}
}

func TestValidateBadAPIValue(t *testing.T) {
	yaml := `
provider: anthropic
apiKey: k
providers:
  anthropic:
    api: not-a-real-api
`
	_, msgs := problemsFor(t, yaml, noEnv)
	if !containsMsg(msgs, "not a pi api") {
		t.Fatalf("expected api error, got %v", msgs)
	}
}

func TestValidateBadBaseURL(t *testing.T) {
	yaml := `
provider: anthropic
apiKey: k
providers:
  anthropic:
    baseUrl: notaurl
`
	_, msgs := problemsFor(t, yaml, noEnv)
	if !containsMsg(msgs, "not a valid http(s) URL") {
		t.Fatalf("expected baseUrl error, got %v", msgs)
	}
}

func TestValidateModelPrefix(t *testing.T) {
	_, msgs := problemsFor(t, "provider: anthropic\napiKey: k\nmodel: foo/bar\n", noEnv)
	if !containsMsg(msgs, `unknown provider prefix "foo"`) {
		t.Fatalf("expected model prefix error, got %v", msgs)
	}
	_, msgs = problemsFor(t, "provider: anthropic\napiKey: k\nmodel: anthropic/claude-sonnet-4-5\n", noEnv)
	if hasSeverity(errorsOf(msgs), "error") {
		t.Fatalf("expected valid, got %v", msgs)
	}
	// Bare substring patterns are fine (pi fuzzy-matches).
	_, msgs = problemsFor(t, "provider: anthropic\napiKey: k\nmodel: claude\n", noEnv)
	if hasSeverity(msgs, "error") {
		t.Fatalf("expected valid, got %v", msgs)
	}
}

func TestValidateCredentialWarnings(t *testing.T) {
	// No key anywhere → warning (not error).
	_, msgs := problemsFor(t, "provider: anthropic\nbashWhitelist: [ls]\n", noEnv)
	if hasSeverity(msgs, "error") || !containsMsg(msgs, "ANTHROPIC_API_KEY") {
		t.Fatalf("expected credential warning, got %v", msgs)
	}
	// Key via env → no warning.
	_, msgs = problemsFor(t, "provider: anthropic\nbashWhitelist: [ls]\n", withEnv("ANTHROPIC_API_KEY", "x"))
	if len(msgs) != 0 {
		t.Fatalf("expected clean, got %v", msgs)
	}
	// google's env var is GEMINI_API_KEY, not GOOGLE_API_KEY.
	_, msgs = problemsFor(t, "provider: google\nbashWhitelist: [ls]\n", withEnv("GOOGLE_API_KEY", "x"))
	if !containsMsg(msgs, "GEMINI_API_KEY") {
		t.Fatalf("expected GEMINI_API_KEY warning, got %v", msgs)
	}
}

func TestValidateUnknownProviderKeyWarns(t *testing.T) {
	yaml := `
provider: anthropic
apiKey: k
providers:
  anthropic:
    baseUrl: https://proxy.example.com
    compatt: {}
`
	_, msgs := problemsFor(t, yaml, noEnv)
	if hasSeverity(msgs, "error") {
		t.Fatalf("passthrough keys should not error, got %v", msgs)
	}
	if !containsMsg(msgs, `unknown key "compatt"`) {
		t.Fatalf("expected passthrough warning, got %v", msgs)
	}
}

func TestParseRejectsUnknownTopLevelKey(t *testing.T) {
	_, problems := parseSettingsYAML("provider: anthropic\nmodell: x\n")
	if !HasErrors(problems) || !strings.Contains(problems[0].Message, "modell") {
		t.Fatalf("expected unknown-field error, got %v", problems)
	}
}

func TestParseBadYAML(t *testing.T) {
	_, problems := parseSettingsYAML("provider: [unclosed\n")
	if !HasErrors(problems) {
		t.Fatalf("expected parse error, got %v", problems)
	}
}

func TestLoadSettingsYAMLCreatesTemplate(t *testing.T) {
	dir := t.TempDir()
	cfg, raw := loadSettingsYAML(dir)
	if cfg.Provider != "anthropic" {
		t.Fatalf("template provider = %q", cfg.Provider)
	}
	if !strings.Contains(raw, "# custard settings") {
		t.Fatal("raw should be the commented template")
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.yaml")); err != nil {
		t.Fatal("template not written to disk")
	}
	// Template itself must validate error-free (warnings allowed: no key).
	_, problems := parseSettingsYAML(raw)
	if HasErrors(problems) {
		t.Fatalf("shipped template must validate: %v", problems)
	}
}

func TestLoadSettingsYAMLBrokenFileFallsBack(t *testing.T) {
	dir := t.TempDir()
	broken := "provider: [unclosed\n"
	if err := os.WriteFile(filepath.Join(dir, "settings.yaml"), []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, raw := loadSettingsYAML(dir)
	if raw != broken {
		t.Fatal("raw text must be preserved so the user can fix it")
	}
	if cfg.Provider != "anthropic" {
		t.Fatal("in-memory config should fall back to template")
	}
}

func TestSaveSettingsYAMLRefusesInvalid(t *testing.T) {
	dir := t.TempDir()
	cfg, problems, err := saveSettingsYAML(dir, "provider: madeupcorp\n")
	if err != nil {
		t.Fatal(err)
	}
	if !HasErrors(problems) {
		t.Fatal("expected validation errors")
	}
	if cfg.Provider != "" {
		t.Fatal("invalid config must not be returned as active")
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.yaml")); !os.IsNotExist(err) {
		t.Fatal("invalid config must not be persisted")
	}
}

func TestSaveSettingsYAMLRoundTrip(t *testing.T) {
	dir := t.TempDir()
	raw := "# my comment stays\nprovider: openai\napiKey: sk-x\nbashWhitelist: [ls]\n"
	cfg, problems, err := saveSettingsYAML(dir, raw)
	if err != nil || HasErrors(problems) {
		t.Fatalf("save failed: %v %v", problems, err)
	}
	if cfg.Provider != "openai" {
		t.Fatalf("provider = %q", cfg.Provider)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "settings.yaml"))
	if string(got) != raw {
		t.Fatal("raw text (with comments) must round-trip verbatim")
	}
	info, _ := os.Stat(filepath.Join(dir, "settings.yaml"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings.yaml perms = %o, want 600", info.Mode().Perm())
	}
}

func TestWriteModelsJSON(t *testing.T) {
	dir := t.TempDir()
	cfg := Settings{
		Provider: "myproxy",
		APIKey:   "top-level-key",
		Providers: map[string]ProviderSettings{
			"myproxy": {
				BaseURL:    "https://proxy.example.com/v1",
				API:        "openai-completions",
				AuthHeader: boolPtr(true),
				Headers:    map[string]string{"X-Tenant": "blue"},
				Models:     []map[string]any{{"id": "m1"}},
				Extra:      map[string]any{"compat": map[string]any{"supportsStore": false}},
			},
			"anthropic": {BaseURL: "https://proxy.internal/anthropic"},
		},
	}
	if err := writeModelsJSON(dir, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Providers map[string]map[string]any `json:"providers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	my := doc.Providers["myproxy"]
	if my["baseUrl"] != "https://proxy.example.com/v1" || my["api"] != "openai-completions" {
		t.Fatalf("myproxy entry wrong: %v", my)
	}
	if my["apiKey"] != "top-level-key" {
		t.Fatal("top-level apiKey should feed the selected provider's entry")
	}
	if my["authHeader"] != true {
		t.Fatal("authHeader missing")
	}
	if my["headers"].(map[string]any)["X-Tenant"] != "blue" {
		t.Fatal("headers missing")
	}
	if my["compat"] == nil {
		t.Fatal("Extra keys must pass through to models.json")
	}
	ant := doc.Providers["anthropic"]
	if ant["baseUrl"] != "https://proxy.internal/anthropic" {
		t.Fatal("built-in override missing")
	}
	if _, hasKey := ant["apiKey"]; hasKey {
		t.Fatal("unrelated provider must not receive the top-level key")
	}

	// Removing providers from settings removes the stale file.
	if err := writeModelsJSON(dir, Settings{Provider: "anthropic"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "models.json")); !os.IsNotExist(err) {
		t.Fatal("stale models.json not removed")
	}
}

func boolPtr(b bool) *bool { return &b }
