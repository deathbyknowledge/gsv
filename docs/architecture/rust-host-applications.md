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

- `crates/gsv-client/` owns WebSocket protocol frames, authentication metadata,
  typed RPC behavior, cancellation, and duplex binary bodies.
- `crates/gsv-config/` owns compatible local configuration and atomic updates.
- `crates/gsv-desktop-control/` owns the versioned, local Desktop control
  protocol.

These crates contain contracts and transport primitives. They do not own a
daemon lifecycle, a CLI interaction, or Desktop UI state.

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
`use`, and `microphone` subcommands are clients of `gsv-desktop-control`, not
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
experimental `gsv-vision` helper owns camera capture, MediaPipe inference, and
temporal gesture recognition; camera frames and landmarks never enter GPUI or
the gateway. `GSV_GESTURES=1` starts it headlessly, while the exact
`GSV_GESTURE_DEBUG=1` opt-in adds its local diagnostic window. A private,
bounded parent-child protocol carries only typed semantic intents. Desktop
grants an action lease for one active voice request, and the helper echoes that
request and its random supervisor session on every intent so stale work cannot
act on later dictation. Desktop remains the owner of HOLD, RELEASE, finalizing
transcription, and conversation submission. Its runtime is Rust plus a pinned
native MediaPipe library and model—Python and Bazel are build tools, not
Desktop runtime dependencies. `gsv-vision` is not part of the release
distribution until permissions, packaging, additional platforms, and the
model-redistribution policy are accepted deliberately.

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
