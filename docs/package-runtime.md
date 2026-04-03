# package runtime model

This document locks the package runtime model for GSV.

## invariants

- Every installed package has a Dynamic Worker artifact.
- Every installed package has exactly one Package DO.
- Package UI is served as HTTP under `/apps/<package-name>/*`.
- The desktop shell is only a launcher/window manager. It does not own app code.
- A package may spawn agent/process DOs for its own logic, but those are children of the package runtime, not the package state container itself.

## identity split

Package runtime has two identities with different lifetimes:

- Stable package state identity:
  - keyed by package name plus install scope
  - used for the Package DO
  - must survive package upgrades
- Versioned code identity:
  - keyed by resolved artifact hash
  - used for Dynamic Worker loading/caching
  - changes whenever package code changes

This is the key rule:

- Package DO identity must not include package version or artifact hash.

Otherwise a package upgrade would silently lose SQLite and alarm-backed state.

## routing model

- Browser requests `/apps/<package-name>/*`
- Kernel verifies session/auth
- Kernel resolves the installed package record
- Kernel loads or reuses the package Dynamic Worker for the resolved artifact
- Kernel injects granted bindings
- Request is forwarded to the package worker

## default bindings

Every package gets these bindings:

- `PACKAGE`
  - narrow package-state binding backed by its own Package DO
  - stable across version bumps
  - first surface is SQL-style methods such as `sqlExec(...)` and `sqlQuery(...)`
- `KERNEL`
  - narrow kernel RPC surface, only for explicitly granted capabilities

Additional bindings such as `FS` can be granted explicitly by package policy.

## package do responsibilities

The Package DO is the durable state root for a package install.

Typical responsibilities:

- SQLite-backed app state
- alarms / scheduled maintenance
- package-local caches and indexes
- issuing package-owned agent/process work
- upgrade/migration bookkeeping across package versions

## ui model

UI packages are web apps, not built-in desktop components.

- Package worker serves HTML/CSS/JS
- Desktop shell opens package UI in a managed window
- The intended host model is iframe-backed windows

## host bridge model

Browser-side package UI must not open its own gateway connection.

- The desktop shell owns the single browser websocket session.
- Package UI talks to a runtime-provided `HOST` bridge.
- `HOST` is runtime-agnostic and may be implemented by:
  - the web desktop shell via iframe messaging
  - a CLI daemon host via webview IPC such as `wry`
- Package UI should target the `HOST` contract, not browser-specific globals.

The initial `HOST` contract is:

- `getStatus()`
- `onStatus(listener)`
- `onSignal(listener)`
- `request(syscall, args)`
- `spawnProcess(args)`
- `sendMessage(message, pid?)`
- `getHistory(limit, pid?, offset?)`

Important boundary:

- `HOST` is an app-facing transport bridge.
- `KERNEL` is a trusted server-side package worker binding.
- These are different layers and should not be collapsed into one abstraction.

## app frame model

Package app execution is frame-native, matching the existing GSV protocol.

- The underlying runtime is still a raw Dynamic Worker.
- The package authoring surface should be a thin GSV SDK on top of that worker runtime.
- Request-scoped package bindings receive an `AppFrameContext` through binding props.
- Package code should not handle signed auth tokens or session cookies directly.

## kernel binding model

The package-facing `KERNEL` binding is a narrow frame bridge, not a raw kernel object.

- V1 surface: `request(call, args)`
- V1 scope: kernel-native req/res syscalls only
- V1 limitation: no device-routed async flows yet
- Kernel must still re-check package syscall allowlists and user capabilities on every request

This is intentionally smaller than the full GSV protocol surface because the current service-binding path only supports synchronous req/res handling.

## future async app routing

Package apps should eventually become first-class frame endpoints.

- The kernel routing table needs an `app` origin alongside `connection` and `process`.
- Once that exists, package apps can receive async `res` and `sig` frames.
- That is the point where the SDK should grow an `onSignal(...)` hook.
- Package authors should not deal with raw response-correlation tables directly; the SDK/runtime should own that plumbing.

## source model

The current builtin seed path may embed source directly in package definitions as a bootstrap step, but that is not the intended long-term source of truth.

- There is one package source model: ripgit-backed source addressed as `repo + ref + subdir`.
- Builtin packages, local edits, and third-party installs all use that same model.
- Third-party installs should be cloned into ripgit, then treated exactly like any other package source.
- Builtin packages can track an official branch that mirrors the main GSV repository.
- User or process-local package changes should create/select ripgit branches rather than mutating opaque blobs.
- Package install records should keep both the requested `ref` and the resolved commit used to build the active artifact.
- R2 can still hold archives or exports, but ripgit should be the low-latency path for live package source.

## shared runtime assets

The shell should keep shared runtime assets deliberately small and stable.

- `/runtime/theme.css` is the first shared asset for package apps.
- Package apps should import it directly rather than depending on shell-internal UI CSS.
- Additional shared assets, such as a `HOST` bridge helper, can be added later without coupling apps to the shell bundle.

## scope

The first implementation can treat packages as global installs.

When scoped installs are added later, Package DO identity should become:

- global: `package:<name>`
- user: `package:<name>:user:<uid>`
- workspace: `package:<name>:workspace:<workspace-id>`

The scope key remains stable across upgrades.

## next implementation steps

1. Introduce request-scoped `AppFrameContext` injection for `PACKAGE` and `KERNEL`.
2. Add a real `KERNEL.request(call, args)` path for kernel-native req/res syscalls.
3. Keep the `HOST` bridge contract runtime-agnostic across web and daemon hosts.
4. Resolve package source from ripgit repositories instead of inline seed blobs.
5. Keep expanding shared runtime assets conservatively beyond `theme.css`.
6. Add an `app` route origin later for async `res` and `sig` delivery.
