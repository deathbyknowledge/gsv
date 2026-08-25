# GSV Wearable for the HDZero Goggle 2 emulator

This is an end-to-end proof of concept built on the official HDZero SDL/LVGL
emulator. It adds a native `GSV Wearable` workspace and a bounded heads-up
overlay, then connects them to the real GSV transcription, process, streaming,
abort, and speech syscalls through a host-side bridge. The same bridge can hold a
second, independently authenticated driver connection so GSV sees the wearable
as a machine target.

The PoC intentionally keeps credentials, network I/O, audio bodies, and GSV
protocol handling outside the goggle UI process:

```text
HDZero LVGL emulator                 local bridge                     GSV gateway
┌────────────────────┐     0600 Unix socket      ┌────────────────┐   ┌────────────┐
│ wheel/buttons      │ ─── semantic actions ───▶ │ user client WS │ ─▶│ processes  │
│ wearable workspace │ ◀── bounded snapshots ─── │ driver WS      │ ◀─│ target FS  │
│ + voice overlay    │                           │ audio + routing │ ─▶│ STT / TTS  │
└────────────────────┘                           └────────────────┘   └────────────┘
```

This is the same ownership split intended for hardware: LVGL renders and handles
controls; a daemon owns long-running and failure-prone work. The bridge never
sends a credential or media body to the emulator.

## Quick start with no gateway

Install a C/C++ toolchain, CMake, SDL2 development headers, Git, and Node.js 22+
(with the built-in WebSocket client).
On Debian/Ubuntu the native dependencies are typically:

```bash
sudo apt install build-essential cmake git libsdl2-dev
```

From the GSV repository root:

```bash
./prototypes/hdzero-goggle/scripts/build-emulator.sh
./prototypes/hdzero-goggle/scripts/run-poc.sh --mock
```

Run the emulator as your normal desktop user, never with `sudo`. The launcher
refuses root, and the overlay replaces upstream hardware shell execution with a
log-only stub in emulator builds.

The first command clones the official firmware repository at pinned commit
`6fe76d4510c45092b616ff967c2b0942bd44a4b2` into the ignored `.work/` directory,
applies the small GSV overlay, and builds the real `HDZGOGGLE` emulator target as
Goggle 2. No HDZero source is vendored into GSV.

In the emulator:

- `W` / `S`: move the wheel
- `D`: click/enter; hold for more than 500 ms for a long press
- `A`: right button; a short press on the GSV page toggles recording

Open `GSV Wearable`. The page has Conversation, Activity, Device, and Show workspaces;
select `Next workspace` to move between them. Select `Talk to GSV` once to start
recording and again to stop. Mock mode produces a deterministic transcript,
streams a deterministic agent reply, and shows an independently connected mock
machine target. `Speak replies` exercises the speech state without requiring an
audio player. A short right-button press toggles voice; a long press changes the
workspace.

When launched from tmux or an SSH shell on a machine with an active desktop, the
launcher discovers an accessible Wayland or X11 socket automatically. If no
graphical display exists, it exits with a short diagnostic instead of leaving an
invisible firmware loop running. `SDL_VIDEODRIVER=dummy` remains available for
headless smoke tests.

## Connect the wearable client to a real GSV gateway

Build the local GSV SDK once, then provide an expiring user token and gateway
identity to the bridge:

```bash
npm run build --workspace packages/gsv

export GSV_GATEWAY_URL=wss://your-gateway.example/ws
export GSV_USERNAME=your-user
export GSV_TOKEN=the-expiring-user-token

./prototypes/hdzero-goggle/scripts/run-poc.sh
```

For example, an authenticated GSV CLI can create a dedicated expiring token with
`gsv auth token create --kind user --role user --label hdzero-emulator
--expires-at UNIX_MS`. The raw token is returned only once. Do not put it in this
repository or pass it to the emulator process; only the bridge reads it.

This starts the user-facing connection. If `GSV_DEVICE_TOKEN` is absent, the
Device workspace reports that the machine target is not configured.

For an interactive local run, the client connection may use the account
password instead of a user token. Keep the password out of shell history:

```bash
read -r -s -p "GSV password: " GSV_PASSWORD; printf '\n'
export GSV_PASSWORD
```

Set exactly one of `GSV_PASSWORD` and `GSV_TOKEN`. Password authentication is
sent only over the configured WebSocket connection and remains in bridge memory
for reconnects; the driver connection still requires its separate device token.

## Expose the emulator as a GSV machine

Create a separate device-bound driver token. Its `--device` value must match
`GSV_DEVICE_ID`:

```bash
export GSV_DEVICE_ID=hdzero-g2-emulator
gsv auth token create \
  --kind device \
  --role driver \
  --device "$GSV_DEVICE_ID" \
  --label hdzero-emulator

export GSV_DEVICE_TOKEN=the-device-token-returned-once
./prototypes/hdzero-goggle/scripts/run-poc.sh --dual
```

The two WebSockets reconnect independently and never share tokens. The driver
advertises the complete model-facing filesystem operations plus `fs.copy` and
`shell.exec`:

```text
fs.read  fs.write  fs.edit  fs.delete  fs.search  fs.copy
fs.transfer.stat  fs.transfer.send  fs.transfer.receive  shell.exec
```

The default writable root is the ignored `.work/device-root` directory, never
the workstation root. The actual upstream application payload is mounted at
`/mnt/app` read-only, so an agent can inspect HDZero's scripts, services,
settings, resources, and BusyBox layout without modifying the checkout:

```text
/
├── etc/
├── home/gsv/                 writable agent workspace
├── mnt/app/                  read-only upstream HDZero application payload
├── run/gsv/
├── sys/gsv/                  read-only driver metadata
├── tmp/
└── var/log/gsv/
```

For example, a GSV process can read `/sys/gsv/device.json` with target
`hdzero-g2-emulator`, inspect `/mnt/app/script/rc.sh`, or write files under
`/home/gsv`. `/mnt/app`, `/sys/gsv`, and the virtual root itself are protected
from mutation. Everything else is governed by the confined filesystem and
gateway approval policy.

The emulator's `shell.exec` uses `just-bash` over exactly the same filesystem.
It supports normal agent-friendly shell composition—including pipes,
redirection, `find`, `grep`, `rg`, `sed`, `jq`, `tar`, and file commands—without
executing programs or reading files from the host OS. Persistent sessions,
background jobs, and network commands are deliberately unavailable in this
PoC.

### Present content from the shell

The pseudo-shell adds a wearable-native command:

```bash
gsv-show text --title "Morning brief" "Three tasks need attention"
cat /home/gsv/report.txt | gsv-show text --title "Agent report"
gsv-show image --title "Architecture" /home/gsv/diagram.png
gsv-show status
gsv-show clear
```

Text opens the Show workspace immediately. PNG and BMP files inside the device
filesystem are rendered through LVGL's local decoder; paths outside the confined
root are rejected. The transfer syscalls let GSV's cross-target copy path place
binary images on the wearable without encoding them as tool arguments. Websites
and video are not emulated as native surfaces yet:
the current workflow is to use a browser-capable GSV target to capture a PNG,
copy it to the wearable, then call `gsv-show image`.

Running without `--dual` still enables the driver automatically when
`GSV_DEVICE_TOKEN` is set; `--gateway` explicitly disables it for a client-only
run.

The gateway must already have transcription configured. Speech synthesis is
only requested when `Speak replies` is enabled.

### Audio capture and playback

Live Linux capture defaults to:

```text
arecord -q -f S16_LE -r 16000 -c 1 OUTPUT.wav
```

Speech playback defaults to:

```text
ffplay -nodisp -autoexit -loglevel quiet INPUT
```

These can be changed without invoking a shell:

| Variable | Meaning |
| --- | --- |
| `GSV_HDZERO_AUDIO_FILE` | Reuse a WAV/MP3/M4A/Ogg/WebM file instead of a live microphone. |
| `GSV_HDZERO_CAPTURE_BIN` | Capture executable; defaults to `arecord`. |
| `GSV_HDZERO_CAPTURE_ARGS` | JSON string array of arguments; use `{output}` for the destination. |
| `GSV_HDZERO_PLAYBACK_BIN` | Playback executable; defaults to `ffplay`. |
| `GSV_HDZERO_PLAYBACK_ARGS` | JSON string array of arguments; use `{input}` for synthesized audio. |
| `GSV_HDZERO_LANGUAGE` | Optional transcription language hint. |
| `GSV_HDZERO_SPEECH_VOICE` | Optional configured speech voice. |
| `GSV_HDZERO_SPEECH_MAX_CHARS` | Maximum reply characters sent to TTS; defaults to `3500`. |
| `GSV_PASSWORD` | Optional client password; mutually exclusive with `GSV_TOKEN`. |
| `GSV_TOKEN` | Optional expiring client token; mutually exclusive with `GSV_PASSWORD`. |
| `GSV_PID` | Optional target agent process. The user's default process is used when omitted. |
| `GSV_CONVERSATION_ID` | Optional existing conversation to continue. |
| `GSV_HDZERO_SOCKET` | Override the local Unix socket path. |
| `GSV_DEVICE_ID` | Driver target identity; defaults to `hdzero-g2-emulator`. |
| `GSV_DEVICE_TOKEN` | Separate device-bound driver token; never reused for the wearable client. |
| `GSV_DEVICE_ROOT` | Confined read/write emulator root; defaults to `.work/device-root`. Never defaults to host `/`. |
| `GSV_HDZERO_APP_ROOT` | Read-only source mounted at `/mnt/app`; defaults to the pinned checkout's `mkapp/app`. |

For a deterministic real-gateway test without microphone setup:

```bash
export GSV_HDZERO_AUDIO_FILE=/absolute/path/to/question.wav
./prototypes/hdzero-goggle/scripts/run-poc.sh
```

Click start and stop as normal; the selected file is uploaded on stop.

## Runtime behavior

- The emulator sends only allowlisted semantic actions: voice, speech,
  cancellation, and workspace navigation.
- Every inbound line and displayed field is bounded. The Unix socket is mode
  `0600`, and the bridge refuses to replace a non-socket filesystem path.
- Transcription uploads use the GSV binary body channel and an abort signal.
- Agent signals are ignored unless they match the active `runId`. Signals that
  race ahead of the `proc.send` response are buffered to a fixed limit, then
  replayed after the returned ID is known.
- Cancelling invalidates the current generation before aborting capture or the
  process. Late results cannot update the active display.
- The answer overlay disappears after ten seconds, while the full latest answer
  remains on the GSV page.
- No transcript, reply, token, audio, or tool argument is written to bridge logs.
- Driver activity shown in the UI names the operation class but omits syscall
  arguments and file contents.

The UI does not send flight-control commands and has no path to the radio,
arming state, receiver settings, or video pipeline. It is a general wearable
surface that happens to run on the headset. Push-to-talk is available only from
the GSV page; the overlay can remain visible elsewhere while a request is active.

## Validation

```bash
npm run check --prefix prototypes/hdzero-goggle
npm test --prefix prototypes/hdzero-goggle
./prototypes/hdzero-goggle/scripts/build-emulator.sh

SDL_VIDEODRIVER=dummy timeout 6s \
  ./prototypes/hdzero-goggle/scripts/run-poc.sh --mock
```

The tests cover the full mock flow over the actual Unix-socket contract, early
signal ordering, streamed output, optional speech, active-run cancellation,
transcription cancellation, stale output rejection, independent connection
state, workspace navigation, the confined filesystem, socket permissions, and
action validation. Driver tests cover filesystem CRUD/search/copy, read-only
mount protection, pseudo-shell composition, and wearable presentation.

## What remains for hardware

The emulator uses the host microphone and host audio output. A hardware port must
identify the Goggle 2 microphone ALSA/device path, package the bridge (or a native
equivalent) for the goggle CPU, provision a scoped expiring credential, integrate
startup/upgrade/rollback, define a non-root writable filesystem boundary, add an
actual BusyBox shell implementation behind the same `shell.exec` contract, and
measure thermal, memory, network, display, and audio latency. None of those
hardware assumptions are hidden inside this emulator PoC.
