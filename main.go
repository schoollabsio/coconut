package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "custard",
		Width:     1280,
		Height:    800,
		MinWidth:  800,
		MinHeight: 500,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 16, G: 16, B: 18, A: 1}, // --bg #101012
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Mac: &mac.Options{
			// VSCode/Zed look: no native titlebar; traffic lights float
			// over the content, which extends to the window's top edge.
			// The frontend header is the drag region (--wails-draggable).
			TitleBar:   mac.TitleBarHidden(),
			Appearance: mac.NSAppearanceNameDarkAqua,
		},
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
