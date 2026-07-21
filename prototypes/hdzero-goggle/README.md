# GSV Voice for the HDZero Goggle 2 emulator

This is an end-to-end proof of concept built on the official HDZero SDL/LVGL
emulator. It adds a native `GSV Voice` menu page and a bounded heads-up overlay,
then connects them to the real GSV transcription, process, streaming, abort, and
speech syscalls through a host-side bridge.

The PoC intentionally keeps credentials, network I/O, audio bodies, and GSV
protocol handling outside the goggle UI process:

```text
HDZero LVGL emulator                 local bridge                    GSV gateway
┌────────────────────┐     0600 Unix socket      ┌──────────────┐    ┌───────────┐
│ wheel/buttons      │ ─── bounded commands ───▶ │ host audio   │ ─▶ │ STT       │
│ GSV menu + overlay │ ◀── display snapshots ─── │ GSV client   │ ─▶ │ proc.send │
└────────────────────┘                            │ run routing  │ ◀─ │ run stream│
                                                │ playback     │ ─▶ │ TTS       │
                                                └──────────────┘    └───────────┘
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

Open `GSV Voice`, select `Start recording`, and click once to start and once to
stop. Mock mode produces a deterministic transcript and streams a deterministic
agent reply. `Speak replies` exercises the speech state without requiring an
audio player.

When launched from tmux or an SSH shell on a machine with an active desktop, the
launcher discovers an accessible Wayland or X11 socket automatically. If no
graphical display exists, it exits with a short diagnostic instead of leaving an
invisible firmware loop running. `SDL_VIDEODRIVER=dummy` remains available for
headless smoke tests.

## Connect to a real GSV gateway

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
| `GSV_PID` | Optional target agent process. The user's default process is used when omitted. |
| `GSV_CONVERSATION_ID` | Optional existing conversation to continue. |
| `GSV_HDZERO_SOCKET` | Override the local Unix socket path. |

For a deterministic real-gateway test without microphone setup:

```bash
export GSV_HDZERO_AUDIO_FILE=/absolute/path/to/question.wav
./prototypes/hdzero-goggle/scripts/run-poc.sh
```

Click start and stop as normal; the selected file is uploaded on stop.

## Runtime behavior

- The emulator sends only `ptt.toggle`, `speech.toggle`, and `cancel` commands.
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

The UI does not send flight-control commands and has no path to the radio or
arming state. For this PoC, push-to-talk is available only from the GSV page; the
overlay can remain visible elsewhere while a request is active.

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
transcription cancellation, stale output rejection, socket permissions, and
command validation.

## What remains for hardware

The emulator uses the host microphone and host audio output. A hardware port must
identify the Goggle 2 microphone ALSA/device path, package the bridge (or a native
equivalent) for the goggle CPU, provision a scoped expiring credential, integrate
startup/upgrade/rollback, and measure thermal, memory, network, and audio latency.
None of those hardware assumptions are hidden inside this emulator PoC.
