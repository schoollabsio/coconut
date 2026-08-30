package core

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/jschool/custard/internal/protocol"
)

// DefaultBashWhitelist mirrors the extension's read-only defaults; the
// settings UI shows these as the baseline.
var DefaultBashWhitelist = []string{
	"ls", "grep", "find", "cat", "head", "tail", "pwd", "wc",
	"file", "stat", "which", "echo",
	"git status", "git diff", "git log", "git show", "git branch",
}

// ConfigDir resolves the app config directory. CUSTARD_CONFIG_DIR
// overrides (dev/tests); otherwise os.UserConfigDir()/custard.
func ConfigDir() (string, error) {
	if dir := os.Getenv("CUSTARD_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "custard"), nil
}

// persistedSettings is the on-disk shape (includes the API key; file is
// 0600 and app-owned).
type persistedSettings struct {
	Provider        string   `json:"provider"`
	APIKey          string   `json:"apiKey,omitempty"`
	Model           string   `json:"model,omitempty"`
	BashWhitelist   []string `json:"bashWhitelist"`
	WorkspacePath   string   `json:"workspacePath"`
	SessionName     string   `json:"sessionName"`
	LastSessionFile string   `json:"lastSessionFile,omitempty"`
}

func settingsPath(configDir string) string {
	return filepath.Join(configDir, "settings.json")
}

func loadSettings(configDir string) persistedSettings {
	var s persistedSettings
	b, err := os.ReadFile(settingsPath(configDir))
	if err != nil {
		return s // zero value; defaults applied by caller
	}
	_ = json.Unmarshal(b, &s)
	return s
}

func saveSettings(configDir string, s persistedSettings) error {
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath(configDir), b, 0o600)
}

// public converts to the wire shape: API key redacted, flag set.
func (s persistedSettings) public() protocol.Settings {
	return protocol.Settings{
		Provider:         s.Provider,
		APIKeyConfigured: s.APIKey != "",
		Model:            s.Model,
		BashWhitelist:    s.BashWhitelist,
		WorkspacePath:    s.WorkspacePath,
		SessionName:      s.SessionName,
		LastSessionFile:  s.LastSessionFile,
	}
}

// applySave merges a settings.save payload; empty APIKey keeps the
// existing one unless ClearAPIKey is set.
func (s *persistedSettings) applySave(p protocol.SettingsSavePayload) error {
	if p.Provider == "" {
		return errors.New("provider is required")
	}
	s.Provider = p.Provider
	if p.ClearAPIKey {
		s.APIKey = ""
	} else if p.APIKey != "" {
		s.APIKey = p.APIKey
	}
	s.Model = p.Model
	if p.BashWhitelist == nil {
		s.BashWhitelist = []string{}
	} else {
		s.BashWhitelist = p.BashWhitelist
	}
	return nil
}
