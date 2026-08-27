# GSV Wear for Android

This Gradle project builds the native Android machine driver and Wear Mode
runtime. It currently supports persistent WebSocket reconnect, a bounded
`fs.*` virtual target, device-side `net.fetch`, a discoverable virtual shell,
cross-target file transfer, on-demand camera/audio/motion/location context,
Android actions and notification access, and persisted local checks that can
continue while the Gateway is temporarily offline. It can also act as the
phone's headset-triggered GSV voice client while Wear Mode is armed.

## Prerequisites

- JDK 17 or newer
- Android SDK Platform 37 and Build Tools 36.0.0
- A physical Android phone for the sensor acceptance flow
- The hostname used to reach a GSV, such as `mine.gsv.space`
- A GSV username and password

The app enrolls itself after password authentication. It creates a generated,
driver-bound node identity and a separate user credential for the assistant;
neither raw token is shown to or entered by the user. Production login requires
`wss://`.

For local development on a USB-connected phone, keep the password off the LAN
and reverse the Gateway port over ADB. Debug builds then permit the loopback
`ws://` address:

```bash
adb reverse tcp:8787 tcp:8787
```

Enter `localhost:8787` in the app for that setup. The app derives the WebSocket
scheme and `/ws` path; neither is part of the user-facing address.

If the SDK is not in its conventional location, create an untracked
`android/local.properties` containing:

```properties
sdk.dir=/absolute/path/to/android-sdk
```

## Build and install

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug builds use the side-by-side package `com.humansandmachines.gsv.wear.debug`
and the launcher label **GSV Wear Dev**. This keeps an existing release install
and its credentials intact when a development machine has a different debug
signing key.

Debug builds also include an explicit, non-launcher assistant render harness for
motion review without a live voice turn:

```bash
adb shell am start -n \
  com.humansandmachines.gsv.wear.debug/com.humansandmachines.gsv.wear.ui.AssistantShowcaseActivity \
  --es state THINKING
```

Use `IDLE`, `PREPARING`, `LISTENING`, `TRANSCRIBING`, `THINKING`, `SPEAKING`,
or `ERROR`; add `--ez overlay true` to review the compact invocation surface.
For the debug-only interruptible shape proof, launch `LISTENING` with both
`--ez overlay true` and `--ez morph true`, then tap the core repeatedly to
redirect the in-progress morph between the production liquid and smile targets.
To compare the production liquid states without restarting its animation, add
`--ez overlay true` and `--ez states true`, then tap the core to advance through
the states included in the current visual review. `LISTENING` requests
microphone permission and follows live input. `SPEAKING` loops a debug-only
local voice phrase through the same audio controller used by production and
drives the acoustic membrane from the exact PCM being played. Pass
`--ef signal 0.82`
to use a fixed debug level instead; a fixed level disables both live sources
for that launch.

Open GSV Wear. On a fresh install it walks through GSV address, username, and
password; known URL and username values are skipped. The password is used only
for the authenticated enrollment exchange and is never persisted. When the
Wear control appears, press **Arm Wear Mode**. Grant camera, microphone,
notification, and nearby-device permissions and at least approximate location.
Precise location is optional.
For dependable screen-off reconnect behavior, use the app's Battery settings
button and set GSV Wear to unrestricted battery use.

Android notification-listener access is a separate, optional one-time Settings
grant. Use the app's **Notification access** button only if agents should be
able to list, reply to, invoke, or dismiss other apps' notifications.

The enrolled credentials are encrypted with Android Keystore and are never
rendered in the app. To enable OS gestures, expand **Assistant** and press
**Make GSV default assistant**. Android presents its assistant-role consent
prompt for this app directly. Arm Wear Mode before invoking it. Use **Test
assistant** for the first end-to-end check; afterward the device's normal
assistant gesture, including a headset assistant gesture when the headset
exposes one, starts the same turn.

The unlocked assistant-service route renders a transparent, voice-reactive GSV
session over the current app. Only its lower control region consumes touch, so
the rest of the underlying surface remains available. Android 13 and newer use
the GPU shader treatment; older supported releases keep the same state and
interaction contract with a Canvas fallback.

Classic Bluetooth headset gestures use Android's `VOICE_COMMAND` route rather
than the power-button assistant-service route. GSV Wear implements both. On an
HFP invocation it acknowledges the headset recognition session, selects the
matching SCO microphone, and releases that session immediately after capture
so later gestures and music routing are not left wedged.

The voice socket reconnects independently from the machine-driver socket. A
turn captures a bounded WAV locally, sends its bytes as the transcription
request body, sends only the transcript to the personal process, waits for the
matching run terminal signal, and speaks the answer with an installed Android
voice that does not require a network connection. PCM callbacks from that same
utterance drive the speaking animation in playback time. Gateway
`ai.speech.create` is retained as a fallback when a compatible embedded voice
cannot start; the generic Android speech action is the final fallback. A
pending approval is announced but never automatically approved.

## Use the Android target

The connected phone advertises `fs.*`, `shell.exec`, and `net.fetch`. Its
virtual namespace is deliberately smaller than Android itself:

```text
/
├── home/android                 persistent app-private files
├── tmp                          runtime-temporary app-private files
├── proc
│   ├── capabilities.json
│   ├── device.json
│   ├── runtime.json
│   └── wear/status.json
└── dev
    ├── wear/status
    └── camera/back/snapshot
```

Only `/home/android` and `/tmp` are writable. The app does not expose shared
phone storage or Android's root filesystem. Files are limited to 64 MiB;
`/home/android` has a 256 MiB quota, `/tmp` has a 128 MiB quota, and each mount
has a 4,096-entry limit. Direct text reads and edits are limited to 8 MiB;
larger files can still move through the streamed transfer calls.

The ordinary model-facing filesystem tools route directly to this namespace:

```json
{
  "target": "pixel-10",
  "path": "/home/android/notes/today.txt",
  "content": "Remember the charger.\n"
}
```

The shell operates on the same namespace:

```json
{
  "target": "pixel-10",
  "input": "echo 'physical context' > /tmp/context.txt; cat /tmp/context.txt"
}
```

Run `help` or `commands --json` for discovery. The current registry includes
`pwd`, `ls`, `cat`, `echo`, `printf`, `mkdir`, `touch`, `rm`, `cp`, `mv`,
`stat`, `head`, `tail`, `wc`, `grep`, `find`, `date`, `whoami`, `uname`,
`device`, `wear`, `camera`, `microphone`, `sensors`, `imu`, `gesture`,
`orientation`, `location`, `apps`, `intent`, `share`, `clipboard`,
`notifications`, `notify`, `speak`, `vibrate`, and `checks`. Quoting, pipes,
sequential statements, and `<`, `>`, and `>>` redirection are supported. This
shell never invokes the real Android shell; sessions and background jobs are
not implemented.

Standard `fs.copy` can transfer an ordinary file between Android, `gsv`, and
another online device. Incoming and outgoing binary bodies are streamed and
checked against their declared lengths rather than encoded into JSON.

`net.fetch` runs the HTTP request from the phone's network and returns its
response as a streamed body. It accepts only HTTP(S), caps request and response
bodies at 32 MiB, and has the same target-routed contract as other machines:

```ts
const response = await fetch("https://example.com", { target: "pixel-10" });
return { status: response.status, text: await response.text() };
```

## Physical context

Once the target is online, use the ordinary GSV `Read` primitive:

```json
{
  "target": "pixel-10",
  "path": "/dev/wear/status"
}
```

```json
{
  "target": "pixel-10",
  "path": "/dev/camera/back/snapshot"
}
```

The camera node returns an `fs.read` image body. CameraX is closed before the
body is streamed, and the cached JPEG is deleted after the transfer reaches a
terminal outcome.

To take one snapshot and retain it as an ordinary temporary file for later
reads or cross-target copy, use:

```json
{
  "target": "pixel-10",
  "input": "camera snapshot /tmp/current-context.jpg"
}
```

This makes the physical action explicit and one-shot: the event-producing
camera node itself cannot be pre-statted for `fs.copy`, while the materialized
file can be transferred normally.

The bounded sensor commands are:

```text
camera status
camera snapshot [DESTINATION]
camera observe DURATION [DESTINATION] [--interval DURATION] [--frames N]
microphone status
microphone sample DURATION [DESTINATION]
microphone observe DURATION [DESTINATION] [--events CSV]
microphone listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]
sensors status
imu sample DURATION [DESTINATION]
gesture session DURATION [DESTINATION]
orientation current [DURATION]
location current [--provider best|gps|network] [--max-age DURATION] [--force] [--allow-cached] [--timeout DURATION]
```

Camera and microphone leases last at most two minutes. Captures default to
`/tmp`; supplying a path under `/home/android` retains them across runtime
restarts. Audio observation performs primitive local detection for speech or
voice, loud sound, and sustained tone. Other requested event names are marked
as requiring semantic inference rather than being guessed. Gesture sessions
report motion class and shake events from the phone's motion sensors.

Location defaults to `best`, a 30-second maximum fix age, and a 15-second
request timeout. `best` lets both enabled network and GPS requests finish (or
reach the shared timeout) before selecting the most accurate eligible result.
`--provider gps` is the direct outdoor/high-accuracy path. `--force` requires a
fix generated after the command began and cannot be combined with
`--allow-cached`; without `--allow-cached`, last-known locations are never used.
Successful responses identify the requested and actual provider, monotonic fix
age, accuracy, whether the fix was generated after the request, and whether the
explicit cache fallback was used.

## Android context and actions

Agents can inspect device, battery, network, thermal, storage, permissions,
location, launcher apps, and notifications. They can also request app/deep-link
opening, Android sharing, clipboard operations, notification actions and
replies, user-visible notifications, text-to-speech, and bounded vibration.
Use `help COMMAND` for exact syntax.

Android itself imposes two visible-interaction boundaries. When GSV Wear is not
visible, an app-open, deep-link, or share request becomes a notification that
the user taps instead of silently launching an Activity. Clipboard reads are
unavailable while GSV Wear is not visible; clipboard writes and clears remain
available. These results are reported explicitly in command JSON.

## Local checks

`checks` persists bounded context commands and runs them from the armed
foreground runtime, even while the Gateway socket is temporarily offline:

```bash
checks add delivery-watch --every 2m --command 'microphone observe 4s --events loud_sound,tone'
checks list
checks run CHECK_ID
checks disable CHECK_ID
checks remove CHECK_ID
```

Only one sensor/context command is accepted per check; pipes, redirection, and
sequential statements are rejected. Results are journaled under
`/home/android/checks/CHECK_ID/events.jsonl`, with bounded rotation. Pause,
disarm, service teardown, and check removal cancel owned work. This is a local
scheduler and primitive classifier, not an offline language or vision model.

## Physical-device acceptance checklist

Run this on an actual phone before treating a release as sensor-validated:

1. Fresh-install the APK, sign in with a disposable test account, and confirm the phone enrolls without asking for any token or device id.
2. Confirm the target advertises `fs.*`, `shell.exec`, and `net.fetch` after
   connecting.
3. Write, read, edit, search, copy, and delete files in both writable mounts;
   confirm `/home/android` survives a runtime restart and `/tmp` is cleared.
4. Run `commands --json`, a quoted pipeline, and output redirection; confirm an
   unregistered Android command returns `command not found`.
5. Copy a binary file from `gsv` to Android and back, verify its exact bytes,
   and confirm no incoming spool file remains.
6. Arm from the visible activity, accepting approximate or precise location,
   and confirm the foreground notification says camera and microphone are off.
7. Turn the screen off and read `/dev/camera/back/snapshot`; confirm an image
   reaches the requesting GSV process and the Android privacy indicator appears
   only during capture.
8. Switch Wi-Fi to mobile data, wait for `CONNECTED`, and take another
   snapshot without touching or unlocking the phone.
9. Restart the Gateway and confirm the phone reconnects for a later request.
10. Cancel a snapshot while CameraX is opening and while its body is streaming;
   confirm no late result and no `gsv-wear-snapshot-*` cache file remains.
11. Pause and then disarm during capture; confirm both paths cancel active work
   and subsequent camera reads fail closed.
12. Reboot and force-stop the app; confirm Wear authority is not recreated.
13. Revoke camera permission and contend with another camera app; confirm the
   request fails without crashing or retaining media.
14. Exercise camera observation, audio sample/observation/speech wait, IMU,
    gesture, orientation, device context, and location; confirm each sensor
    closes on success, cancellation, pause, and disarm.
15. Grant notification-listener access, inspect only result shape during the
    smoke test, and verify action/reply/dismiss against a disposable test
    notification.
16. Verify background app-open/share requests produce a tap-required
    notification, then verify a visible-activity request can launch directly.
17. Run a short local check while connected and while the Gateway is offline;
    verify bounded journal output, rotation, disable/remove, and cancellation.
18. Fetch a controlled HTTP endpoint through the Android target, including a
    request body, redirect modes, cancellation, timeout, and the 32 MiB cap.
19. Exercise forced Doze and an overnight armed run with unrestricted battery
    use, recording reconnect latency and battery consumption.
20. Grant GSV the Android assistant role, and confirm
    the in-app test completes transcription, personal-process execution, and
    embedded spoken playback without raw audio appearing in process history.
    Confirm the speaking liquid follows the played voice and returns to rest at
    the utterance boundary. Invoke the power-button assistant route over another
    app, confirm the GSV session shows listening, thinking, and speaking state,
    and confirm a tap above the lower control region still reaches the
    underlying app.
21. While music is playing through a Bluetooth headset, invoke the headset's
    assistant gesture, confirm capture uses the headset microphone, the reply
    plays through the headset, and music resumes afterward. Invoke again during
    a turn and confirm the earlier turn is cancelled. Repeat the gesture without
    reconnecting the headset to confirm HFP recognition is released each time.
22. Drop and restore the network separately during capture and inference;
    confirm temporary audio is deleted, the turn fails once, and both voice and
    driver sockets reconnect for later work without replay. Drop the network
    after embedded speech starts and confirm playback completes locally. On a
    device without a compatible installed voice, confirm gateway speech is used
    as the fallback without replaying an utterance that already began locally.

There is intentionally no FCM path. A socket that closes is noticed and
reconnected manually by the foreground runtime. An in-flight request at the
moment of disconnect fails rather than being replayed with an uncertain
physical outcome.
