# Rust host applications

GSV ships three sibling host applications. They share transport and local data
contracts, but they do not embed one another's runtime or state ownership.

```text
                         Gateway
                    user WS   driver WS
                       |          |
                +------+----+    gsvd
                |           |
            gsv CLI/TUI  GSV Desktop
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
- `host/crates/tui-core/` owns the transport-independent interaction state,
  keyboard actions, effects, and Ratatui cell-buffer rendering shared by the
  native CLI and browser TUI backends.

The protocol crates contain contracts and transport primitives. `tui-core`
owns presentation state but no authentication, gateway connection, Process,
conversation, or machine lifecycle. Its effects are interpreted by the client
backend that owns those operations.

The host applications, helpers, and shared crates form one Cargo workspace
rooted at `host/`. Its lockfile and build output belong to that boundary;
`workers/ripgit/` remains an independent Rust project.

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
`gsvd`, and the client sides of local Desktop and daemon control.

Bare `gsv` opens the full-screen TUI against the authenticated personal
Process; `gsv tui` is the explicit equivalent and `gsv tui --demo` exercises
the interface without an account. The native backend owns terminal setup and
restoration, maps Crossterm events into shared actions, and interprets shared
effects through the existing gateway client. Conversation history and signals,
Process run state, human-in-the-loop approvals, and abort remain gateway-owned.
The shared renderer projects canonical messages into one continuous scrollable
terminal document. Human text begins on the same line as its `user@target $ `
prompt, every committed message from one Process run remains in order beneath
that command, and `proc.run.finished` restores the next prompt. A silent finish
restores the prompt without fabricating output. Routine connection, role, time,
and run metadata stay out of the document. Typing is the default interaction;
`--vim` or `Alt+V` enables an optional browse mode without changing the beginner
key map.

Typing `@` into an empty draft opens the capability-environment picker. `Tab`
switches the same draft between Ship mode and literal shell mode. The latter is
visibly marked as `user@target $ ! command`; the native client calls the
established `shell.exec` syscall with the selected target and cwd, appends each
returned output chunk, and polls an existing `sessionId` until its terminal
result. Direct shell moments are client-local and are not canonical
conversation messages. Ordinary Ship input remains an unchanged
`conversation.send` request, with no target extension, so this client stays
compatible with an existing gateway deployment. The Kernel independently
enforces target visibility and the caller's grant for the direct target
operation; a presentation choice never grants authority.

The native renderer inherits the terminal foreground, background, and ANSI
palette instead of imposing a second terminal theme. The shared renderer owns
semantic color roles, Markdown presentation, source-mode toggling, and the
content-first fallback for canonical media resources. The native backend owns
inline-image presentation: it detects Kitty, Sixel, or iTerm2 graphics support,
falls back to Unicode half blocks, verifies immutable resource metadata before
reading the body, bounds decoding, and performs resize/encoding work away from
the input loop. This does not change the canonical resource contract or body
ownership.
The line-oriented `gsv chat` command remains available for scripts and basic
terminal sessions.

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

## Browser TUI preview

`web/tui/` compiles the same `tui-core` crate to WebAssembly and renders its
cell buffer through Ratzilla's WebGL2 backend. A hidden native textarea owns
Unicode input, IME composition, and paste; browser key and wheel events map to
the same shared actions as the native backend. Because no host terminal owns
its atmosphere, the browser backend uses the curated GSV palette. Markdown,
continuous prompt grammar, literal-shell mode, optional Vim navigation, and
media artifact fallback remain identical. The preview currently uses local
example responses for both Ship and shell effects. Production browser
authentication and transport stay with the existing web gateway service and
will interpret the same shared effects rather than moving protocol ownership
into the renderer.

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
enter GPUI or the gateway. Desktop starts it headlessly unless
`GSV_GESTURES=0`; the exact `GSV_GESTURE_DEBUG=1` opt-in adds its local
diagnostic window. A private,
bounded parent-child protocol carries reliable typed semantic intents plus
replace-latest absolute scroll-control velocity and control status with bounded
semantic candidate progress for presentation. In standby, the helper may
propose starting transcription without a voice-request identity. Desktop owns
an explicit, inspectable armed state that starts disarmed. The helper may
propose changing it only after a 700 ms two-fist hold, and Desktop echoes the
resulting absolute authority. Once armed, the right action hand alone maps
sequentially opened fingers 1 through 5 to start/finish, send, delete, clear,
and mute/unmute; those commands remain available while the Desktop window is
unfocused. Scrolling deliberately requires a two-hand chord: the control palm
stays open while the helper captures the image-aspect-corrected angle between
both palm centers and a settled action fist changes that relative angle.
Translating both hands together does not change the signal. The helper maps each
fresh change from neutral directly to a bounded velocity without a dead zone or
smoothing; Desktop applies that velocity through the conversation's existing
long-message and history-scroll policy. Returning to the neutral angle stops
movement, and releasing either posture ends the chord.
A stationary action fist by itself remains the only positive reset
between number commands. Releasing the scroll chord cannot become a numbered
command until another fist reset, and tracking loss can neither rearm a command
nor continue scrolling. While transcription is preparing or
stopping, Desktop temporarily disables action authority but still permits the
two-fist disarm gesture. Once listening and its initial mute state are
authoritative, Desktop grants an action lease for that exact voice request.
Disarming removes gesture authority without ending that request. Active events
echo the exact voice request, and every helper event echoes the random
supervisor session, so stale work cannot act on or describe later dictation.
Scroll state is absolute, coalescible, and heartbeated while the chord remains
valid. Desktop validates session, sequence, armed authority, and freshness
before its frame loop applies continuous view movement. Status and progress
never invoke an action. Desktop remains the owner of starting and
ending the overall voice request, acknowledged microphone mute state, and
conversation submission. Within an active request,
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
dependency. The raw Linux and macOS host distributions and the unsigned macOS
development application include `gsv-vision`, whose two checksum-verified
TFLite models are embedded directly in the executable for offline,
self-contained builds. They carry the model license and exact provenance as
verified release assets. The application starts the helper in a disarmed state
and provides visible Voice and Gestures affordances rather than depending on
shell environment variables that Finder does not provide. A signed macOS
application distribution still requires Developer ID signing and notarization.

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

## Desktop-managed machine enrollment

Installing Desktop is sufficient to connect the local computer without making
a user operate `gsvd` manually. After the first authenticated session, Desktop
presents an explicit “Connect this computer” step with an editable suggested
name. It derives the stable machine ID from that name with the same lowercase,
48-character normalization as the Web Machines flow, keeps the original name as
the display label, and rejects an existing ID or label. It saves the
driver-bound credential and its issuing gateway/account atomically in
`config.toml`, asks the bundled
`gsv` executable to install the per-user service, then verifies and reloads
`gsvd` through `daemon-protocol`. The credential never appears in process
arguments. A failed install can be retried without minting another identity,
and “not now” leaves chat available. Subsequent launches reuse that identity
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
API. The current host configuration stores it in the private, atomically
replaced `config.toml`; the credential-store boundary remains available for a
later packaging hardening without changing enrollment or daemon IPC. Local IPC
is same-user, authenticated,
versioned, and limited to typed setup, status, lifecycle, helper, and diagnostic
operations. Camera frames and audio do not cross the control channel. Release
packages include the matching daemon, helpers, models, and OS integration so a
single application installation cannot assemble incompatible host components.

Desktop may expose one optional operating-system status item for the complete
local GSV experience: machine connectivity, voice state, gesture state, and
their explicit controls. That is a Desktop surface in the macOS menu bar,
Windows notification area, or a best-effort Linux StatusNotifier integration.
`gsvd` remains a headless per-user service and never creates a second tray
icon. The status item observes live daemon state through that typed local
protocol. Reconnect and diagnostics use it directly; start and restart delegate
to the bundled CLI's cross-platform per-user service manager. Gateway reconnect
remains owned by Desktop's existing Gateway connection loop. The CLI and
Desktop therefore share the same daemon and service-control boundaries instead
of implementing platform commands in the menu layer.

## Distribution and upgrades

Release artifacts install `gsv`, `gsvd`, Desktop, and any Desktop helper as one
versioned distribution. The service definition points directly at `gsvd` while
retaining the established `gsvd` systemd, launchd, or Windows task identity.
Service installation detects and replaces legacy definitions that invoke the
hidden compatibility launcher `gsv device run`.

CLI, Desktop, and driver credentials stay separate. Daemon upgrades replace the
binary transactionally and restart only after the replacement is complete; a
failed health check restores the previous executable. Desktop updates do not
silently alter a running agent Process.

Published host artifacts cover Linux x64/ARM64 and macOS Intel/Apple Silicon
for Desktop, `gsv-transcribe`, `gsv-vision`, `gsv`, and `gsvd`, plus Windows x64
for `gsv` and `gsvd`. Checksums cover every release asset, including the vision
model license and provenance. On macOS,
`host/scripts/package-macos.sh` assembles an architecture-native development
`GSV.app` and ZIP containing Desktop, CLI, daemon, helpers, application
metadata, and local gesture models. The result is intentionally unsigned and
unnotarized. Public distribution additionally requires Developer ID signing,
hardened-runtime entitlements, Apple notarization, and stapling; those release
credentials are not configured in the repository.
