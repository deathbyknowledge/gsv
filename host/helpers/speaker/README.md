# Local speaker preview

This supervised helper runs Kokoro 82M FP32 on two CPU threads and plays audio
through the system's default output. It is a source-build preview; production
release packaging is separate. Build with `scripts/build-desktop-voice.sh`.
The model and voice cache is SHA-256 verified by `prepare.py`.

Private stdin accepts JSON lines: `prepare`, `speak` (id, language, chunks),
`cue` (listening, sent, cancelled, attention), `cancel`, and `shutdown`.
Only status, correlation IDs and bounded exception types go to stdout. Text
and generated audio remain in memory. No inference service or gateway changes
are involved. EOF exits; the desktop host also kills and reaps the helper at Quit.

Generation and playback use separate workers. Cancellation clears queued text
and audio and fences the current inference result; the audio callback observes
that boundary on its next 20 ms block. At most three generated chunks wait for
playback. `--silent` exercises synthesis and lifecycle without opening an audio
device. This does not measure speaker latency.

Model: <https://huggingface.co/hexgrad/Kokoro-82M> (Apache 2.0).
Runtime: <https://github.com/thewh1teagle/kokoro-onnx> (MIT).
The pronunciation dependencies include GPLv3 eSpeak NG and phonemizer. The
local preview uses their installed packages; release distribution needs its
corresponding notices and source packaging.
