# App SDK (Web UI)

`src/app-sdk/` defines the standard app contract for GSV desktop apps.

Canonical contract and examples live at:

- [src/app-sdk/README.md](./src/app-sdk/README.md)
- [src/app-sdk/examples/component-minimal.example.ts](./src/app-sdk/examples/component-minimal.example.ts)
- [src/app-sdk/examples/window-open.example.ts](./src/app-sdk/examples/window-open.example.ts)
- [src/app-sdk/examples/workspace-read.example.ts](./src/app-sdk/examples/workspace-read.example.ts)

## Manifest

Use `defineAppManifest()` with:

- `id`, `name`, `description`
- `iconId`
- `entrypoint`
  - `legacy` (existing adapter path), or
  - `component` with custom element `tagName`
- `permissions` (user-facing product capabilities)
- `syscalls` (enforced kernel client allowlist for the app)
- `windowDefaults`

## Component Lifecycle

Component apps are custom elements with optional hooks:

- `gsvMount(context)`
- `gsvSuspend()`
- `gsvResume()`
- `gsvUnmount()`

`context` includes:

- `windowId`
- `window`
- `manifest`
- `kernel` (scoped client)
- `theme` (token snapshots + subscription)
- `thread` (active thread snapshot + subscription)

## Scoped Kernel Client

`createScopedKernelClient()` limits app requests to `manifest.syscalls`.

- Supports exact permissions (`proc.send`)
- Domain wildcard (`fs.*`)
- Global wildcard (`*`)

## Theme Tokens

Apps should consume `--gsv-*` tokens via `theme.snapshot()`/`theme.subscribe()`.
Theme changes emit `window` event `gsv:theme-change`.

## Window + Thread Primitives

- `context.window.openApp(appId)` opens a companion app against the current thread.
- `context.window.close()` closes the current managed window.
- `context.thread.current()` returns `pid`, `workspaceId`, `cwd`, and `workspace.rootPath`.
- `context.thread.subscribe(listener)` tracks thread changes without reading launcher globals.
