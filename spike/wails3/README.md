# Wails v3 spike (THROWAWAY)

Validates the v3 APIs the coconut multi-window plan (Option C) depends on,
pinned to `wails v3.0.0-beta.19`. Separate Go module — not part of the
coconut build.

## Run

```sh
export PATH="/tmp/wails3bin:$PATH"   # wails3 CLI installed during spike setup
cd spike/wails3
go mod tidy                          # first time only
wails3 generate bindings -d assets/bindings -b   # (already done; re-run if service changes)
wails3 dev                           # probe 9: dev loop
# or, without the CLI (embedded assets, no dev server needed):
go run .
```

**`wails3 dev` needs `build/config.yml`** (v3 requirement — the watcher
config). It is included: rebuilds the binary on Go changes and runs it. Since
`wails3 dev` sets `FRONTEND_DEVSERVER_URL=http://localhost:9245` and proxies
all asset requests there, the config also starts a static server for `assets/`
on 9245 (python3). `go run .` skips all of that and serves the embedded assets
directly — use it if you just want the window.

## v2 → v3 API map (confirmed against beta.19 source)

| Concern | v2 (coconut today) | v3 (beta.19) |
|---|---|---|
| App create/run | `options.App{...}` + `wails.Run(ctx, opts)` | `application.New(Options{...})` → `app.Window.NewWithOptions(...)` → `app.Run()` |
| Service binding | `Bind: []any{&App{}}` | `Services: []application.Service{application.NewService(&App{})}` |
| Frontend call | `window.go.main.App.Command(req)` | generated ES module: `import { App } from "./bindings/…/index.js"` → `App.Command(req)` |
| Frontend runtime | `window.runtime.EventsOn("backend", cb)` | `import { Events } from "/wails/runtime.js"` → `Events.On("backend", ev => …)` — cb gets `{name, data}` |
| Event emit (Go) | `runtime.EventsEmit(ctx, "backend", env)` (app-wide) | per-window: `window.EmitEvent("backend", env)`; app-wide: `app.Event.Emit("backend", env)` |
| Calling window | n/a (single window) | `ctx.Value(application.WindowKey).(application.Window)` in bound methods (set in messageprocessor_call.go) |
| New window | ❌ none | `app.Window.NewWithOptions(WebviewWindowOptions{URL, Name, Title, …, Mac: MacWindow{TitleBar: MacTitleBarHiddenInsetUnified}})` |
| Window lookup | n/a | `app.Window.Get(name) (Window, bool)`, `GetByID(id)`, `GetAll()`, `Current()` |
| Window close hook | n/a | `window.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent))` |
| Mac chrome | `Mac: options.Mac{TitleBarHidden: true}` | `Mac: MacWindow{TitleBar: MacTitleBarHidden}` / `MacTitleBarHiddenInsetUnified` (presets) |
| Fullscreen | `runtime.WindowIsFullscreen(ctx)` (poll) | `window.IsFullscreen()`, `window.ToggleFullscreen()` |
| Directory dialog | `runtime.OpenDirectoryDialog` | `app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).AttachToWindow(w).PromptForSingleSelection()` |
| Global app | n/a | `application.Get() *App` |
| npm runtime | none (injected globals) | `@wailsio/runtime@3.0.0-beta.19` (or served `/wails/runtime.js` with `-b` bindings) |

## Probe checklist

| #   | Probe                          | How to verify                                                                                     |
|-----|--------------------------------|---------------------------------------------------------------------------------------------------|
| 1   | App lifecycle                  | App opens; `OnShutdown` logs on quit                                                              |
| 2   | Service binding                | **Ping** button returns a JSON result                                                             |
| 3a  | Per-window events              | **Emit to caller only** appears ONLY in this window's log                                         |
| 3b  | App-wide events                | **Broadcast to all** appears in BOTH windows' logs                                                |
| 4   | Second window                  | **Open 2nd window** opens a 2nd window whose header shows `query: second`                          |
| 5   | Window close                   | **Close this window** closes it; `WindowClosing` hook logs; app keeps running with the other window |
| 6   | Calling window id              | **Ping** from each window returns its own name/id                                                 |
| 7   | Mac chrome + fullscreen        | Hidden title bar + traffic lights on both windows; **Toggle fullscreen** works per-window          |
| 8   | Directory dialog               | **Pick directory** shows the native picker and returns the path                                    |
| 9   | Dev loop                       | `wails3 dev` starts, rebuilds on Go change                                                         |
| 10  | Packaging                      | `wails3 build` produces a runnable `.app`                                                         |

## Findings

- **P2 (compile)**: spike compiles clean against `v3.0.0-beta.19` (linker warnings cosmetic).
- **Bindings**: `wails3 generate bindings -d assets/bindings -b` produces ES modules under
  `assets/bindings/<go-module-path>/` importing `/wails/runtime.js` (bundled) or
  `@wailsio/runtime` (npm). Coconut Phase 1 will use the npm variant (Vite can bundle it).
- **Events**: v3 frontend callbacks receive `WailsEvent {name, data}` — store.ts's
  `applyBackendMessage` will need `msg = ev.data` (one-line change at the boundary).
- **Window routing**: confirmed `ctx.Value(application.WindowKey)` carries the calling
  `Window` — the `windowId` protocol workaround may be UNNECESSARY.

(Run the GUI probes and fill in the checklist above.)
