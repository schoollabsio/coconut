package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/jschool/coconut/internal/core"
	"github.com/jschool/coconut/internal/piadapter"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails-bound application facade. The surface is
// protocol-pure by design:
//
//	Command(reqJSON) string  — command envelope in, response envelope out
//	RequestSnapshot() string — snapshot envelope out
//
// All backend → frontend traffic flows through the single ordered wails
// event channel "backend" (serialized event/stream/error envelopes),
// preserving the global sequence ordering from PLAN.md §8.4.
type App struct {
	ctx    context.Context
	engine *core.Engine
}

func NewApp() *App {
	return &App{}
}

// startup is called after the frontend loads.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	engine, err := core.NewEngine(core.EngineConfig{
		ExtensionPath: resolveExtensionPath(),
		SelfPath:      selfPath(),
		PickDir:       a.pickDir,
		Emit:          a.emit,
	})
	if err != nil {
		log.Printf("coconut: engine init failed: %v", err)
		return
	}
	a.engine = engine
	go engine.Run(ctx)
	go a.pollWindowState(ctx)
}

// pollWindowState tracks macOS fullscreen transitions. Wails' runtime
// exposes WindowIsFullscreen but emits no change notification, so we poll
// on a timer and forward diffs to the engine (via its inbox) for
// sequenced delivery to the frontend.
func (a *App) pollWindowState(ctx context.Context) {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	var last bool
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if a.engine == nil {
				return
			}
			fs := runtime.WindowIsFullscreen(a.ctx)
			if fs != last {
				last = fs
				a.engine.SetWindowState(fs)
			}
		}
	}
}

// shutdown is called when the app is closing.
func (a *App) shutdown(ctx context.Context) {
	if a.engine != nil {
		a.engine.Shutdown()
	}
}

// Command routes a serialized command envelope through the engine.
// Domain errors are reported in-envelope; the Go error return is never
// used for domain failures.
func (a *App) Command(reqJSON string) string {
	if a.engine == nil {
		return `{"type":"command_response","ok":false,"error":{"code":"not_ready","message":"backend not initialized"}}`
	}
	return string(a.engine.HandleCommand([]byte(reqJSON)))
}

// RequestSnapshot returns a serialized snapshot envelope.
func (a *App) RequestSnapshot() string {
	if a.engine == nil {
		return `{"type":"snapshot","seq":0,"state":{}}`
	}
	return string(a.engine.RequestSnapshot())
}

// emit serializes an envelope onto the single ordered backend channel.
func (a *App) emit(env any) {
	if a.ctx == nil {
		return
	}
	b, err := json.Marshal(env)
	if err != nil {
		log.Printf("coconut: marshal envelope: %v", err)
		return
	}
	runtime.EventsEmit(a.ctx, "backend", string(b))
}

// pickDir opens the native directory picker on the app context.
func (a *App) pickDir() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose a workspace folder",
	})
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
//  3. repo layout: <repo>/pi-extension/coconut.ts relative to the
//     dev binary in build/bin/
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
		// build/bin/coconut → <repo>/pi-extension/coconut.ts
		p := filepath.Join(filepath.Dir(exe), "..", "..", "pi-extension", "coconut.ts")
		if abs, err := filepath.Abs(p); err == nil && fileExists(abs) {
			return abs
		}
	}
	return "coconut.ts" // last resort; pi will error visibly
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
