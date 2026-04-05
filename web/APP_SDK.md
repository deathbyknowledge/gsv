# App SDK (Web UI)

`src/app-sdk/` defines the standard app contract for GSV desktop apps.

## Manifest

Use `defineAppManifest()` with:

- `id`, `name`, `description`
- `iconGlyphClass`
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
- `manifest`
- `kernel` (scoped client)
- `theme` (token snapshots + subscription)

## Scoped Kernel Client

`createScopedKernelClient()` limits app requests to `manifest.syscalls`.

- Supports exact permissions (`proc.send`)
- Domain wildcard (`fs.*`)
- Global wildcard (`*`)

## Theme Tokens

Apps should consume `--gsv-*` tokens via `theme.snapshot()`/`theme.subscribe()`.
Theme changes emit `window` event `gsv:theme-change`.

