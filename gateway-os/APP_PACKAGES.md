# App Packages

Long-term app model for `gateway-os`.

The platform should treat apps as installable **packages**, not only as desktop
windows.

Each package can expose one or more **surfaces**:

- `command`: shell/agent entrypoints that behave like installed binaries
- `renderer`: UI entrypoints that can be hosted in the desktop shell or a
  device webview

Each package may also expose a **backend**:

- `none`: no app-owned runtime
- `dynamic-worker`: package-owned runtime with explicit bindings/capabilities

## Host model

A package surface is opened by a host:

- `window`
- `shell`
- `agent`
- `webview`

`sys.app.open` resolves an app session against:

- package id
- host kind + host instance id
- selected surface
- optional thread target

That produces a host-scoped runtime session with:

- selected surface
- thread attachment, if any
- workspace attachment, if any
- backend descriptor + resolved bindings

## Backend command contract

Dynamic Worker-backed packages receive:

- `ctx.props.session`: resolved host/workspace/backend session
- `execCommand({ command })`: surface invocation payload with binary name, command
  name, and argv

Dynamic Worker binding materialization is adapter-specific:

- `kernel` binding -> `env.KERNEL.call(syscall, args)` RPC stub
- `workspace` binding -> scoped workspace metadata on `ctx.props.session.workspace`
- `thread` binding -> scoped thread metadata on `ctx.props.session.thread`
- `service` binding -> future RPC wrapper stubs around concrete Worker bindings

For shell-hosted package commands, the kernel flow is now:

1. register the package binary in the native shell host
2. resolve a package session via `sys.app.open`
3. load the package backend from `APP_BACKENDS`
4. call the backend entrypoint with the resolved session as props

## Shell command model

Package-provided shell commands should **not** execute arbitrary package code
inside the native shell host.

Instead:

1. the shell host registers a binary name from package metadata
2. the binary is a thin shim
3. the shim opens an app session for `host = shell`
4. the shim dispatches to the package backend

That keeps one runtime/capability model for:

- shell commands
- agent calls
- desktop windows
- device webviews

## Example packages

### `workspace-doctor`

- formula-like
- command surface only
- binary: `doctor`
- workspace-scoped backend
- intended hosts: `shell`, later `agent`
- current runtime: real shell shim -> Dynamic Worker `execCommand`

### `ops-console`

- cask-like
- renderer surface only
- intended hosts: `window`, `webview`
- shared backend
- current runtime: backend session descriptor scaffolded for future renderer host use

### `deploy`

- hybrid
- command surface: `deploy`
- renderer surface: `control-tower`
- intended hosts: `shell`, `window`, `webview`
- workspace-scoped backend
- current runtime: shell command backend scaffolded, renderer host still pending
