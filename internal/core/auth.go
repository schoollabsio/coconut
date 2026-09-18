package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/jschool/coconut/internal/pilogin"
	"github.com/jschool/coconut/internal/protocol"
)

// ---------------------------------------------------------------------------
// Login helper lifecycle (actor-only: *Locked methods run on the actor)
// ---------------------------------------------------------------------------

// startLoginHelperLocked spawns the coconut-login helper on demand. It
// shares the sidecar's agent dir, so credentials written by a login are
// the same ones the sidecar reads from auth.json.
func (e *Engine) startLoginHelperLocked() error {
	if e.loginClient != nil {
		return nil
	}
	binary := pilogin.ResolveLoginHelper(e.cfg.SelfPath)
	agentDir := filepath.Join(e.cfg.ConfigDir, "agent")
	env := pilogin.MergedEnv([]string{"COCONUT_AGENT_DIR=" + agentDir})

	client, cmd, err := pilogin.StartProcess(binary, env)
	if err != nil {
		return fmt.Errorf("login helper: %w", err)
	}
	e.loginClient = client
	e.loginProc = cmd.Process

	// Pump helper events (notify / prompt / ready) into the actor.
	go func() {
		for ev := range client.Events() {
			select {
			case e.inbox <- loginEventInput{ev: ev}:
			case <-e.done:
				return
			}
		}
	}()
	go func() {
		<-client.Exited()
		select {
			case e.inbox <- loginGoneInput{err: client.ExitErr()}:
			case <-e.done:
			}
	}()
	return nil
}

func (e *Engine) stopLoginHelperLocked() {
	if e.loginClient != nil {
		_ = e.loginClient.Close()
		e.loginClient = nil
		e.loginProc = nil
	}
}

// sendHelper issues a helper request; the continuation runs back on the
// actor goroutine (same pattern as sendPi). Logins can take minutes
// (device-code polling), so the wait bound is generous.
func (e *Engine) sendHelper(name string, fields map[string]any, cont func(resp pilogin.Response, err error)) {
	e.sendHelperWithID("", name, fields, cont)
}

// sendHelperWithID is sendHelper with an explicit helper correlation id.
// Login uses it: the helper echoes this id in its notify/prompt events
// and in the login response, so it must equal the loginId the frontend
// flow is keyed by (the command id). cancel/prompt_response relay the
// same id back, so all three stay in one id space.
func (e *Engine) sendHelperWithID(helperID, name string, fields map[string]any, cont func(resp pilogin.Response, err error)) {
	if e.loginClient == nil {
		cont(pilogin.Response{}, errors.New("login helper not running"))
		return
	}
	e.helperContCounter++
	id := e.helperContCounter
	e.helperConts[id] = cont

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		resp, err := e.loginClient.CommandID(ctx, helperID, name, fields)
		select {
		case e.inbox <- loginRespInput{id: id, resp: resp, err: err}:
		case <-e.done:
		}
	}()
}

// sendHelperRaw sends a fire-and-forget helper request (prompt_response,
// cancel) that expects no response record.
func (e *Engine) sendHelperRaw(obj map[string]any) {
	if e.loginClient == nil {
		return
	}
	_ = e.loginClient.Send(obj)
}

// ---------------------------------------------------------------------------
// Helper events (actor-only)
// ---------------------------------------------------------------------------

// handleLoginHelperEvent bridges asynchronous helper records to frontend
// events. Only notify/prompt are expected; ready is startup noise.
func (e *Engine) handleLoginHelperEvent(ev pilogin.Event) {
	switch ev.Type {
	case "notify":
		var rec struct {
			ID    string          `json:"id"`
			Event json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal(ev.Raw, &rec); err != nil {
			return
		}
		e.emitEvent(protocol.EvAuthLoginStep, map[string]any{
			"loginId": rec.ID,
			"event":   json.RawMessage(rec.Event),
		}, "")
	case "prompt":
		var rec struct {
			ID      string          `json:"id"`
			LoginID string          `json:"loginId"`
			Prompt  json.RawMessage `json:"prompt"`
		}
		if err := json.Unmarshal(ev.Raw, &rec); err != nil {
			return
		}
		e.emitEvent(protocol.EvAuthLoginPrompt, map[string]any{
			"loginId":  rec.LoginID,
			"promptId": rec.ID,
			"prompt":   json.RawMessage(rec.Prompt),
		}, "")
	case "ready":
		// helper finished ModelRuntime.create; nothing to do.
	}
}

// onLoginHelperGone handles the helper exiting unexpectedly: any
// in-flight login is failed, and the client is dropped (the next
// command respawns it).
func (e *Engine) onLoginHelperGone(err error) {
	e.stopLoginHelperLocked()
	if e.activeLoginID != "" {
		loginID := e.activeLoginID
		e.activeLoginID = ""
		e.activeLoginProvider = ""
		e.emitEvent(protocol.EvAuthLoginFailed, map[string]any{
			"loginId": loginID,
			"message": fmt.Sprintf("login helper exited: %v", err),
		}, "")
	}
}

// migrateYAMLApiKeyLocked best-effort copies a top-level settings.yaml
// apiKey for a BUILT-IN provider into pi's credential store (auth.json).
// The YAML key keeps working (env injection); the credential store is the
// going-forward home and is what the Provider panel reports. Custom
// providers keep their key in models.json (the right place for them).
func (e *Engine) migrateYAMLApiKeyLocked(cfg Settings) {
	if cfg.APIKey == "" || cfg.Provider == "" {
		return
	}
	if !isKnownProvider(cfg.Provider) {
		return
	}
	if err := e.startLoginHelperLocked(); err != nil {
		e.notify("warning", "Could not migrate apiKey to the credential store: "+err.Error())
		return
	}
	e.sendHelper("set_api_key", map[string]any{"provider": cfg.Provider, "key": cfg.APIKey},
		func(resp pilogin.Response, err error) {
			if err != nil || !resp.OK {
				e.notify("warning", "apiKey migration to credential store failed: "+errString(err, resp.Message))
				return
			}
			e.notify("info", "Migrated apiKey for "+cfg.Provider+" into the credential store (auth.json). Once verified, you can remove apiKey: from settings.yaml.")
		})
}

// restartSidecarForAuth restarts the sidecar so it picks up the new
// credential (auth.json is read at provider initialization). Safe no-op
// when the sidecar is down.
func (e *Engine) restartSidecarForAuth() {
	if !e.piUp {
		return
	}
	// Same pattern as settings.save: stop, then start again for the
	// current agent. The agent's last session is restored from disk.
	slug := e.state.agentSlug
	e.stopSidecarLocked()
	if slug == "" {
		return
	}
	e.startSidecarLocked(slug, "", false, func(err error) {
		if err != nil {
			e.notify("error", "Sidecar restart after sign-in failed: "+err.Error())
		}
	})
}

// ---------------------------------------------------------------------------
// Auth commands (actor-only)
// ---------------------------------------------------------------------------

// cmdAuthStatus reports providers, their auth capabilities, credential
// status, and stored credentials (never raw secrets).
func (e *Engine) cmdAuthStatus(cmd protocol.Command, respond chan []byte) {
	if err := e.startLoginHelperLocked(); err != nil {
		respond <- respondErr(cmd, "helper_failed", err.Error())
		return
	}
	e.sendHelper("status", nil, func(resp pilogin.Response, err error) {
		if err != nil || !resp.OK {
			respond <- respondErr(cmd, "auth_status_failed", errString(err, resp.Message))
			return
		}
		var hr struct {
			Providers []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
				Auth struct {
					APIKey bool `json:"apiKey"`
					OAuth  bool `json:"oauth"`
				} `json:"auth"`
				Status struct {
					Configured bool   `json:"configured"`
					Source     string `json:"source"`
					Type       string `json:"type"`
				} `json:"status"`
			} `json:"providers"`
			Credentials []protocol.CredentialInfo `json:"credentials"`
		}
		if err := json.Unmarshal(resp.Raw, &hr); err != nil {
			respond <- respondErr(cmd, "auth_status_failed", "bad status payload: "+err.Error())
			return
		}
		providers := make([]protocol.AuthProviderStatus, 0, len(hr.Providers))
		for _, p := range hr.Providers {
			providers = append(providers, protocol.AuthProviderStatus{
				ID:         p.ID,
				Name:       p.Name,
				OAuth:      p.Auth.OAuth,
				APIKey:     p.Auth.APIKey,
				Configured: p.Status.Configured,
				Source:     p.Status.Source,
				Type:       p.Status.Type,
			})
		}
		respond <- respondOK(cmd, protocol.AuthStatusResult{
			Providers:      providers,
			Credentials:    hr.Credentials,
			ActiveProvider: e.state.settings.Provider,
		})
	})
}

// cmdAuthModels lists models usable under the current credentials.
func (e *Engine) cmdAuthModels(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthModelsPayload
	_ = json.Unmarshal(cmd.Payload, &p)

	if err := e.startLoginHelperLocked(); err != nil {
		respond <- respondErr(cmd, "helper_failed", err.Error())
		return
	}
	fields := map[string]any{}
	if p.Provider != "" {
		fields["provider"] = p.Provider
	}
	e.sendHelper("models", fields, func(resp pilogin.Response, err error) {
		if err != nil || !resp.OK {
			respond <- respondErr(cmd, "auth_models_failed", errString(err, resp.Message))
			return
		}
		var hr struct {
			Models []protocol.AuthModel `json:"models"`
		}
		if err := json.Unmarshal(resp.Raw, &hr); err != nil {
			respond <- respondErr(cmd, "auth_models_failed", "bad models payload: "+err.Error())
			return
		}
		respond <- respondOK(cmd, map[string]any{"models": hr.Models})
	})
}

// cmdAuthLogin starts a login flow. Responds immediately with the loginId
// (= this command's id); progress arrives as auth.login.* events.
func (e *Engine) cmdAuthLogin(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthLoginStartPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Provider == "" {
		respond <- respondErr(cmd, "bad_payload", "auth.login needs {provider, authType}")
		return
	}
	authType := p.AuthType
	if authType == "" {
		authType = protocol.AuthTypeOAuth
	}
	if authType != protocol.AuthTypeOAuth && authType != protocol.AuthTypeAPIKey {
		respond <- respondErr(cmd, "bad_payload", "authType must be oauth or api_key")
		return
	}
	if e.activeLoginID != "" {
		respond <- respondErr(cmd, "login_in_progress", "a login is already in flight ("+e.activeLoginID+")")
		return
	}
	if err := e.startLoginHelperLocked(); err != nil {
		respond <- respondErr(cmd, "helper_failed", err.Error())
		return
	}

	loginID := cmd.ID
	e.activeLoginID = loginID
	e.activeLoginProvider = p.Provider
	e.emitEvent(protocol.EvAuthLoginStarted, map[string]any{
		"loginId":  loginID,
		"provider": p.Provider,
		"authType": authType,
	}, cmd.ID)

	e.sendHelperWithID(loginID, "login", map[string]any{"provider": p.Provider, "authType": authType},
		func(resp pilogin.Response, err error) {
			e.activeLoginID = ""
			e.activeLoginProvider = ""
			switch {
		case err != nil:
			e.emitEvent(protocol.EvAuthLoginFailed, map[string]any{"loginId": loginID, "message": err.Error()}, "")
		case resp.Type == "done":
			e.emitEvent(protocol.EvAuthLoginCompleted, map[string]any{"loginId": loginID, "provider": p.Provider}, "")
			e.notify("info", "Signed in to "+p.Provider)
			e.restartSidecarForAuth()
		case resp.Type == "cancelled":
			e.emitEvent(protocol.EvAuthLoginCancelled, map[string]any{"loginId": loginID, "message": resp.Message}, "")
		default:
			e.emitEvent(protocol.EvAuthLoginFailed, map[string]any{"loginId": loginID, "message": errString(err, resp.Message)}, "")
		}
		})

	respond <- respondOK(cmd, map[string]any{"loginId": loginID, "provider": p.Provider, "authType": authType})
}

// cmdAuthLoginPrompt relays the user's answer to a pending login prompt.
func (e *Engine) cmdAuthLoginPrompt(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthLoginPromptPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.PromptID == "" {
		respond <- respondErr(cmd, "bad_payload", "auth.login.prompt needs {promptId}")
		return
	}
	if e.activeLoginID == "" {
		respond <- respondErr(cmd, "no_login_in_progress", "no login is in flight")
		return
	}
	obj := map[string]any{"type": "prompt_response", "id": p.PromptID}
	if !p.Cancel {
		obj["value"] = p.Value
	}
	e.sendHelperRaw(obj)
	respond <- respondOK(cmd, nil)
}

// cmdAuthLoginCancel aborts the in-flight login. The completion arrives
// as the login request's response (type "cancelled").
func (e *Engine) cmdAuthLoginCancel(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthLoginCancelPayload
	_ = json.Unmarshal(cmd.Payload, &p)
	if p.LoginID == "" {
		p.LoginID = e.activeLoginID
	}
	if p.LoginID == "" {
		respond <- respondErr(cmd, "no_login_in_progress", "no login is in flight")
		return
	}
	e.sendHelperRaw(map[string]any{"type": "cancel", "id": p.LoginID})
	respond <- respondOK(cmd, nil)
}

// cmdAuthSetApiKey stores an API key credential for a provider.
func (e *Engine) cmdAuthSetApiKey(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthSetApiKeyPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Provider == "" || p.Key == "" {
		respond <- respondErr(cmd, "bad_payload", "auth.set_api_key needs {provider, key}")
		return
	}
	if err := e.startLoginHelperLocked(); err != nil {
		respond <- respondErr(cmd, "helper_failed", err.Error())
		return
	}
	e.sendHelper("set_api_key", map[string]any{"provider": p.Provider, "key": p.Key},
		func(resp pilogin.Response, err error) {
			if err != nil || !resp.OK {
				respond <- respondErr(cmd, "auth_set_key_failed", errString(err, resp.Message))
				return
			}
			e.restartSidecarForAuth()
			respond <- respondOK(cmd, nil)
		})
}

// cmdAuthLogout removes a provider credential.
func (e *Engine) cmdAuthLogout(cmd protocol.Command, respond chan []byte) {
	var p protocol.AuthProviderPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Provider == "" {
		respond <- respondErr(cmd, "bad_payload", "auth.logout needs {provider}")
		return
	}
	if err := e.startLoginHelperLocked(); err != nil {
		respond <- respondErr(cmd, "helper_failed", err.Error())
		return
	}
	e.sendHelper("logout", map[string]any{"provider": p.Provider},
		func(resp pilogin.Response, err error) {
			if err != nil || !resp.OK {
				respond <- respondErr(cmd, "auth_logout_failed", errString(err, resp.Message))
				return
			}
			e.restartSidecarForAuth()
			respond <- respondOK(cmd, nil)
		})
}
