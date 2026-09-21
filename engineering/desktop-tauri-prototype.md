# Isolated Tauri prototype

Status: implementation experiment, based on `origin/main` at `e917c3f4` on
2026-09-21. This does not adopt a production Desktop cutover.

## Ownership

The app hosts the packaged, existing Instrument frontend, including Zen, its
canonical Conversation reader, Process observation, approvals, and optimistic
outbox. The JavaScript GSV client owns the sole authenticated gateway connection.
Rust does not run the GPUI conversation engine. The gateway still authorizes all
syscalls; the native bridge does not expose shell or filesystem operations.

Rust owns the transcription and vision supervisors, native input authority,
helper cancellation, window lifecycle, and a private prototype credential file.
The same supervisor source is shared with GPUI through `desktop-native`.
Microphone audio and camera frames remain in the existing helpers.

## Isolation and session lifetime

The application is `GSV Tauri Prototype`, identifier
`es.humansandmachines.gsv.tauri-prototype`, with its own application data directory.
It never reads or writes the installed Desktop's config or local IPC endpoint.
There is one configured gateway. Reconfiguration clears credentials and causes a
complete frontend teardown/reload, including session storage, query clients,
outbox, uploads, draft and terminal journals. Ordinary unsent-work warnings still
apply. User client credentials never become machine credentials.

The host validates an HTTPS origin (HTTP loopback is permitted for development),
stores credentials with that origin and a random configuration generation, and
rejects writes from earlier generations. Account identity remains in the issued
session credential. No installation ID is supplied by the client. The frontend
necessarily receives its session token because it owns authenticated transport;
host persistence protects the file boundary, not secrets from trusted app code.

Only the bundled main window can invoke explicitly listed application commands.
No remote capability, general filesystem, shell plugin, or disabled web security
is used. HTTP(S) links open in the external browser. OAuth and recovery complete
in the chosen gateway's browser UI; there is no prototype deep-link receiver.

## Input lifetime

Every mounted Zen workspace attaches a fresh native lease. The host validates the
lease, helper session, voice request, segment, sequence and event age. It keeps
replace-latest partial/status/scroll state and a bounded acknowledged lane for
semantic completion. JavaScript applies correlated text through the real composer
and submits through Zen's ordinary outbox. Sending a dictation segment never
interprets dictated text as a direct shell command.

The native watchdog revokes authority when the frontend stops acknowledging.
Unfocused operation can continue while the webview is responsive. A suspended or
heavily throttled webview cancels voice and disarms gestures; it cannot replay old
send/delete actions on return. Full minimized dictation through webview suspension
is a prototype limitation to compare on Linux/WebKitGTK and macOS/WKWebView.
Reload, process selection change, logout, helper failure and Quit cancel input.

## Implementation batches and shared files

1. Extract existing native supervisors without changing their helper protocols.
2. Add the isolated Tauri host, explicit command permissions, and single-gateway
   persistence. Inject URL/storage into the existing session service and reuse
   App/Instrument.
3. Add the small native-input platform seam to Zen/PromptLine, real helper state,
   gesture actions, and native lifecycle.
4. Supply user-run build/launch instructions, focused acceptance scenarios and
   an opt-in CI artifact workflow. Production releases and installers stay owned
   by their existing paths.

Likely shared-file conflicts: `App.tsx`, `AppProviders.tsx`, `sessionService.ts`,
`GatewayProvider.tsx`, `Zen.tsx`, `PromptLine.tsx`, `host/Cargo.lock`. No social,
adapter, gateway policy, prompt or standing-context work belongs in this batch.

The handoff initially deferred local verification to the user/CI. The user then
explicitly authorized local compilation and launch on 2026-09-21, with the user
acting as the testing proxy and entering their own production space. No local
test suites, lint, automated interaction or production probes are run.

Framework references: [Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[application command manifest](https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html),
[Vite integration](https://v2.tauri.app/start/frontend/vite/),
[window configuration](https://v2.tauri.app/reference/config/).
