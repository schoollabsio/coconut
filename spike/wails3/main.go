// Package main is a minimal Wails v3 spike for the coconut multi-window plan.
//
// It validates, on wails v3.0.0-beta.19 (see go.mod):
//
//  1. application.New + app.Run() lifecycle (probe 1)
//  2. service binding via Options.Services (probe 2)
//  3. per-window event emit vs app-wide emit (probe 3)
//  4. opening a second window with a URL query param (probe 4)
//  5. closing a window + WindowClosing hook (probe 5)
//  6. identifying the calling window inside a bound method (probe 6)
//  7. macOS hidden title bar parity (probe 7)
//  8. native directory picker (probe 8)
//  9. dev loop via wails3 dev (probe 9)
// 10. packaging via wails3 build (probe 10)
//
// This module is THROWAWAY: it is not part of the coconut build.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed assets
var assets embed.FS

func main() {
	svc := NewApp()

	app := application.New(application.Options{
		Name:     "coconut-v3-spike",
		Assets:   application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services: []application.Service{application.NewService(svc)},
		OnShutdown: func() {
			log.Println("spike: OnShutdown fired (probe 1)")
		},
	})

	// Probe 7: macOS chrome parity (hidden title bar, traffic lights).
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		URL:       "/",
		Name:      "main",
		Title:     "coconut v3 spike — main",
		Width:     1100,
		Height:    750,
		MinWidth:  720,
		MinHeight: 480,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInsetUnified,
		},
	})

	// Probe 5: window lifecycle hook.
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		log.Println("spike: WindowClosing hook fired on main —", e)
	})

	log.Println("spike: entering app.Run() (probe 1)")
	if err := app.Run(); err != nil {
		log.Fatal("app.Run: ", err)
	}
}
