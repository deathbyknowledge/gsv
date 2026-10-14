# Rust host applications

GSV ships three sibling host applications. They share transport and local data
contracts, but they do not embed one another's runtime or state ownership.

```text
                         Gateway
                    user WS   driver WS
                       |          |
                +------+----+    gsvd
                |           |
              gsv CLI   GSV Desktop
                            ^
                            |
                     same-user IPC
```

## Shared crates

- `host/crates/gateway-client/` owns WebSocket protocol frames, authentication metadata,
  typed RPC behavior, cancellation, and duplex binary bodies.
- `host/crates/config/` owns compatible local configuration and atomic updates.
- `host/crates/desktop-protocol/` owns the versioned, local Desktop control
  protocol.
- `host/crates/daemon-protocol/` owns the versioned, same-user `gsvd` control
  protocol.
- `host/crates/gesture-protocol/` owns the private, versioned contract between
  Desktop and its gesture helper.

These crates contain contracts and transport primitives. They do not own a
machine lifecycle, a CLI interaction, or Desktop UI state.

Binary bodies preserve the shared delivery mode. `delivery: "realtime"` uses
a 32 KiB initial and replenishment window so live browser images stay close to
the viewer; ordinary file transfers retain the default 4 MiB window. Both modes
use the same cancellation and byte-credit protocol.

The host applications, helpers, and shared crates form one Cargo workspace
rooted at `host/`. Its lockfile and build output belong to that boundary;
`workers/ripgit/` remains an independent Rust project.

The gesture runtime's CMake build downloads Eigen from TensorFlow's archive
mirror and ml_dtypes from GitHub, both at LiteRT's pinned revisions with SHA-256
verification. It does not clone Eigen from GitLab or fetch ml_dtypes' unused
Eigen submodule. This source selection applies to local builds and every desktop
release platform, including builds without a dependency cache.

## `gsvd`

`gsvd` is the machine driver. It connects to the gateway with the driver role
and owns concrete `fs.*`, `shell.exec`, `shell.cancel`, and `net.fetch` execution, subprocess
and shell-session lifecycles, request and body cancellation, reconnection,
logging, health, and shutdown.

The daemon remains in the foreground. The OS service manager owns detachment,
restart, and login/boot behavior. It authenticates with a driver-bound
credential and runs as an unprivileged OS user.

### Windows service ownership

On Windows 10 x64, `gsvd --windows-service` registers with SCM and starts
before interactive login. SCM stop and shutdown controls enter the same
cancellation path as foreground shutdown. Crash recovery belongs to SCM.
`gsvd --foreground` remains available for attached use.

Installation requests administrator elevation, copies the service executable
to `%ProgramFiles%\GSV\service`, and defaults to the passwordless virtual
account `NT SERVICE\gsvd`. Administrators may configure a different service
logon account through Windows Services. Reinstallation and upgrades preserve the
existing SCM configuration, including the account, startup and recovery settings,
token privileges, service SID policy, description, and service DACL. Existing
state-directory access rules are retained, including grants for a custom account;
the installer still verifies the directory is ordinary and administrator-owned.
Only a new
registration receives the defaults. A conflicting `gsvd` executable or service
type is rejected before replacement; an administrator must resolve it explicitly.
The service SID receives access to its state and selected workspace; agent
commands inherit the service account's permissions, never the installer's.
The default Windows workspace is `%USERPROFILE%\GSV`.

Workspace permission changes remain in the enrolling process at its original
privilege level. Before requesting elevation, it must be able to read and change
the selected directory's ACL. New grants and revocations remain in the enrolling
process. Before registration, it transfers copies of its already-authorized
directory handles over a local pipe. The elevated child checks the pipe's actual
server PID and duplicates those handles with identical access rights; it cannot
use an argument to borrow another process's authority. These handles and ACL
snapshots survive caller exit and authorize only restoration of the prior ACLs.
Windows launches the elevated CLI directly and returns its process handle. The
caller checks the pipe client's PID against that exact process before transferring
authority. Readiness, commit and abort travel on that authenticated connection;
named events cannot complete someone else's enrollment. The elevated child also
watches the original caller's process handle independently of pipe closure.
The enrolling process grants
the service access, revokes any previous workspace grant, and starts the service.
Workspace ACL changes use synchronous Windows APIs on those handles inside the
caller process. No external ACL worker can survive it and overwrite rollback.
The elevated replacement guard remains active throughout those caller-side steps.
A failed grant or startup restores the original workspace ACLs before rolling
back the daemon and enrollment. Caller exit signals the same rollback in the
surviving elevated process, using the transferred handles. It never commits
solely because registration completed.
Pairing and installation configuration changes use that same startup; callers
do not stop and restart the service again after the transaction commits.
Administrator approval cannot make an otherwise inaccessible directory writable
by agent commands.

Service installation selects only the bundled `gsvd.exe` beside the CLI, without
consulting `GSV_GSVD_PATH` or `PATH`. The enrolling process locks and checks that
file before requesting UAC approval. The elevated child reads from that locked
file, verifies its pinned SHA-256 digest against an owned byte snapshot, and
writes that snapshot; it never executes a candidate
to discover its version. A changed or unbundled candidate fails before altering
the existing service. A complete replacement is staged and synced before SCM
stops the daemon, then atomically replaces the executable. Registration failures
restore the previous image, enrollment configuration, and running state.

`%ProgramData%\GSV\daemon` holds the daemon-only enrollment and
logs. CLI and Desktop login credentials are not copied there. The local pipe
ACL admits the enrolled owner and service account, rejects remote clients,
and clients authenticate the server against the process registered in SCM.
Desktop and audio/camera helpers remain in the interactive user's session.
Windows updates are administrator-managed because the service cannot replace
its protected executable. Legacy scheduled tasks are not migrated.

The authoritative owner SID lives separately at `%ProgramData%\GSV\owner.sid`,
under the administrator-protected parent directory. The enrolling user and
daemon can read it but cannot rewrite it or replace it through a writable parent.
Daemon-writable configuration never selects the service pipe's owner.

## `gsv`

`gsv auth login` defaults to the personal account and asks only for its password.
`--username root` selects administration; machine enrollment retains its explicit
account identity. The shared gateway client accepts omitted human usernames and
the CLI stores the identity returned by the Kernel with its session token.

`gsv` is an operator client. It owns gateway administration, authentication,
chat and process commands, deployment, OS service installation/control for
`gsvd`, and the client sides of local Desktop and daemon control.

`gsv daemon install|start|restart|stop|uninstall` controls the OS service.
Linux and macOS use the current user; Windows uses the native SCM boot service. `gsv daemon status|reload|reconnect|diagnostics` talks to the running
daemon over `daemon-protocol`; status also reports the OS service state. The
protocol deliberately carries only bounded, redacted lifecycle information.
Gateway frames, credentials, file content, and media remain on their owning
channels.

`gsv desktop` launches or activates the installed Desktop. Its `status`, `new`,
`use`, and `microphone` subcommands are clients of `desktop-protocol`, not
alternate owners of Desktop state. `status` is read-only and never starts the
application; state-changing commands make Desktop perform the operation through
the runtime that owns it. Process changes use Desktop's authenticated gateway
connection. Microphone discovery and selection use Desktop's isolated local
transcription helper and atomically persisted host configuration.

The compatibility command `gsv device run` resolves the sibling `gsvd` binary
and replaces itself with `gsvd --foreground`. It does not link or execute the
machine runtime in the CLI process.

## GSV Desktop

`host/apps/desktop` hosts the same Preact Instrument source as the web UI.
The frontend owns the sole authenticated gateway connection, conversations,
Process observation, drafts, approvals, attachments and retained screen state.
Rust owns native input, private session persistence, external browser navigation,
attachment downloads, window lifecycle and the same-user `desktop-protocol` control server.

The installed binary is `gsv-desktop`; the app is GSV with bundle identity
`space.gsv.desktop`. There is no second desktop renderer or gateway client.
Desktop credentials are isolated from CLI and driver credentials. Only the
bundled main window can invoke the narrow native bridge. Space changes reset
native input and invalidate frontend control and credential writes.

Attachment reads stay in the authenticated frontend. The native download handler accepts only
blob URLs owned by the bundled app, confines suggested filenames to the system Downloads folder,
and reserves filenames until transfers finish, including simultaneous downloads of the same blob.
Existing files are never replaced. WebKit owns the transfer; the frontend receives only its
completion status. On Linux, completion is tracked per download through WebKit signals so a failed
transfer cannot mark a later successful download as failed. The bridge does not expose arbitrary
filesystem writes or add another gateway connection.

`desktop-native` supervises `gsv-transcribe` for local capture and speech
inference, and `gsv-vision` for local camera capture, LiteRT/XNNPACK inference
and authored gesture recognition. Audio, camera frames and landmarks stay in
the helpers. Both features start only when explicitly enabled. The helper
protocol carries bounded, session-scoped semantic intents and feedback.
The frontend acknowledges pushed updates; it does not poll conversation state.

Linux transcription releases bundle OpenBLAS and use GNU ld to register its
native initializers. The artifact check rejects unconverted legacy constructor
sections as well as external math-library dependencies, so voice needs no
additional BLAS installation on the user's machine.

Voice builds use the speech library's dynamic backend selection. The portable core
loads a compatible CPU variant at runtime, including a baseline x86-64 backend for
computers without AVX2. Release and CI builds clear cached ggml CPU options before
building all x86-64 variants, so the runner's CPU does not determine compatibility.
Cargo stages the shared libraries and backends in `gsv-transcribe-runtime`; release
archives, installers and the macOS app bundle carry that directory with the helper.
Installers verify it and replace or roll it back with the binaries. The artifact
check validates relocated libraries as well as the helper, and recorded-speech
checks exercise both automatic selection and the baseline backend.

Hands-free has Off, Ready and Listening states. One finger starts or pauses
listening; two sends, three deletes, four clears dictated text, and both fists
exits hands-free. The thumb counts independently and any finger combination
is accepted. A control palm and action fist scroll together. The tutorial uses
lesson-scoped observations and accepts only its current gesture. Voice events
retain request and segment identity so stale output cannot change a later draft.
The input lease expires on suspension and is released when leaving Chat.

Local control supports activation, redacted status, new Process creation,
selection of an accessible Process, and microphone discovery and selection.
The IPC server verifies OS user identity. Credentials, conversation text, drafts
and attachment paths never cross this channel. Requests are correlated through
a frontend channel. Cancellation, timeout, disconnect and reload invalidate
pending work before UI mutations. If a Process spawn has already committed when
cancelled, the Process remains durable and inspectable, without being selected.
Microphone commands use the active Chat input owner and never start capture.

Closing the window follows the same unsent-work guard and credential flush as
Quit, stops local control, waits for helper shutdown and exits. A second launch
focuses the existing window. The independent `gsvd` service keeps running.

## Machine enrollment

Desktop offers Connect this computer after sign-in and through its space menu.
The frontend creates the same ordinary device invitation as Fleet; the native
host passes it on private stdin to `gsv pair - --preserve-cli-login --no-replace`.
The CLI stores the driver credential in private `config.toml` and owns OS
service installation; `gsvd` owns the persistent machine connection. Existing
bindings for this space and account resume automatically, while other bindings
are preserved. Interrupted enrollment and failed service installation retain
their durable identity for retry. Installed machine identities and services
remain valid through the desktop upgrade.

See the Desktop ownership notes under `engineering/` in the repository for the native boundary
and [host installation](../how-to/install-host-apps.md) for distribution.

## Distribution and upgrades

Release artifacts install `gsv`, `gsvd`, Desktop, and any Desktop helper as one
versioned distribution, into a per-user directory (`~/.gsv/bin`, or
`%LOCALAPPDATA%\Programs\gsv\bin` on Windows) unless `GSV_INSTALL_DIR` says
otherwise or an earlier installation already exists. Windows additionally copies
`gsvd` into its protected service directory. The service definition
points directly at `gsvd` by absolute path while
retaining the established `gsvd` systemd, launchd, or SCM service identity.
Unix service installation detects and replaces legacy definitions that invoke the
hidden compatibility launcher `gsv device run`; Windows has no migration path.

CLI, Desktop, and driver credentials stay separate. Daemon upgrades replace the
binary transactionally and restart only after the replacement is complete; a
failed health check restores the previous executable. Desktop updates do not
silently alter a running agent Process.

On Linux and macOS, the daemon keeps itself current from the gateway handshake, because the gateway
cannot reach a machine. A protocol error 102 names the server version and the
installer, which means the daemon must update; a successful connect against a
newer release means it should. Either way `gsvd` starts the ordinary installer,
pinned with `GSV_VERSION` to the release the gateway named (`vX.Y.Z` on the
stable channel, `dev` on the dev channel), detached from its own service: a
transient `systemd-run --user` unit on Linux under systemd, a new session on
macOS and other Unix hosts. The installer's
checksum verification, service stop, transactional swap, health check, and
rollback then run unchanged, and the daemon stays connected or retrying until
the installer stops it. Guardrails: only a release the gateway named, at most
one attempt per hour, a stable daemon never follows a `dev` gateway, and
`device.auto_update = false` turns the mechanism off. The decision shows in
`gsv daemon diagnostics`; installer output goes to
`~/.gsv/logs/auto-update.log`. The CLI and Desktop are never replaced under a
person; the CLI prints one hint when the gateway is newer.

Published host artifacts cover Linux x64/ARM64 and macOS Intel/Apple Silicon
for Desktop, `gsv-transcribe`, `gsv-vision`, `gsv`, and `gsvd`, plus Windows x64
for all five host executables. Checksums cover every release asset, including the vision
model license and provenance. On macOS,
`host/scripts/package-macos.sh` assembles an architecture-native development
`GSV.app` and ZIP containing Desktop, CLI, daemon, helpers, application
metadata, and local gesture models. The result is ad-hoc signed and unnotarized. Public distribution additionally requires Developer ID signing,
hardened-runtime entitlements, Apple notarization, and stapling; those release
credentials are not configured in the repository.

On Windows, `host/scripts/package-windows.ps1` packages all five executables,
licenses, checksums and the PowerShell installer in a ZIP and an NSIS setup
executable. Setup creates a Start-menu shortcut and an Apps uninstall entry.
Setup embeds hashes of its installer script and checksum manifest in the
executable. A fixed command verifies owned in-memory snapshots against those
hashes before executing the script; the installer receives the verified manifest
directly. Replacing extracted files cannot choose code or hashes across UAC.
The installer verifies every asset before mutation, requests elevation for an
existing boot service, checks its health, and rolls back binaries if that check
fails. The elevated updater receives fixed code and pinned release hashes through
its command line, copies verified byte snapshots into an administrator-owned
staging directory, and runs only that protected CLI. User application files and
configuration stay in the original installer process. Setup upgrades reuse the
previously selected installation directory. `-Headless` installs only the CLI and daemon without WebView2.
WebView2 and the Visual C++ runtime are downloaded from Microsoft when needed;
their Authenticode signatures are verified before execution.

`host/scripts/sign-windows.ps1` uses `GSV_WINDOWS_SIGNING_THUMBPRINT` when the
matching certificate and private key are provisioned in the Windows build
runner. It signs SHA-256 with a timestamp and verifies the result. Without that
release credential, Windows artifacts are unsigned; checksums remain mandatory.
The Windows workflow separately tests SCM, IPC, shell process trees and installer
rollback, then builds Desktop and helpers and runs recorded gesture parity.
Physical microphone/camera permissions, GUI onboarding/UAC and reboot recovery
also need a Windows release smoke test on an actual computer.
