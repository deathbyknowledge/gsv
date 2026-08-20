# Android Wear runtime

GSV Wear is a native Android machine driver. It keeps an explicitly visible
driver runtime reachable through the ordinary Gateway WebSocket and adds a
local, revocable authority session for physical sensors. The camera and
microphone are closed while idle.

The ownership boundary is deliberate:

- The Kernel owns driver identity, capabilities, device ACLs, target routing,
  route expiry, request cancellation, and body forwarding.
- Android owns foreground-service lifecycle, local Wear authority, network
  supervision, CameraX, temporary media, and sensor cleanup.
- A remote caller may consume an existing Wear authority lease. It cannot arm
  the phone or recreate authority after process death, reboot, force-stop, or
  permission loss.

## Runtime state

Connection, authority, and sensor use are independent axes:

```text
Connection  DISCONNECTED | OFFLINE | CONNECTING | CONNECTED | RECONNECTING
Authority   DISARMED | ARMED | PAUSED
Camera      CLOSED | OPENING | ACTIVE | CLOSING
```

`Arm Wear Mode` is accepted only from the visible activity after camera,
microphone, and notification permissions have been granted. It starts a
camera-and-microphone foreground service and creates a random authority
generation held only in process memory. Pause retains that generation but
denies new leases. Disarm invalidates it, cancels active work, and keeps the
driver connection alive. Disconnect is the separate action that stops the
runtime.

The service is `START_NOT_STICKY`; no boot receiver or background path creates
authority. The persistent notification exposes Pause, Resume, Disarm, Open,
and Disconnect actions according to the current state.

## Driver transport

The phone connects with protocol 2, role `driver`, platform `android`, and:

```json
{
  "implements": ["fs.read"]
}
```

One connection supervisor owns the active socket. A monotonically increasing
epoch fences callbacks from replaced sockets. OkHttp WebSocket pings detect
half-open connections, Android's default-network callback prompts immediate
reconnect on network changes, and other failures use full-jitter exponential
backoff. There is no FCM dependency.

Reconnect restores reachability for later calls. It does not replay a request
whose delivery or physical outcome is uncertain. The Kernel binds an in-flight
route to the exact driver connection and fails it when that connection closes.

## Virtual sensor files

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

Request cancellation and body cancellation remain distinct. `request.cancel`
stops the whole capture/response job. A binary `CANCEL | END` frame stops only
the announced response-body pump. A body has one owner and one terminal
outcome.

## Credentials and logs

The activity stores endpoint metadata in private preferences and encrypts the
driver-bound token with an Android Keystore AES-GCM key. App backup and device
transfer are disabled. Production configuration accepts only `wss://.../ws`;
debug builds also permit cleartext `ws://` for local development.

The runtime does not log credentials, gateway URLs, protocol frame arguments,
virtual paths requested by callers, or raw media. UI and notification state is
drawn only from bounded enums and sanitized connection outcomes.

## Current scope

The implemented sensor primitive is one still-camera snapshot. Microphone
permission and foreground-service authority are established for the Wear
session, but microphone sampling, observation leases, semantic on-device
inference, continuous vision, remote command replay, and FCM wake-up are not
implemented.

Build validation and the physical-device checklist live in the repository's
`android/README.md`.
