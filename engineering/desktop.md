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
- `gsvd` independently owns the machine connection. Desktop enrolls this computer
  through the same invitation and `gsv pair` path as Fleet. Closing Desktop never
  stops an installed daemon service.

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

## Welcome and space creation

The welcome screen opens an existing space or redeems an operator-issued invite.
The packaged frontend talks to Accounts over HTTPS using explicit owner bearer
authentication; browser cookies never authorize the native API. The default
Accounts origin is `https://gsv.space`; operator builds may set
`VITE_GSV_ACCOUNTS_ORIGIN`. Direct handle/custom-domain connections remain available.

Rust saves the pending email challenge, client-chosen owner session secret, and
invite operation in private `welcome.json` before network mutation. Atomic writes
are revision-fenced; these credentials never enter web storage. Reopening probes
the saved owner session and resumes the same claimed invitation. The per-space
session stores the temporary onboarding capability until Kernel setup completes.
If setup was interrupted, Accounts renews it for the same installation. A global
owner session can list spaces and create an invited space, but cannot sign in to
an existing Kernel or reset its root credential.

## This computer

After sign-in, an unconfigured computer gets a compact naming step with Connect
and Not now. Setup waits for native session persistence before checking the
computer, and a failed check opens the same prompt with Retry. Not now postpones
setup for the current session. The space menu's This computer action reopens
setup. An existing connection for this space and account starts automatically if its service is
stopped; a running connection is left alone. A binding to another space or
account is shown without being replaced.

The frontend creates an ordinary device invitation through its authenticated
gateway connection and retains the exact request for retries. The native host
checks its session generation, account and invitation origin, then delivers the
code on stdin to the sibling CLI. Pairing keeps the CLI login unchanged and
refuses to replace an existing machine credential. The CLI remains the owner of
credential persistence, receipt recovery and per-user service installation.
An interrupted pairing resumes its saved credential; a service-install failure
after redemption retries installation without creating another target.

Installing the service is not completion: native setup waits, with a bounded
timeout and cancellation, for the daemon's gateway connection. The dialog keeps
the result visible with Connected and Done, or an error with Retry. Reopening
This computer refreshes local status. The daemon uses its own saved space and
account independently of the CLI login, with fallback for older configurations.

A machine authentication rejection retires only that exact saved credential and
leaves the daemon idle awaiting pairing; it does not retry a revoked credential.
The name and workspace remain available for setup. Desktop checks a disconnected
daemon through the same bounded connection wait and offers enrollment again when
the credential has been retired. Adding it again reconciles the previous
invitation before creating a fresh one. Transient connection failures retain the
credential and use ordinary reconnect backoff.

Setup runs asynchronously. Signing out, changing spaces or quitting cancels the
owned CLI process group. A committed machine pairing remains inspectable and
recoverable. Native status exposes identity and connection state, never driver
credentials. This integration is present only in the desktop frontend.

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
