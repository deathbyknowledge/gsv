# Web UI State Inventory

This inventory maps the current `web/src` state surfaces before the Preact
rewrite. The goal is to choose state ownership deliberately instead of turning
the current imperative modules into one large context tree.

## State Strategy

Use three state lanes:

1. **Gateway server state**: data fetched from syscalls and owned by the
   Gateway, Process DOs, AppRunner, or Kernel SQLite.
   Use TanStack Query (`@tanstack/preact-query`) for caching, request
   deduplication, mutation state, invalidation, and stale reads.
2. **Live runtime state**: WebSocket connection status, process run streams,
   app iframe bridge state, recorder/audio state, window drag/resize, animations,
   and timers.
   Use feature hooks, reducers, and small service stores. Do not put this in
   Query.
3. **UI preference and layout state**: selected app, palette open state,
   persisted window layout, voice preferences, setup drafts, and session tokens.
   Keep local to the owning feature, with small storage utilities for durable
   values.

Use Context only for stable dependencies and narrow state owners:

- `GatewayProvider`: transport/syscall/signal services.
- `SessionProvider`: auth/session lifecycle and current identity.
- `QueryClientProvider`: server-state cache.
- Optional `DesktopProvider`: window manager actions and summaries if the shell
  stays desktop/window based.

Avoid a global `AppStateContext` containing packages, windows, processes,
notifications, session, recorder state, and settings together.

## Current Surface Map

| Surface | Current files | State kind | Recommended owner |
|---|---|---|---|
| Gateway transport | `gateway-client.ts` | WebSocket, pending requests, and signals | Keep as a single focused `client.ts`/client service while the app migrates; expose through `GatewayProvider`. |
| Session/auth | `session-service.ts`, `session-ui.ts`, `onboarding-service.ts` | Token persistence, reconnect timers, setup mode, setup draft | Keep as `SessionProvider` plus `features/session` and `features/onboarding`; not Query except setup/bootstrap mutations. |
| Package app registry | `app/features/packages/usePackageApps.ts`, `app/features/packages/packageApps.ts`, `app/features/desktop/domain/desktopApp.ts` | `pkg.list` derived into shell desktop apps | TanStack Query key `["packages", "list", filters]`; derive desktop apps with pure domain helper; invalidate on `pkg.changed`. |
| App sessions and iframes | `app/features/desktop/runtime/appsRuntime.ts`, `app/features/desktop/runtime/host/hostBridge.ts`, `app/features/desktop/runtime/appLoading.ts` | `app.open`, `app.detach`, iframe lifecycle, host bridge, loader animation | Use Query mutations for `app.open`/detach/close if helpful; keep iframe lifecycle in desktop runtime services. |
| Desktop windows | `app/features/desktop/DesktopShellFrame.tsx`, `window-manager.ts`, `launcher.ts` | Static desktop frame, open windows, focus, z-index, drag, resize, persisted layout, command palette | Keep the shell frame in Preact. Keep window state local to `features/desktop`; persist layout via utility. Not Query. |
| Notifications | `app/features/notifications/NotificationsPanel.tsx`, `service-worker.ts` | `notification.list`, mark read/dismiss mutations, pushed updates, toasts, permission state | TanStack Query for list and mutations; signal updater for `notification.created/updated/dismissed`; local state for panel open, toast timers, browser notification permission. |
| Presence/voice | `app/features/presence/*` | recorder state, VAD, run signal buffering, transcription, speech synthesis/playback, preferences | Controller now delegates pure browser audio, speech text, signal parsing, timing, preferences, and display helpers. Next split: recorder/transcription/speech playback controllers or hooks. |
| Process chat/run state | `app/features/presence/presenceControl.ts`, gateway client helpers | `proc.send`, `proc.run.*` streams, HIL, latest activity | For full chat/process UI, use Query for `proc.list`, `proc.history`, `proc.conversation.*`; use signal reducer for active run streams. |
| Browser target | removed | In-site target registration, browser filesystem, window automation, transfer syscalls | Removed from the web shell. Whole-browser targeting belongs to the browser extension. |
| Preview windows | `preview-window.ts`, `window-manager.ts` | Object URLs and transient preview content | Keep local to desktop/window feature; ensure object URL cleanup. |
| Package app SDK shim | removed | Old local manifest shim for legacy/in-shell apps | Installed package iframes use platform app sessions. Package-author SDKs live in `@humansandmachines/gsv/sdk`. |

## Query Candidates

Start with these query keys:

```ts
["packages", "list", { enabled, runtime, name }]
["notifications", "list", { includeRead, includeDismissed }]
["devices", "list", { includeOffline }]
["processes", "list", { uid }]
["process", pid, "conversations", { includeClosed }]
["process", pid, "history", conversationId, page]
["process", pid, "segments", conversationId]
["app-sessions", "list"]
["config", key]
["adapters", adapter, "status", accountId]
["schedules", "list", filters]
["repos", "list", { owner }]
```

Recommended invalidation sources:

- `pkg.changed` -> `["packages"]`
- `notification.created`, `notification.updated`, `notification.dismissed` ->
  `["notifications"]` or direct cache update by notification id
- `proc.changed` -> affected `["processes"]`, conversations, and history keys
- `proc.run.*` -> active run reducer; optionally reconcile history on finish
- `device.status` -> `["devices"]`
- `adapter.status` -> `["adapters"]`

## Context Boundaries

Suggested providers:

```text
AppProviders
|-- GatewayProvider
|-- SessionProvider
|-- QueryClientProvider
`-- DesktopProvider
```

`GatewayProvider` should expose stable services:

- `request(call, args)`
- `connect/disconnect`
- `status`
- `signals.subscribe`

`SessionProvider` should expose:

- phase, identity, username, connection info
- login, setup, continue, lock
- token refresh/reconnect behavior

`DesktopProvider` should expose:

- app registry as input from package query
- window summaries
- open/focus/minimize/maximize/close actions
- persisted layout operations

Do not pass TanStack Query results through these contexts. Components should use
query hooks directly for server state.

## Migration Order

1. Add Preact and TanStack Query dependencies.
2. Create `web/src/app/` with providers, service boundaries, and a thin root
   component.
3. Extract Gateway transport without changing behavior.
4. Move `pkg.list` app registry to a package query and keep the existing
   window/launcher code temporarily.
5. Convert the static desktop shell frame to Preact while preserving legacy
   window, launcher, session, and presence managers.
6. Convert notifications to Query and JSX components. This is a contained
   server-state feature and a good proving ground.
7. Move session/onboarding to components and hooks, preserving the current
   setup flow.
8. Split desktop/window/launcher state into a reducer-backed feature.
9. Keep browser targeting out of the web shell; the browser extension owns that
   target surface.
10. Split presence into recorder, transcription, speech, and run-activity hooks.
11. Split CSS by feature after markup ownership is stable.

## Open Decisions

- Whether the desktop/window shell remains the primary product shell, or the web
  UI becomes a more direct console with package app launching as a secondary
  surface.
- Whether process chat belongs in the web shell, the consolidated `gsv` builtin
  app, or both.
- Whether app-host networking should move to a dedicated browser worker after
  the transport boundary is clean.
