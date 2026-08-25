# GSV App SDK Contract

This directory is the first agent-first app/window contract for `gateway-os/ui`.

Search anchors:

- `defineAppManifest`
- `defineGsvAppElement`
- `AppElementContext`
- `context.window.openApp`
- `context.window.close`
- `context.thread.current`
- `context.thread.subscribe`
- `context.thread.activate`
- `resolveWorkspaceRootPath`
- `context.kernel.request`

## Runtime Model

- An **app** is a manifest plus a component entrypoint.
- A **window** is the managed desktop container for that app.
- A **thread** is the active task/process binding: `pid`, `workspaceId`, `cwd`.
- A **workspace** is durable storage. When a thread has `workspaceId`, its root path is `/workspaces/{workspaceId}`.

Current contract:

- apps are window-first UI surfaces
- the current desktop runtime is singleton-per-app-id
- apps do not own backend runtimes yet
- future app-owned runtimes can attach later through the `app` process profile

## App Element Context

Component apps receive `AppElementContext` in `gsvMount(context)`.

Available fields:

- `context.manifest`: validated manifest
- `context.windowId`: stable managed window id
- `context.window`: window client for open/focus/close/minimize/maximize/restart
- `context.kernel`: syscall-scoped kernel client
- `context.theme`: desktop theme snapshot/subscription client
- `context.thread`: active thread client

`context.thread.current()` returns:

- `pid`
- `workspaceId`
- `cwd`
- `workspace`
- `workspace.id`
- `workspace.rootPath`

## Authoring Rules

- Use `permissions` for product-facing capability labels.
- Use `syscalls` for the enforced kernel allowlist.
- Derive workspace paths from `context.thread.current()` or `resolveWorkspaceRootPath()`.
- Use `context.window.openApp("files")` or `context.window.openApp("shell")` for companion windows on the same thread.
- Only call `context.thread.activate(...)` when the app is intentionally changing the desktop's active thread.
- Do not assume a Dynamic Workers app runtime exists yet.

## Example Files

- [examples/component-minimal.example.ts](./examples/component-minimal.example.ts)
- [examples/window-open.example.ts](./examples/window-open.example.ts)
- [examples/workspace-read.example.ts](./examples/workspace-read.example.ts)
