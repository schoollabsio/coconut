package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var distAssets embed.FS

func main() {
	// The embedded FS is rooted at the repo; serve the built frontend from
	// its dist subdirectory (index.html at the fs root).
	dist, err := fs.Sub(distAssets, "frontend/dist")
	if err != nil {
		log.Fatal("coconut: assets: ", err)
	}

	// App is the window manager: each window (main + siblings) gets its
	// own engine, event channel, and dialog attachment. It is created
	// before the wails app so it can be listed in Services.
	app := NewApp(nil)

	wailsApp := application.New(application.Options{
		Name: "coconut",
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(dist),
		},
		Services:   []application.Service{application.NewService(app)},
		OnShutdown: app.shutdown,
	})
	app.Bind(wailsApp)

	// VSCode/Zed look: no native titlebar; traffic lights float over the
	// content, which extends to the window's top edge. The frontend header
	// is the drag region (--wails-draggable).
	win := wailsApp.Window.NewWithOptions(windowOptions("coconut", "main"))
	app.attach(win, nil) // main window: restore the shared last agent

	if err := wailsApp.Run(); err != nil {
		log.Fatal("coconut: ", err)
	}
}
