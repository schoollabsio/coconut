// Package core is the authoritative backend: single-writer actor,
// sequencer, snapshot engine, command router, and pi event normalizer.
// See PLAN.md §3.2 and §8.
package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jschool/custard/internal/piadapter"
	"github.com/jschool/custard/internal/protocol"
)

// EngineConfig wires the engine to its environment. Emit is invoked on
// the actor goroutine with a ready-to-serialize envelope; it must be
// safe to call from there (wails EventsEmit is).
type EngineConfig struct {
	ConfigDir     string                 // app config dir (agent/, sessions/, settings.json inside)
	ExtensionPath string                 // pi-extension/custard.ts
	SelfPath      string                 // os.Executable(), for sidecar resolution
	PickDir       func() (string, error) // native directory dialog
	Emit          func(env any)
}

// Engine is the backend orchestrator. All state mutation happens on the
// actor goroutine (PLAN.md §8.1); public methods are safe from anywhere.
type Engine struct {
	cfg EngineConfig

	inbox chan input
	done  chan struct{}

	state *domainState
	seq   uint64

	// sidecar
	pi     *piadapter.Client
	piProc *os.Process
	piUp   bool

	// async pi command continuations
	contCounter int64
	conts       map[int64]contEntry

	// stream coalescing (PLAN.md §10.1)
	pendingStreams map[string]any
	flushDue       bool
}

type contEntry struct {
	name string
	fn   func(resp piadapter.Response, err error)
}

type input interface{ coreInput() }

type cmdInput struct {
	cmd     protocol.Command
	respond chan []byte
}

type snapshotInput struct {
	respond chan []byte
}

type piEventInput struct{ ev piadapter.Event }
type piGoneInput struct{ err error }

type piRespInput struct {
	id   int64
	resp piadapter.Response
	err  error
}

type flushInput struct{}
type shutdownInput struct{}

func (cmdInput) coreInput()      {}
func (snapshotInput) coreInput() {}
func (piEventInput) coreInput()  {}
func (piGoneInput) coreInput()   {}
func (piRespInput) coreInput()   {}
func (flushInput) coreInput()    {}
func (shutdownInput) coreInput() {}

// NewEngine loads settings and prepares state; no sidecar yet.
func NewEngine(cfg EngineConfig) (*Engine, error) {
	if cfg.ConfigDir == "" {
		dir, err := ConfigDir()
		if err != nil {
			return nil, fmt.Errorf("core: config dir: %w", err)
		}
		cfg.ConfigDir = dir
	}
	for _, sub := range []string{"", "agent", "sessions"} {
		dir := filepathJoin(cfg.ConfigDir, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}

	e := &Engine{
		cfg:            cfg,
		inbox:          make(chan input, 256),
		done:           make(chan struct{}),
		state:          newDomainState(),
		conts:          map[int64]contEntry{},
		pendingStreams: map[string]any{},
	}
	e.state.settings, e.state.settingsRaw = loadSettingsYAML(cfg.ConfigDir)
	if extra := os.Getenv("CUSTARD_BASH_WHITELIST"); extra != "" {
		e.state.settings.EnsureBashWhitelist(strings.Split(extra, ",")...)
	}
	e.state.app = loadState(cfg.ConfigDir)
	e.state.workspacePath = e.state.app.WorkspacePath
	e.state.sessionName = e.state.app.ws(e.state.workspacePath).SessionName
	return e, nil
}

// Run is the actor loop. Blocks until Shutdown or ctx cancel.
func (e *Engine) Run(ctx context.Context) {
	defer close(e.done)
	for {
		select {
		case in := <-e.inbox:
			if _, ok := in.(shutdownInput); ok {
				e.stopSidecarLocked()
				return
			}
			e.handle(in)
		case <-ctx.Done():
			e.stopSidecarLocked()
			return
		}
	}
}

// Shutdown stops the actor and the sidecar.
func (e *Engine) Shutdown() {
	select {
	case e.inbox <- shutdownInput{}:
	case <-e.done:
	}
	<-e.done
}

// HandleCommand processes one serialized command envelope and returns
// the serialized command_response. Called from wails bindings.
func (e *Engine) HandleCommand(raw []byte) []byte {
	cmd, err := protocol.ParseCommand(raw)
	if err != nil {
		resp := protocol.ErrResponse("", "bad_envelope", err.Error())
		b, _ := json.Marshal(resp)
		return b
	}

	// The native directory dialog can block for minutes; it must not run
	// on the actor goroutine. Intercept here instead.
	if cmd.Name == protocol.CmdWorkspacePick {
		return e.handleWorkspacePickOffActor(cmd)
	}

	respond := make(chan []byte, 1)
	e.inbox <- cmdInput{cmd: cmd, respond: respond}
	return <-respond
}

// RequestSnapshot returns a serialized snapshot envelope.
func (e *Engine) RequestSnapshot() []byte {
	respond := make(chan []byte, 1)
	e.inbox <- snapshotInput{respond: respond}
	return <-respond
}

// ---------------------------------------------------------------------------
// actor dispatch
// ---------------------------------------------------------------------------

func (e *Engine) handle(in input) {
	switch v := in.(type) {
	case cmdInput:
		e.routeCommand(v.cmd, v.respond)
	case snapshotInput:
		v.respond <- e.buildSnapshot()
	case piEventInput:
		e.normalizePiEvent(v.ev)
	case piGoneInput:
		e.onSidecarGone(v.err)
	case piRespInput:
		if entry, ok := e.conts[v.id]; ok {
			delete(e.conts, v.id)
			entry.fn(v.resp, v.err)
		}
	case flushInput:
		e.flushStreamsLocked()
	}
}

// ---------------------------------------------------------------------------
// emission (actor-only)
// ---------------------------------------------------------------------------

// emitEvent assigns the global sequence number and emits a state event.
// Pending stream payloads flush first to preserve causal order.
func (e *Engine) emitEvent(name string, payload any, correlationID string) {
	e.flushStreamsLocked()
	e.seq++
	e.cfg.Emit(protocol.Event{
		Type:          "event",
		Seq:           e.seq,
		Name:          name,
		Payload:       payload,
		Timestamp:     nowMs(),
		CorrelationID: correlationID,
	})
}

// emitStream coalesces a high-frequency stream payload (latest wins per
// stream name) and schedules a flush within ~12ms (PLAN.md §10.1).
func (e *Engine) emitStream(name string, payload any) {
	e.pendingStreams[name] = payload
	if !e.flushDue {
		e.flushDue = true
		time.AfterFunc(12*time.Millisecond, func() {
			select {
			case e.inbox <- flushInput{}:
			case <-e.done:
			}
		})
	}
}

func (e *Engine) flushStreamsLocked() {
	if len(e.pendingStreams) == 0 {
		e.flushDue = false
		return
	}
	for name, payload := range e.pendingStreams {
		e.cfg.Emit(protocol.Stream{Type: "stream", Name: name, Payload: payload})
	}
	e.pendingStreams = map[string]any{}
	e.flushDue = false
}

func (e *Engine) notify(level, message string) {
	e.emitEvent(protocol.EvNotification, protocol.NotificationPayload{Level: level, Message: message}, "")
}

// buildSnapshot (actor-only) serializes the current snapshot envelope.
func (e *Engine) buildSnapshot() []byte {
	env := protocol.Snapshot{
		Type:  "snapshot",
		Seq:   e.seq,
		State: e.state.snapshot(),
	}
	b, _ := json.Marshal(env)
	return b
}

// ---------------------------------------------------------------------------
// sidecar command plumbing (actor-only)
// ---------------------------------------------------------------------------

// sendPi issues a pi command; the continuation runs back on the actor.
func (e *Engine) sendPi(name string, fields map[string]any, cont func(resp piadapter.Response, err error)) {
	e.contCounter++
	id := e.contCounter
	e.conts[id] = contEntry{name: name, fn: cont}

	pi := e.pi
	if pi == nil {
		delete(e.conts, id)
		cont(piadapter.Response{}, errors.New("sidecar not running"))
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		resp, err := pi.Command(ctx, name, fields)
		select {
		case e.inbox <- piRespInput{id: id, resp: resp, err: err}:
		case <-e.done:
		}
	}()
}

// sendPiRaw sends a fire-and-forget message (e.g. extension_ui_response).
func (e *Engine) sendPiRaw(obj map[string]any) {
	if e.pi == nil {
		return
	}
	_ = e.pi.Send(obj)
}

func filepathJoin(a, b string) string {
	if b == "" {
		return a
	}
	return a + string(os.PathSeparator) + b
}
