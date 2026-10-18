# Local speaker

This supervised helper runs Kokoro 82M FP32 on two CPU threads and plays audio
through the system's default output. Each release includes a native `gsv-speak`
executable with Python, pronunciation data and audio libraries frozen using
PyInstaller. Build it with `uv run --frozen --group build --project
host/helpers/speaker python host/scripts/build-speaker.py --output DIR`, or use
`scripts/build-desktop-voice.sh` for a complete local preview. Build on each
target OS/architecture; Linux builds need PortAudio installed at build time.
Spoken replies use ONNX Runtime on macOS 13+, with the other desktop features
retaining their existing platform baseline.

On first use `prepare.py` downloads the pinned model into the user's cache,
verifies SHA-256 and atomically publishes it. `GSV_SPEAK_MODEL_DIR` overrides the
cache directory for development. Cancellation removes partial downloads. The
release smoke test relocates the binary and exercises synthesis with an empty
`PATH`; no Python or source tree is required at runtime.

Private stdin accepts JSON lines: `prepare`, `speak` (id, language, chunks),
`cue` (listening, sent, cancelled, attention), `cancel`, and `shutdown`.
Desktop admits at most 128 KiB of UTF-8 speech text. The helper's 1 MiB line
budget includes worst-case JSON escaping and framing for that accepted input.
Only status, correlation IDs and bounded exception types go to stdout. Text
and generated audio remain in memory. No inference service or gateway changes
are involved. EOF exits and lets the frozen runtime clean up; Desktop bounds
shutdown and kills and reaps the helper if it does not exit.

Generation and playback use separate workers. Cancellation clears queued text
and audio and fences the current inference result; the audio callback observes
that boundary on its next 20 ms block. At most three generated chunks wait for
playback. `--silent` exercises synthesis and lifecycle without opening an audio
device. This does not measure speaker latency.

Model: <https://huggingface.co/hexgrad/Kokoro-82M> (Apache 2.0).
Runtime: <https://github.com/thewh1teagle/kokoro-onnx> (MIT).
The pronunciation dependencies include GPLv3 eSpeak NG and phonemizer. The build
collects dependency notices into `gsv-speak-THIRD_PARTY.md`, embedded in the helper
and included with the release, installer and macOS app. See `THIRD_PARTY.md` and
`uv.lock` for dependency licenses and sources.
