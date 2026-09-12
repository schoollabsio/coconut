package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jschool/coconut/internal/core"
	"github.com/jschool/coconut/internal/piadapter"
	"github.com/jschool/coconut/internal/protocol"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// App is the Wails-bound application facade and the multi-window manager.
// The bound surface is protocol-pure by design:
//
//	Command(ctx, reqJSON) string  — command envelope in, response envelope out
//	RequestSnapshot(ctx) string  — snapshot envelope out
//	NewWindow(ctx, reqJSON) string — open a sibling window on an agent
//
// Every window owns its own core.Engine (its own sidecar, seq space, and
// "backend" event channel), so multiple agents run in parallel. Bound
// methods receive the CALLING window via ctx (application.WindowKey) —
// that is the routing key.
type App struct {
	wails      *application.App
	mu         sync.Mutex
	entries    map[uint]*windowEntry
	winCounter int // unique sibling-window names (protected by mu)
}

type windowEntry struct {
	window   application.Window
	engine   *core.Engine
	pollStop chan struct{}
	detachOnce sync.Once
}

func NewApp(wails *application.App) *App {
	return &App{wails: wails, entries: map[uint]*windowEntry{}}
}

// Bind wires the wails app in after construction (the app is created
// first so it can be listed in wails' Services).
func (a *App) Bind(wails *application.App) {
	a.wails = wails
}

// attach creates and starts the engine for one window. boot is the
// one-shot Bootstrap target (nil for the main window: it restores the
// shared last agent).
func (a *App) attach(w application.Window, boot *core.BootSpec) {
	engine, err := core.NewEngine(core.EngineConfig{
		ExtensionPath: resolveExtensionPath(),
		SelfPath:      selfPath(),
		PickDir:       a.pickDirFor(w),
		Emit:          a.emitTo(w),
		Boot:          boot,
	})
	if err != nil {
		log.Printf("coconut: engine init failed: %v", err)
		return
	}
	entry := &windowEntry{window: w, engine: engine, pollStop: make(chan struct{})}
	// Tear down this window's engine when it closes (macOS maps
	// WindowShouldClose → WindowClosing; the hook fires for user closes;
	// a full app quit is covered by shutdown()).
	w.RegisterHook(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		a.detach(entry)
	})
	go engine.Run(context.Background())
	go a.pollWindowState(w, entry)
	a.mu.Lock()
	a.entries[w.ID()] = entry
	a.mu.Unlock()
}

// detach stops the window's engine and drops the entry. Idempotent.
func (a *App) detach(entry *windowEntry) {
	entry.detachOnce.Do(func() {
		close(entry.pollStop)
		if entry.engine != nil {
			entry.engine.Shutdown()
		}
		a.mu.Lock()
		delete(a.entries, entry.window.ID())
		a.mu.Unlock()
	})
}

func (a *App) entryFor(w application.Window) *windowEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.entries[w.ID()]
}

// shutdown is called when the app is quitting: tear down every window.
func (a *App) shutdown() {
	a.mu.Lock()
	entries := make([]*windowEntry, 0, len(a.entries))
	for _, e := range a.entries {
		entries = append(entries, e)
	}
	a.mu.Unlock()
	for _, e := range entries {
		a.detach(e)
	}
}

// windowFromCtx extracts the calling window from the bound-method ctx.
func windowFromCtx(ctx context.Context) (application.Window, bool) {
	w, ok := ctx.Value(application.WindowKey).(application.Window)
	return w, ok
}

func notReady(commandID string) string {
	b, _ := json.Marshal(protocol.ErrResponse(commandID, "not_ready", "backend not initialized"))
	return string(b)
}

// Command routes a serialized command envelope: manager-level commands
// (window.new) are handled here; everything else goes to the calling
// window's engine. Domain errors are reported in-envelope; the Go error
// return is never used for domain failures.
func (a *App) Command(ctx context.Context, reqJSON string) string {
	w, ok := windowFromCtx(ctx)
	if !ok {
		return `{"type":"command_response","ok":false,"error":{"code":"not_ready","message":"no calling window"}}`
	}
	var head struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(reqJSON), &head); err == nil && head.Name == protocol.CmdWindowNew {
		return a.handleWindowNew(ctx, reqJSON)
	}
	entry := a.entryFor(w)
	if entry == nil {
		return notReady(head.ID)
	}
	return string(entry.engine.HandleCommand([]byte(reqJSON)))
}

// RequestSnapshot returns the calling window's engine snapshot envelope,
// tagged with windowName so the frontend can filter out events sent to
// other windows (v3 broadcasts custom events app-wide; sender = window
// name is the only discriminator).
func (a *App) RequestSnapshot(ctx context.Context) string {
	w, ok := windowFromCtx(ctx)
	if !ok {
		return `{"type":"snapshot","seq":0,"state":{}}`
	}
	entry := a.entryFor(w)
	if entry == nil {
		return `{"type":"snapshot","seq":0,"state":{}}`
	}
	raw := entry.engine.RequestSnapshot()
	var snap map[string]any
	if err := json.Unmarshal(raw, &snap); err != nil {
		return string(raw)
	}
	snap["windowName"] = w.Name()
	b, err := json.Marshal(snap)
	if err != nil {
		return string(raw)
	}
	return string(b)
}

// handleWindowNew (command window.new) opens a sibling window booted to
// the given agent in the given workspace (same or different from the
// caller's). The new window's first session.restore consumes the BootSpec
// instead of the shared last agent.
func (a *App) handleWindowNew(ctx context.Context, reqJSON string) string {
	var env struct {
		ID  string          `json:"id"`
		P   json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(reqJSON), &env); err != nil {
		return notReady("")
	}
	var p protocol.WindowNewPayload
	if err := json.Unmarshal(env.P, &p); err != nil || p.Workspace == "" || p.AgentSlug == "" {
		return notReady(env.ID)
	}
	title := p.AgentName
	if title == "" {
		title = "coconut"
	}
	a.mu.Lock()
	a.winCounter++
	name := fmt.Sprintf("win-%d", a.winCounter)
	a.mu.Unlock()
	w := a.wails.Window.NewWithOptions(windowOptions(title, name))
	a.attach(w, &core.BootSpec{
		WorkspacePath: p.Workspace,
		AgentSlug:     p.AgentSlug,
		AgentName:     p.AgentName,
		SessionFile:   p.SessionFile,
	})
	b, _ := json.Marshal(protocol.OKResponse(env.ID, map[string]any{"windowId": w.ID()}))
	return string(b)
}

// windowOptions is the shared window chrome (main + sibling windows).
// name must be UNIQUE per window: it is the event sender tag used for
// per-window event filtering on the frontend.
func windowOptions(title, name string) application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		URL:            "/",
		Name:           name,
		Title:          title,
		Width:          1280,
		Height:         800,
		MinWidth:       800,
		MinHeight:      500,
		BackgroundColour: application.NewRGBA(16, 16, 18, 1), // --bg #101012
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
		},
	}
}

// pollWindowState tracks macOS fullscreen transitions for one window.
// Wails exposes IsFullscreen but emits no change notification, so we poll
// on a timer and forward diffs to the engine (via its inbox) for sequenced
// delivery to the frontend.
func (a *App) pollWindowState(w application.Window, entry *windowEntry) {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	var last bool
	for {
		select {
		case <-entry.pollStop:
			return
		case <-ticker.C:
			full := w.IsFullscreen()
			if full != last {
				last = full
				entry.engine.SetWindowState(full)
			}
		}
	}
}

// emitTo returns the engine's Emit closure for one window: a single
// ordered "backend" event channel per window (event/stream/error
// envelopes), preserving the engine's seq ordering end to end.
func (a *App) emitTo(w application.Window) func(any) {
	return func(env any) {
		b, err := json.Marshal(env)
		if err != nil {
			log.Printf("coconut: marshal envelope: %v", err)
			return
		}
		// Round-trip through a plain JSON value so the event payload is a
		// native object on the frontend (v3 event callbacks receive
		// {name, data}; data is the structured payload).
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			log.Printf("coconut: unmarshal envelope: %v", err)
			return
		}
		// v3 semantics: EmitEvent returns TRUE when the event was
		// cancelled by a hook (i.e. delivery failed); false = delivered.
		if w.EmitEvent("backend", v) {
			log.Printf("coconut: emit to window %d was cancelled", w.ID())
		}
	}
}

// pickDirFor returns the native directory-picker closure attached to one
// window.
func (a *App) pickDirFor(w application.Window) func() (string, error) {
	return func() (string, error) {
		dlg := a.wails.Dialog.OpenFile().
			SetTitle("Choose a workspace folder").
			CanChooseDirectories(true).
			CanChooseFiles(false).
			AttachToWindow(w)
		path, err := dlg.PromptForSingleSelection()
		if err != nil {
			return "", err
		}
		return path, nil
	}
}

// selfPath returns the running executable path (best effort).
func selfPath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	return p
}

// resolveExtensionPath locates pi-extension/coconut.ts:
//  1. COCONUT_EXTENSION env override
//  2. next to the resolved sidecar binary (packaged builds)
//  3. walking up from the executable — covers build/bin/coconut and
//     bin/<name>.dev.app/Contents/MacOS/coconut alike
func resolveExtensionPath() string {
	if p := os.Getenv("COCONUT_EXTENSION"); p != "" {
		return p
	}
	if bin := piadapter.ResolveBinary(selfPath()); bin != "pi" {
		p := filepath.Join(filepath.Dir(bin), "coconut-extension.ts")
		if fileExists(p) {
			return p
		}
	}
	if exe := selfPath(); exe != "" {
		dir := filepath.Dir(exe)
		for i := 0; i < 6; i++ {
			p := filepath.Join(dir, "pi-extension", "coconut.ts")
			if abs, err := filepath.Abs(p); err == nil && fileExists(abs) {
				return abs
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "coconut.ts" // last resort; pi will error visibly
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
