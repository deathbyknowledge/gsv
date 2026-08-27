# Android Wear runtime

GSV Wear is a native Android machine driver. It keeps an explicitly visible
driver runtime reachable through the ordinary Gateway WebSocket and adds a
local, revocable authority session for physical sensors. The camera and
microphone are closed while idle.

The ownership boundary is deliberate:

- The Kernel owns driver identity, capabilities, device ACLs, target routing,
  route expiry, request cancellation, and body forwarding.
- Android owns foreground-service lifecycle, local Wear authority, WebSocket
  supervision, the bounded virtual target, target-side HTTP, binary-body
  spooling, physical sensors, Android actions, assistant speech playback and
  metering, local checks, temporary media, and terminal cleanup.
- A remote caller may consume an existing Wear authority lease. It cannot arm
  the phone or recreate authority after process death, reboot, force-stop, or
  permission loss.

## Runtime state

Connection, authority, and sensor use are independent axes:

```text
Connection  DISCONNECTED | OFFLINE | CONNECTING | CONNECTED | RECONNECTING
Authority   DISARMED | ARMED | PAUSED
Camera      CLOSED | OPENING | ACTIVE | CLOSING
Microphone  CLOSED | OPENING | ACTIVE | CLOSING
Voice       DISCONNECTED | OFFLINE | CONNECTING | CONNECTED | RECONNECTING
Voice turn  IDLE | PREPARING | LISTENING | THINKING | SPEAKING | ERROR
```

The visible post-onboarding surface projects these axes into one live liquid
client. The liquid is both the Wear authority control and the assistant-state
surface: it arms or disarms Wear Mode when tapped, then renders voice-turn
state and signal without introducing a second assistant panel. Gateway
reachability remains visible in the header. Pause, disconnect, assistant-role,
permission, and diagnostic actions remain available behind the system portal;
they are recovery and setup controls rather than the primary interaction.
This presentation does not broaden UI authority: the visible activity still
owns arming, and the runtime service still owns every authority transition.

`Arm Wear Mode` is accepted only from the visible activity after camera,
microphone, nearby-device, notification, and at least approximate-location
permissions have been granted. It starts a camera, microphone, and location foreground service
and creates a random authority generation held only in process memory. Precise
location and notification-listener access are optional. Pause retains the
generation but denies new leases. Disarm invalidates it, cancels active sensor
and local-check work, and keeps the driver connection alive. Disconnect is the
separate action that stops the runtime.

The service is `START_NOT_STICKY`; no boot receiver or background path creates
authority. The persistent notification exposes Pause, Resume, Disarm, Open,
and Disconnect actions according to the current state.

## Driver transport

The phone connects with protocol 2, role `driver`, platform `android`, and:

```json
{
  "implements": ["fs.*", "shell.exec", "net.fetch"]
}
```

One connection supervisor owns the active socket. A monotonically increasing
epoch fences callbacks from replaced sockets. GSV's acknowledged
`device.ping`/`device.pong` heartbeat detects half-open connections, Android's
default-network callback prompts immediate reconnect on network changes, and
other failures use full-jitter exponential backoff. There is no FCM dependency.

Reconnect restores reachability for later calls. It does not replay a request
whose delivery or physical outcome is uncertain. The Kernel binds an in-flight
route to the exact driver connection and fails it when that connection closes.

## Virtual target runtime

Android implements the same `fs.*` syscall contract used by the Gateway and
browser targets. The virtual namespace has two physical app-private mounts:

```text
/home/android   persistent
/tmp            service-runtime temporary storage
```

It merges those mounts with read-only runtime nodes under `/proc` and `/dev`.
Path normalization happens before mount selection, canonical physical paths
must remain inside their selected mount, and no route exposes Android shared
storage or the operating-system filesystem. Writes use a temporary sibling and
atomic replacement. Each file is capped at 64 MiB; persistent storage is capped
at 256 MiB, temporary storage at 128 MiB, each mount at 4,096 entries, and
materialized text reads at 8 MiB.

The target supports `fs.read`, `fs.write`, `fs.edit`, `fs.delete`, `fs.search`,
`fs.copy`, and the three `fs.transfer.*` calls used by Kernel cross-target copy
orchestration. Incoming bodies spool to a dedicated cache directory before an
exact-length atomic write. Response bodies stream directly from an owned file
or capture and respect a bounded WebSocket queue high-water mark. Cancellation,
length mismatch, timeout, socket loss, and normal completion all converge on
one body owner and delete incoming spool files.

`shell.exec` runs a Kotlin-owned virtual shell over the same filesystem. It has
a discoverable command registry (`help` and `commands --json`), common bounded
file/text commands, pipelines, redirection, physical-context commands, Android
context/actions, and local-check management. It never invokes Android's
`/system/bin/sh` or arbitrary system binaries. Executions are serialized,
time- and output-bounded, and do not support resumable sessions or background
jobs.

`net.fetch` is the same target-routed syscall implemented by ordinary machine
drivers. Android accepts HTTP(S) only, validates method and headers, owns
request-body consumption, follows the requested redirect mode, and spools a
response body to one 32 MiB-bounded temporary file. Request cancellation calls
`OkHttp Call.cancel`; response delivery owns and deletes the spool at its body
terminal outcome.

## Physical context

The first physical-context primitive stays under the fixed model-facing `Read`
tool:

```text
Read target=pixel-10 path=/dev/wear/status
Read target=pixel-10 path=/dev/camera/back/snapshot
```

The status file returns UTF-8 JSON through a normal successful `fs.read` body.
The snapshot file requires current armed authority, obtains an exclusive
CameraX lease, captures a bounded JPEG, and returns the existing `FsReadResult`
image metadata plus the protocol's binary body frames.

The camera controller enforces one capture at a time, a five-second operation
timeout, a 24 MiB result cap, and a back-camera resolution preference near
1280×720. It unbinds CameraX in `finally`. Raw images live only in the app cache
and are deleted after successful delivery, request cancellation, peer body
cancellation, disarm, socket loss, timeout, or error.

The virtual shell adds multi-frame camera observation, microphone sampling and
speech-wait leases, IMU summaries, gesture sessions, orientation, and current
location. Current location runs the requested Android network and/or GPS
providers inside one shared timeout, validates fix age against Android's
monotonic elapsed-realtime clock, and gives GPS a chance to complete before
selecting the most accurate eligible result. A forced request accepts only a
fix generated after that request began. Last-known fallback is explicit and is
subject to the same age limit. Responses expose the actual provider, monotonic
age, accuracy, post-request status, and cache-fallback status. Every sensor
controller serializes its own sessions, rechecks the in-memory authority
generation while active, and releases platform resources from `finally` or
`close`. Camera observations produce JPEG frames plus a JSON manifest. Audio
produces PCM16 WAV plus bounded JSON analysis for speech-or-voice, loud sound,
and sustained tone; arbitrary semantic event names are explicitly reported as
requiring later inference.

Request cancellation and body cancellation remain distinct. `request.cancel`
stops the whole target job. A binary `CANCEL | END` frame stops the body in its
direction: it cancels an announced response-body pump or rejects an incoming
request body. A body has one owner and one terminal outcome.

## Android actions and local checks

Platform commands expose device/battery/network/thermal/storage context,
launcher apps, bounded URI intents, Android sharing, clipboard operations,
optional notification-listener inspection/actions/replies, agent
notifications, text-to-speech, and vibration. Android remains the owner of
platform presentation. When background-activity launch restrictions apply,
app/deep-link/share requests create a tap-required notification and return that
state rather than claiming a launch occurred. Clipboard reads similarly report
unavailable unless the activity is visible.

Notification-listener access is distinct from permission to post notifications.
Its status reports whether the special access is granted, whether Android has
connected the listener service, and the settings action required when setup is
incomplete. The activity shows the same state beside its one-tap Notification
access button; Android remains the owner of the confirmation screen.

The local-check scheduler persists at most 32 records in app-private storage
with atomic replacement. It accepts one allowlisted sensor/context command,
rejects shell composition, executes only while the service is armed, and
journals bounded JSONL results below `/home/android/checks`. Its schedule is
independent of Gateway connectivity. Pause, disarm, record removal, and service
teardown cancel scheduler-owned jobs; no remote request is queued or replayed
through this mechanism.

## Headset voice client

The Android app can also be selected as the system voice-interaction service.
This is a client surface, not another driver primitive. It owns a second,
independently supervised role=`user` WebSocket because a driver-bound token
cannot and must not authenticate a user connection. The visible activity uses
the user's password once to call `sys.token.create`; only the returned user
token is encrypted at rest. Wear authority still gates microphone capture, so
an assistant gesture can consume an armed session but cannot create one.

An invocation from Android's assistant gesture or the in-app test button runs
one bounded turn:

```text
assistant gesture
  -> transient audio focus and headset communication route
  -> local WAV capture until end of speech
  -> ai.transcription.create binary request body
  -> transcript-only proc.send to the personal process
  -> proc.run.finished or proc.run.hil.requested
  -> installed non-network Android voice and playback-timed PCM levels
  -> ai.speech.create binary response body only when embedded speech cannot start
  -> abandon focus so media playback resumes
```

Raw microphone bytes are neither inserted into process history nor base64
encoded into JSON. They have one owner from capture through the transcription
request and are deleted at the turn's terminal outcome. A second invocation
cancels the earlier turn. Ordinary media play/pause buttons remain owned by the
active media session; GSV relies on the system assistant gesture instead of
registering a competing media-button receiver.

The service-lifetime voice audio controller keeps one embedded TTS engine warm,
selects only an installed voice whose Android metadata says it does not require
a network connection, and owns its audio focus, cancellation, and shutdown.
The engine's PCM callbacks are reduced into 40 ms level windows and paced from
the utterance playback-start callback so `SPEAKING` renders the audio that is
actually being played rather than a synthetic animation signal. A local failure
before playback may fall back to gateway synthesis. Once local playback starts,
the same answer is never replayed through the gateway. A per-turn generation
fences state and level callbacks from cancelled or superseded invocations.

Bluetooth HFP assistant gestures enter through Android's separate
`ACTION_VOICE_COMMAND` activity contract rather than through
`VoiceInteractionService`. The exported, lock-screen-capable voice activity
accepts that typed intent, acknowledges the connected headset with
`BluetoothHeadset.startVoiceRecognition`, prefers its matching SCO input for
`AudioRecord`, and stops recognition as soon as capture ends. A protected
`ACTION_STOP_VOICE_COMMAND` signal cancels an active turn on platform versions
that provide it. This route still consumes the same in-memory Wear authority;
being externally launchable does not let another app arm sensors.

If a run pauses for human approval, the client speaks that approval is needed
and leaves the durable process pending for review on an ordinary GSV surface.
The headset interaction does not silently approve tools.

## Credentials and logs

The activity stores endpoint metadata in private preferences and encrypts the
driver-bound token and separate voice user token with an Android Keystore
AES-GCM key. The password used to mint the voice token is not persisted. App
backup and device transfer are disabled. Production configuration accepts only
`wss://.../ws`; debug builds also permit cleartext `ws://` for local
development.

The runtime does not log credentials, gateway URLs, protocol frame arguments,
virtual paths requested by callers, or raw media. UI and notification state is
drawn only from bounded enums and sanitized connection outcomes.

## Current scope

The implemented surface is the bounded virtual filesystem and shell,
cross-target file transfer, device-side HTTP, runtime inspection, on-demand
camera/audio/motion/location context, Android context/actions, notification
listener integration, local scheduled checks, and a system-assistant voice
client for the personal process. It deliberately does not
provide unrestricted Android shell/root/shared-storage access, Accessibility
automation, a bundled offline language or vision model, resumable shell sessions,
remote command replay, or FCM wake-up. Multi-frame camera observation currently
uses bounded repeated still captures rather than one continuously bound video
stream.

Build validation and the physical-device checklist live in the repository's
`android/README.md`.
