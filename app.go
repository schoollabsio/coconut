package main

import (
	"context"
	"sync"

	"github.com/jschool/custard/internal/core"
)

// App is the Wails-bound application facade. It exposes a minimal,
// protocol-pure surface to the frontend:
//
//	Command(reqJSON) string         — command envelope in, response envelope out
//	RequestSnapshot() string        — snapshot envelope out
//	PickDirectory() string          — native directory picker
//
// All backend → frontend traffic flows through the single ordered wails
// event channel "backend", carrying serialized event envelopes.
type App struct {
	ctx  context.Context
	core *core.Engine

	mu sync.Mutex
}

func NewApp() *App {
	return &App{}
}

// startup is called when the app has started, after the frontend loads.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// TODO(task 8): construct core.Engine, piadapter, wire event fan-out.
}

// shutdown is called when the app is closing.
func (a *App) shutdown(ctx context.Context) {
	// TODO(task 8): stop sidecar, flush settings.
}

// Command accepts a serialized command envelope and returns a serialized
// command_response envelope. Domain errors are reported in-envelope.
func (a *App) Command(reqJSON string) string {
	// TODO(task 8): route through core.Engine.
	return `{"type":"command_response","ok":false,"error":{"code":"not_ready","message":"backend not wired yet"}}`
}

// RequestSnapshot returns a serialized snapshot envelope.
func (a *App) RequestSnapshot() string {
	// TODO(task 8): route through core.Engine.
	return `{"type":"snapshot","seq":0,"state":{}}`
}

// PickDirectory opens a native directory picker and returns the chosen path
// (empty string if cancelled).
func (a *App) PickDirectory() string {
	// TODO(task 8): runtime.OpenDirectoryDialog
	return ""
}
