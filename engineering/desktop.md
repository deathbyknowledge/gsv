# Desktop ownership and release

`host/apps/desktop` is the only desktop application. Its installed binary is
`gsv-desktop`, its application name is GSV, and its bundle identity is
`space.gsv.desktop`. The previous native UI and its rendering dependencies are
removed. The shared Preact Instrument source builds both the browser UI and the
embedded desktop frontend (`web/dist-desktop`).

## Boundaries

- The frontend owns the single authenticated gateway connection, canonical
  conversations, Process observation, approvals, attachments, navigation and
  retained screen state. Signals update the existing state owners.
- Rust owns window lifecycle, external browser navigation, private session
  persistence, same-user CLI control and native input supervision.
- `desktop-native` supervises `gsv-transcribe` and `gsv-vision`. Camera and audio
  capture stay local. Helpers start only after explicit user action.
- `gsvd` independently owns the machine connection. Fleet and `gsv pair` provide
  enrollment. Closing Desktop never stops an installed daemon service.

## Local control and lifecycle

`gsv desktop` launches or activates the installed app. The existing
`desktop-protocol` endpoint carries only activation, redacted status, process
selection and microphone controls. Frontend commands use a generation-scoped
channel with correlated responses. Disconnect, reload, cancellation or timeout
invalidates pending work before later UI mutations. Gateway requests remain
on the frontend's existing authenticated connection.

Only the bundled main window may invoke host commands. Remote navigation is
rejected; HTTP(S) links open in the system browser. There is no general shell,
filesystem, remote-webview or credential-export bridge.

Session writes are serialized, origin-bound and generation-fenced. Native input
has its own expiring lease, bounded intent delivery and explicit acknowledgement.
Suspension, disconnect or view changes cancel input authority. Quit flushes the
session, closes local control, and waits for helper shutdown.

## Presentation and input

The app retains the tested Instrument presentation: layout zoom, retained views,
intentional Fleet inspectors, gesture guide and hands-free tutorial. Status does
not write into the prompt. Input feedback updates its own small component;
there is no periodic conversation render or gateway refetch loop.

Linux windows omit the native title bar. The space-name menu provides the
connection and Quit controls within Instrument.

The star field has no per-star blurred halo. The dark background avoids the
banded gradient. On NVIDIA Linux systems the app defaults WebKit GPU painting
to its main thread to avoid the observed exit crash and uses shared-memory
buffer transport to avoid Wayland protocol error 71. Both defaults respect
explicit WebKit environment overrides.

## Distribution

The release matrix builds one Desktop implementation for Linux x64/ARM64 and
macOS Intel/Apple Silicon. The installer replaces the same `gsv-desktop` path
and matching helpers. macOS also ships ad-hoc signed `GSV.app` ZIPs through the
shared packaging script. Windows continues to receive CLI and daemon only.

Launching does not download an update. Rerun the host installer to update CLI
and Desktop; replace the application bundle to update a downloaded macOS app.
Signing with an Apple Developer ID and notarization remain separate release
configuration. The source build and developer app do not need those credentials.
