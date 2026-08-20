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
- `host/crates/gesture-protocol/` owns the private, versioned contract between
  Desktop and its gesture helper.

These crates contain contracts and transport primitives. They do not own a
machine lifecycle, a CLI interaction, or Desktop UI state.

The native Android driver is a separate Gradle application under `android/`.
It implements the same public WebSocket and syscall/body contracts without
joining the Rust Cargo workspace or embedding `gsvd`; its lifecycle and sensor
authority are documented in [Android Wear runtime](./android-wear-runtime.md).

The host applications, helpers, and shared crates form one Cargo workspace
rooted at `host/`. Its lockfile and build output belong to that boundary;
`ripgit/` remains an independent Rust project.

## `gsvd`

`gsvd` is the machine driver. It connects to the gateway with the driver role
and owns concrete `fs.*`, `shell.exec`, and `net.fetch` execution, subprocess
and shell-session lifecycles, request and body cancellation, reconnection,
logging, health, and shutdown.

The daemon remains in the foreground. The OS service manager owns detachment,
restart, and login/boot behavior. It authenticates with a driver-bound
credential and runs as an unprivileged OS user.

## `gsv`

`gsv` is an operator client. It owns gateway administration, authentication,
chat and process commands, deployment, OS service installation/control for
`gsvd`, and the client side of local Desktop control.

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

Desktop connects to the gateway with a user role. It owns the selected Process,
the active conversation workspace, drafts, approvals, attachment work,
presentation, microphone preference, and the same-user local control server.
Desktop does not need `gsvd` to chat; the daemon only makes the local machine
available as a syscall target.

Platform-native, high-cost Desktop work runs in separately supervised helpers.
`gsv-transcribe` owns local microphone capture and speech inference. The
experimental `gsv-vision` helper owns camera capture, native Rust/tract model
inference, authored landmark-to-pose recognition, and temporal gesture policy;
camera frames and landmarks never
enter GPUI or the gateway. `GSV_GESTURES=1` starts it headlessly, while the exact
`GSV_GESTURE_DEBUG=1` opt-in adds its local diagnostic window. A private,
bounded parent-child protocol carries reliable typed semantic intents plus
replace-latest absolute fist-drag position and control status with bounded
semantic candidate progress for presentation. In standby, the helper may
propose starting transcription without a voice-request identity. Desktop owns
an explicit, inspectable armed state that starts disarmed. The helper may
propose changing it only after a 700 ms two-fist hold, and Desktop echoes the
resulting absolute authority. Once armed, the right action hand alone maps
sequentially opened fingers 1 through 5 to start/finish, send, delete, clear,
and mute/unmute; those commands remain available while the Desktop window is
unfocused. A settled action-hand fist also acts as a scroll clutch: vertical
movement produces absolute palm-relative drag positions, opening releases it,
and Desktop turns fresh armed updates into native wheel input for the
application under the pointer. A stationary fist is the only positive reset
between number commands. Releasing a drag cannot become a numbered command
until another fist reset, and tracking loss can neither rearm a command nor
continue scrolling. While transcription is preparing or stopping, Desktop
temporarily disables action authority but still permits the two-fist disarm
gesture. Once listening and its initial mute state are authoritative, Desktop
grants an action lease for that exact voice request. Disarming removes gesture
authority without ending that request. Active events echo the exact voice
request, and every helper event echoes the random supervisor session, so stale
work cannot act on or describe later dictation. Scroll state is absolute and coalescible;
Desktop validates session, sequence, armed authority, and freshness before
deriving relative native input. Status and progress never invoke an action.
Desktop remains the owner of starting and ending the overall voice request,
acknowledged microphone mute state, and conversation submission. Within an active request,
`gsv-transcribe` owns authoritative utterance boundaries: it finalizes and
replaces only the model stream while retaining microphone capture, request
identity, and mute state. Desktop accepts
the correlated utterance final, submits it through the ordinary conversation
owner, and rebases the continuing voice draft; the same exact boundary lets
Desktop delete one Unicode grapheme or clear only unsent voice-owned text while
preserving typed anchors and attachments. A later partial begins on the new
segment and cannot resurrect corrected text. Gesture send and correction never
masquerade as terminal transcription events. Its runtime is the Rust helper
plus two checksum-pinned palm and hand-landmark TFLite models executed by tract;
the command vocabulary is owned by Rust rather than the upstream canned gesture
classifier. It has no Python, Java, Bazel, or native MediaPipe build/runtime
dependency. `gsv-vision` is not part of the
release distribution until signed macOS application packaging, camera
permissions, and the model-redistribution policy are accepted deliberately.

The local protocol exposes `activate`, redacted `status`, `new`, `use`, and the
narrow `microphone list/use/default` operations. Its endpoint must be accessible
only to the current OS user. Credentials, drafts, attachment paths, approval
arguments, and conversation content never cross this IPC boundary. Bounded
human-readable microphone names cross only the explicit microphone operations;
they never enter general Desktop status.

`new` means Desktop performs an authenticated `proc.spawn`, then selects the
returned Process only after its authoritative history handoff succeeds. If
cancellation lands after the durable spawn but before selection, that Process
can remain valid but unselected. `use` validates access to an existing PID
before selection. Each asynchronous result is fenced by connection epoch, PID,
and operation identity so output from the previous Process cannot mutate the
new workspace.

## Planned Desktop-managed machine enrollment

Installing Desktop should be sufficient to connect the local computer without
making a user operate `gsvd` manually. First use presents an explicit “Connect
this computer” step with an editable suggested name. Desktop then enrolls one
stable machine identity, installs the per-user background service, and reports
its connection and capability status. Subsequent launches reuse that identity
and never create another machine merely because the application restarted.

Desktop is the setup and control UI; `gsvd` remains the machine endpoint and
owns its persistent driver connection. Closing Desktop does not disconnect the
machine. Signing out of the user client and explicitly disconnecting the
computer are separate actions: disconnect revokes the driver credential and
stops the service. Neither normal enrollment nor background operation requires
administrator or root access.

The enrollment state machine and local control protocol are platform-neutral.
OS integration stays behind narrow credential-store, service-manager, local-IPC,
and permission-manager boundaries:

| Concern | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Credential storage | Keychain | Secret Service or an explicit protected-file backend | Credential Manager/DPAPI |
| Background startup | `SMAppService` | systemd user service with an XDG fallback | per-user Startup Task |
| Local IPC | Unix socket | Unix socket | named pipe |
| Permissions | TCC | portals, PipeWire, and device access | Windows privacy APIs |

The shared contract is a persistent machine credential, not any one OS storage
API. The service owns that credential; Desktop supplies only the short-lived
authority needed for enrollment. Local IPC is same-user, authenticated,
versioned, and limited to typed setup, status, lifecycle, helper, and diagnostic
operations. Camera frames and audio do not cross the control channel. Release
packages include the matching daemon, helpers, models, and OS integration so a
single application installation cannot assemble incompatible host components.

## Distribution and upgrades

Release artifacts install `gsv`, `gsvd`, Desktop, and any Desktop helper as one
versioned distribution. The service definition points directly at `gsvd` while
retaining the established `gsvd` systemd, launchd, or Windows task identity.
Service installation detects and replaces legacy definitions that invoke
`gsv device run`.

CLI, Desktop, and driver credentials stay separate. Daemon upgrades replace the
binary transactionally and restart only after the replacement is complete; a
failed health check restores the previous executable. Desktop updates do not
silently alter a running agent Process.

Published host artifacts currently cover Linux x64/ARM64 and macOS
Intel/Apple Silicon for all four host executables, plus Windows x64 for `gsv`
and `gsvd`. Checksums cover every release asset. The macOS Desktop executable
is not yet a signed or notarized `.app`; signing and notarization require
release credentials that are not configured in the repository.
