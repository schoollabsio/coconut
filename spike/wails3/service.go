package main

import (
	"context"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Result is the uniform envelope returned by all probe methods.
type Result struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Data  string `json:"data,omitempty"`
}

// callingWindow extracts the originating window from a bound-method context
// (probe 6). Wails v3 stores it under application.WindowKey — verified in
// pkg/application/messageprocessor_call.go (processCallMethod).
func callingWindow(ctx context.Context) (application.Window, bool) {
	w, ok := ctx.Value(application.WindowKey).(application.Window)
	return w, ok
}

// App is the bound service (probe 2). The frontend calls it as window.App.<Method>.
// (v3 bindings are generated from the service type name; v2's window.go.main.App
// becomes window.App.)
type App struct{}

func NewApp() *App { return &App{} }

// Ping returns who the calling window is (probe 6).
func (a *App) Ping(ctx context.Context) *Result {
	w, ok := callingWindow(ctx)
	if !ok {
		return &Result{OK: false, Error: "no window in context (WindowKey missing)"}
	}
	return &Result{OK: true, Data: fmt.Sprintf("window=%q id=%d openWindows=%d", w.Name(), w.ID(), len(application.Get().Window.GetAll()))}
}

// OpenSecondWindow opens a second window pointing at the same asset with a
// query param (probe 4).
func (a *App) OpenSecondWindow(ctx context.Context) *Result {
	app := application.Get()
	if _, exists := app.Window.Get("second"); exists {
		return &Result{OK: false, Error: "window 'second' is already open"}
	}
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		URL:       "/?window=second",
		Name:      "second",
		Title:     "coconut v3 spike — second",
		Width:     900,
		Height:    600,
		MinWidth:  600,
		MinHeight: 400,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInsetUnified,
		},
	})
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		log.Println("spike: WindowClosing hook fired on second —", e)
	})
	return &Result{OK: true, Data: "opened window 'second'"}
}

// CloseThisWindow closes the calling window (probe 5).
func (a *App) CloseThisWindow(ctx context.Context) *Result {
	w, ok := callingWindow(ctx)
	if !ok {
		return &Result{OK: false, Error: "no window in context"}
	}
	w.Close()
	return &Result{OK: true, Data: fmt.Sprintf("closed window %q", w.Name())}
}

// PickDirectory opens a native directory picker attached to the calling
// window (probe 8).
func (a *App) PickDirectory(ctx context.Context) *Result {
	dlg := application.Get().Dialog.OpenFile().
		SetTitle("Pick a directory (spike)").
		CanChooseDirectories(true).
		CanChooseFiles(false)
	if w, ok := callingWindow(ctx); ok {
		dlg = dlg.AttachToWindow(w)
	}
	path, err := dlg.PromptForSingleSelection()
	if err != nil {
		return &Result{OK: false, Error: err.Error()}
	}
	if path == "" {
		return &Result{OK: true, Data: "(cancelled)"}
	}
	return &Result{OK: true, Data: path}
}

// EmitToCaller sends a "backend" event only to the calling window (probe 3a).
func (a *App) EmitToCaller(ctx context.Context, msg string) *Result {
	w, ok := callingWindow(ctx)
	if !ok {
		return &Result{OK: false, Error: "no window in context"}
	}
	if !w.EmitEvent("backend", map[string]any{"text": msg, "scope": "caller"}) {
		return &Result{OK: false, Error: "EmitEvent returned false"}
	}
	return &Result{OK: true, Data: fmt.Sprintf("emitted to %q only", w.Name())}
}

// Broadcast sends a "backend" event to ALL windows (probe 3b).
func (a *App) Broadcast(msg string) *Result {
	application.Get().Event.Emit("backend", map[string]any{"text": msg, "scope": "broadcast"})
	return &Result{OK: true, Data: "broadcast to all windows"}
}

// ToggleFullscreen toggles fullscreen on the calling window (probe 7b).
func (a *App) ToggleFullscreen(ctx context.Context) *Result {
	w, ok := callingWindow(ctx)
	if !ok {
		return &Result{OK: false, Error: "no window in context"}
	}
	w.ToggleFullscreen()
	return &Result{OK: true, Data: fmt.Sprintf("fullscreen now: %v", w.IsFullscreen())}
}
