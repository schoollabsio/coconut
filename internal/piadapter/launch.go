package piadapter

import (
	"os"
	"path/filepath"
	"strings"
)

// LaunchSpec captures everything needed to start the sidecar for a
// workspace. Built by BuildLaunchSpec from app settings.
type LaunchSpec struct {
	Binary string
	Args   []string
	Env    []string // merged over os.Environ
	Dir    string   // workspace cwd
}

// SidecarSettings is the subset of app settings that shapes the launch.
type SidecarSettings struct {
	Provider      string   // e.g. "anthropic"; empty = pi default
	Model         string   // optional model pattern/ID
	APIKey        string   // provider key; injected via env
	APIKeyEnv     []string // env var names for the key; empty = use convention
	BashWhitelist []string // extra prefixes for CUSTARD_BASH_WHITELIST
	SessionName   string
}

// ResolveBinary picks the sidecar binary: the bundled custard-pi next to
// our executable (packaged builds / repo build/sidecar), else "pi" from
// PATH (development fallback).
func ResolveBinary(selfPath string) string {
	if selfPath != "" {
		dir := filepath.Dir(selfPath)
		candidates := []string{
			filepath.Join(dir, "custard-pi"),                  // packaged: next to app binary
			filepath.Join(dir, "..", "sidecar", "custard-pi"), // repo build/sidecar from build/bin
			filepath.Join(dir, "..", "..", "build", "sidecar", "custard-pi"),
		}
		for _, p := range candidates {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				abs, err := filepath.Abs(p)
				if err == nil {
					return abs
				}
				return p
			}
		}
	}
	return "pi" // PATH fallback
}

// BuildLaunchSpec assembles the sidecar invocation:
//
//	pi --mode rpc --no-extensions -e <extension> \
//	   --tools read,bash,grep,find,ls,propose_edit,show_content \
//	   [--provider P --model M] --session-dir <dir> [--name N]
//
// env: PI_CODING_AGENT_DIR (isolated config), provider API key,
// CUSTARD_BASH_WHITELIST, PI_SKIP_VERSION_CHECK=1.
func BuildLaunchSpec(s SidecarSettings, workspace, agentDir, sessionDir, extensionPath, binary string) LaunchSpec {
	args := []string{
		"--mode", "rpc",
		"--no-extensions",
		"-e", extensionPath,
		"--tools", "read,bash,grep,find,ls,propose_edit,show_content",
		"--session-dir", sessionDir,
	}
	if s.Provider != "" {
		args = append(args, "--provider", s.Provider)
	}
	if s.Model != "" {
		args = append(args, "--model", s.Model)
	}
	if s.SessionName != "" {
		args = append(args, "--name", s.SessionName)
	}

	env := []string{
		"PI_CODING_AGENT_DIR=" + agentDir,
		"PI_SKIP_VERSION_CHECK=1",
		"PI_TELEMETRY=0",
	}
	if len(s.BashWhitelist) > 0 {
		env = append(env, "CUSTARD_BASH_WHITELIST="+strings.Join(s.BashWhitelist, ","))
	}
	if s.APIKey != "" {
		names := s.APIKeyEnv
		if len(names) == 0 {
			names = providerKeyEnvVars(s.Provider)
		}
		for _, name := range names {
			env = append(env, name+"="+s.APIKey)
		}
	}

	return LaunchSpec{Binary: binary, Args: args, Env: env, Dir: workspace}
}

// providerKeyEnvVars maps a provider to the env vars pi reads its key
// from. Multiple candidates are all set (cheap and harmless).
func providerKeyEnvVars(provider string) []string {
	switch strings.ToLower(provider) {
	case "anthropic":
		return []string{"ANTHROPIC_API_KEY"}
	case "openai":
		return []string{"OPENAI_API_KEY"}
	case "google", "gemini":
		return []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}
	case "openrouter":
		return []string{"OPENROUTER_API_KEY"}
	case "groq":
		return []string{"GROQ_API_KEY"}
	case "mistral":
		return []string{"MISTRAL_API_KEY"}
	case "xai":
		return []string{"XAI_API_KEY"}
	default:
		// Unknown/custom provider: try the conventional name too.
		upper := strings.ToUpper(strings.ReplaceAll(provider, "-", "_"))
		return []string{upper + "_API_KEY"}
	}
}

// MergedEnv returns os.Environ() overlaid with extra (extra wins).
func MergedEnv(extra []string) []string {
	base := os.Environ()
	override := map[string]string{}
	for _, kv := range extra {
		if i := strings.IndexByte(kv, '='); i > 0 {
			override[kv[:i]] = kv
		}
	}
	out := make([]string, 0, len(base)+len(extra))
	for _, kv := range base {
		if i := strings.IndexByte(kv, '='); i > 0 {
			if _, replaced := override[kv[:i]]; replaced {
				continue
			}
		}
		out = append(out, kv)
	}
	for _, kv := range override {
		out = append(out, kv)
	}
	return out
}
