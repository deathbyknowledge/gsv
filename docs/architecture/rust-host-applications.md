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

The host applications, helpers, and shared crates form one Cargo workspace
rooted at `host/`. Its lockfile and build output belong to that boundary;
`workers/ripgit/` remains an independent Rust project.

## `gsvd`

`gsvd` is the machine driver. It connects to the gateway with the driver role
and owns concrete `fs.*`, `shell.exec`, `shell.cancel`, and `net.fetch` execution, subprocess
and shell-session lifecycles, request and body cancellation, reconnection,
logging, health, and shutdown.

The daemon remains in the foreground. The OS service manager owns detachment,
restart, and login/boot behavior. It authenticates with a driver-bound
credential and runs as an unprivileged OS user.

## `gsv`

`gsv` is an operator client. It owns gateway administration, authentication,
chat and process commands, deployment, OS service installation/control for
`gsvd`, and the client sides of local Desktop and daemon control.

`gsv daemon install|start|restart|stop|uninstall` controls the per-user OS
service. `gsv daemon status|reload|reconnect|diagnostics` talks to the running
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

Hands-free has Off, Ready and Listening states. One finger starts or pauses
listening; two sends, three deletes, four clears dictated text, and both fists
exits hands-free. The thumb counts independently and any finger combination
is accepted. A control palm and action fist scroll together. The tutorial uses
lesson-scoped observations and accepts only its current gesture. Voice events
retain request and segment identity so stale output cannot change a later draft.
The input lease expires on suspension and is released when leaving Zen.

Local control supports activation, redacted status, new Process creation,
selection of an accessible Process, and microphone discovery and selection.
The IPC server verifies OS user identity. Credentials, conversation text, drafts
and attachment paths never cross this channel. Requests are correlated through
a frontend channel. Cancellation, timeout, disconnect and reload invalidate
pending work before UI mutations. If a Process spawn has already committed when
cancelled, the Process remains durable and inspectable, without being selected.
Microphone commands use the active Zen input owner and never start capture.

Closing the window follows the same unsent-work guard and credential flush as
Quit, stops local control, waits for helper shutdown and exits. A second launch
focuses the existing window. The independent `gsvd` service keeps running.

## Machine enrollment

Desktop offers Connect this computer after sign-in and through its space menu.
The frontend creates the same ordinary device invitation as Fleet; the native
host passes it on private stdin to `gsv pair - --preserve-cli-login --no-replace`.
The CLI stores the driver credential in private `config.toml` and owns per-user
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
otherwise or an earlier installation already exists. The service definition
points directly at `gsvd` by absolute path while
retaining the established `gsvd` systemd, launchd, or Windows task identity.
Service installation detects and replaces legacy definitions that invoke the
hidden compatibility launcher `gsv device run`.

CLI, Desktop, and driver credentials stay separate. Daemon upgrades replace the
binary transactionally and restart only after the replacement is complete; a
failed health check restores the previous executable. Desktop updates do not
silently alter a running agent Process.

The daemon keeps itself current from the gateway handshake, because the gateway
cannot reach a machine. A protocol error 102 names the server version and the
installer, which means the daemon must update; a successful connect against a
newer release means it should. Either way `gsvd` starts the ordinary installer,
pinned with `GSV_VERSION` to the release the gateway named (`vX.Y.Z` on the
stable channel, `dev` on the dev channel), detached from its own service: a
transient `systemd-run --user` unit on Linux under systemd, a new session on
macOS and other Unix hosts, and a detached process on Windows. The installer's
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
for `gsv` and `gsvd`. Checksums cover every release asset, including the vision
model license and provenance. On macOS,
`host/scripts/package-macos.sh` assembles an architecture-native development
`GSV.app` and ZIP containing Desktop, CLI, daemon, helpers, application
metadata, and local gesture models. The result is ad-hoc signed and unnotarized. Public distribution additionally requires Developer ID signing,
hardened-runtime entitlements, Apple notarization, and stapling; those release
credentials are not configured in the repository.
