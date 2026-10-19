"""Local Kokoro synthesis and playback. Private JSON-lines stdin; status-only stdout."""

import collections
import json
import math
import os
import platform
from pathlib import Path
import queue
import sys
import threading
import time

from prepare import model_directory, prepare_model, PreparationCancelled

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("ORT_LOGGING_LEVEL", "4")

import numpy as np
import miniaudio

RATE = 24000
IDLE_OUTPUT_SECONDS = .25
OUTPUT_BACKEND = {"linux": miniaudio.Backend.PULSEAUDIO,
                  "darwin": miniaudio.Backend.COREAUDIO,
                  "win32": miniaudio.Backend.WASAPI}[sys.platform]
# Rust admits 128 KiB of UTF-8 text; JSON can expand each byte to six bytes,
# plus the bounded request ID, chunk delimiters, fields and terminating newline.
MAX_LINE = 1024 * 1024
VOICES = {"en": ("af_heart", "en-us"), "es": ("ef_dora", "es")}
output_lock = threading.Lock()


class VoiceUnavailable(Exception):
    pass


class SharedOutput(miniaudio.PlaybackDevice):
    def __init__(self, **options):
        try:
            super().__init__(**options)
        except Exception:
            self.close()
            raise

    def close(self):
        super().close()
        # miniaudio 1.71 closes the device but leaks its separately allocated context.
        # Keep ownership here until upgrading to a release that closes both.
        context = getattr(self, "_context", None)
        if context is not None:
            miniaudio.lib.ma_context_uninit(context)
            self._context = None


def emit(phase, request_id=None, error=None):
    with output_lock:
        print(json.dumps({"phase": phase, "id": request_id, "error": error}), flush=True)


class Speaker:
    def __init__(self, model_dir, silent=False):
        self.model_dir = model_dir
        self.condition = threading.Condition()
        self.playback_lock = threading.Lock()
        self.generation = 0
        self.closed = False
        self.requests = collections.deque()
        self.audio = collections.deque()
        self.offset = 0
        self.playing = None
        self.events = queue.SimpleQueue()
        self.model = None
        self.stream = None
        self.last_output = time.monotonic()
        self.silent = silent
        self.worker = threading.Thread(target=self.generate, daemon=True)
        self.reporter = threading.Thread(target=self.report, daemon=True)
        self.worker.start()
        self.reporter.start()

    def output(self, out, frames):
        out.fill(0)
        position = 0
        with self.condition:
            while self.audio and position < frames:
                generation, request_id, samples = self.audio[0]
                if generation != self.generation:
                    self.audio.popleft()
                    self.offset = 0
                    continue
                if samples is None:
                    self.audio.popleft()
                    self.playing = None
                    self.events.put((generation, "finished", request_id))
                    continue
                if self.playing != request_id:
                    self.playing = request_id
                    self.events.put((generation, "speaking", request_id))
                count = min(frames - position, len(samples) - self.offset)
                out[position:position + count, 0] = samples[self.offset:self.offset + count]
                self.last_output = time.monotonic()
                self.offset += count
                position += count
                if self.offset == len(samples):
                    self.audio.popleft()
                    self.offset = 0
            self.condition.notify_all()

    def playback(self):
        frames = yield b""
        while True:
            out = np.empty((frames, 1), dtype=np.float32)
            self.output(out, frames)
            frames = yield out

    def release_idle_output(self):
        with self.playback_lock:
            with self.condition:
                if (self.audio or self.playing is not None
                        or time.monotonic() - self.last_output < IDLE_OUTPUT_SECONDS):
                    return
                stream, self.stream = self.stream, None
            if stream is not None:
                try:
                    stream.stop()
                finally:
                    stream.close()

    def report(self):
        while True:
            try:
                event = self.events.get(timeout=IDLE_OUTPUT_SECONDS)
            except queue.Empty:
                try:
                    self.release_idle_output()
                except Exception as error:
                    emit("error", error=type(error).__name__)
                continue
            if event is None:
                return
            generation, phase, request_id = event
            with self.condition:
                if generation == self.generation:
                    emit(phase, request_id)

    def prepare(self, generation):
        if self.model is not None:
            return
        if sys.platform == "darwin" and int(platform.mac_ver()[0].split(".")[0]) < 13:
            raise VoiceUnavailable("Spoken replies require macOS 13 or newer.")
        with self.condition:
            if self.closed or generation != self.generation:
                raise PreparationCancelled()
            emit("loading")
        prepare_model(self.model_dir, lambda: self.closed or generation != self.generation)
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        session = ort.InferenceSession(str(self.model_dir / "model.onnx"), sess_options=options,
                                      providers=["CPUExecutionProvider"])
        self.model = Kokoro.from_session(session, str(self.model_dir / "voices.bin"))
        with self.condition:
            if not self.closed and generation == self.generation:
                emit("ready")

    def append(self, generation, request_id, samples):
        with self.condition:
            self.condition.wait_for(lambda: self.closed or generation != self.generation or len(self.audio) < 3)
        with self.playback_lock:
            with self.condition:
                if self.closed or generation != self.generation:
                    return False
                if self.silent:
                    if samples is None:
                        emit("finished", request_id)
                    else:
                        emit("speaking", request_id)
                    return True
            if self.stream is None:
                # Never fall back to a raw hardware backend when the shared server is unavailable.
                stream = SharedOutput(output_format=miniaudio.SampleFormat.FLOAT32,
                                      sample_rate=RATE, nchannels=1, buffersize_msec=20,
                                      backends=[OUTPUT_BACKEND], app_name="Ship")
                callback = self.playback()
                next(callback)
                try:
                    stream.start(callback)
                except Exception:
                    stream.close()
                    raise
                self.stream = stream
            with self.condition:
                self.audio.append((generation, request_id, samples))
            return True

    def generate(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closed or self.requests)
                if self.closed:
                    return
                generation, command = self.requests.popleft()
            request_id = command.get("id")
            try:
                if command["kind"] == "cue":
                    frequencies = {"listening": (520, 780), "sent": (660, 880),
                                   "cancelled": (620, 440), "attention": (280, 280)}[command["cue"]]
                    t = np.arange(int(RATE * .065), dtype=np.float32) / RATE
                    envelope = np.sin(math.pi * t / .065) ** 2
                    samples = np.concatenate([np.sin(2 * math.pi * f * t) * envelope * .04 for f in frequencies])
                    self.append(generation, request_id, samples.astype(np.float32))
                    self.append(generation, request_id, None)
                    continue
                self.prepare(generation)
                if command["kind"] == "prepare":
                    continue
                voice, language = VOICES[command["language"]]
                for text in command["chunks"]:
                    with self.condition:
                        if self.closed or generation != self.generation:
                            break
                    audio, rate = self.model.create(text, voice=voice, speed=1.0, lang=language)
                    if rate != RATE or not np.isfinite(audio).all():
                        raise ValueError("invalid_audio")
                    if not self.append(generation, request_id, np.asarray(audio, dtype=np.float32)):
                        break
                self.append(generation, request_id, None)
            except PreparationCancelled:
                pass
            except Exception as error:
                with self.condition:
                    if generation == self.generation:
                        self.requests.clear()
                        self.audio.clear()
                        self.offset = 0
                        self.playing = None
                        # Exception messages from phonemizers may contain private input.
                        emit("error", request_id, str(error) if isinstance(error, VoiceUnavailable) else type(error).__name__)

    def cancel(self, request_id=None):
        with self.playback_lock:
            with self.condition:
                self.generation += 1
                self.requests.clear()
                self.audio.clear()
                self.offset = 0
                self.playing = None
                stream, self.stream = self.stream, None
                self.condition.notify_all()
            if stream is not None:
                try:
                    stream.stop()
                finally:
                    stream.close()
        emit("idle", request_id)

    def command(self, command):
        kind = command.get("kind")
        if kind == "cancel":
            try:
                self.cancel(command.get("id"))
            except Exception as error:
                emit("error", command.get("id"), type(error).__name__)
            return
        if kind not in ("prepare", "speak", "cue"):
            raise ValueError("invalid_command")
        if kind == "speak":
            chunks = command.get("chunks")
            if (command.get("language") not in VOICES or not isinstance(command.get("id"), str)
                    or not isinstance(chunks, list) or not 1 <= len(chunks) <= 256
                    or not all(isinstance(text, str) and 0 < len(text) <= 700 for text in chunks)):
                raise ValueError("invalid_speech")
        if kind == "cue" and command.get("cue") not in ("listening", "sent", "cancelled", "attention"):
            raise ValueError("invalid_cue")
        with self.condition:
            if len(self.requests) >= 16:
                raise ValueError("queue_full")
            self.requests.append((self.generation, command))
            self.condition.notify_all()

    def close(self):
        try:
            self.cancel()
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()
            self.events.put(None)


def main():
    if "--check-runtime" in sys.argv:
        import ctypes
        import espeakng_loader
        import onnxruntime
        import _miniaudio
        from kokoro_onnx import Kokoro
        ctypes.CDLL(espeakng_loader.get_library_path())
        if not Path(espeakng_loader.get_data_path()).is_dir():
            raise RuntimeError("missing_pronunciation_data")
        print(json.dumps({"runtime": "ready", "audio": miniaudio.lib_version(),
                          "bundled_audio": hasattr(sys, "_MEIPASS") and Path(_miniaudio.__file__).is_relative_to(sys._MEIPASS),
                          "inference": onnxruntime.__version__}))
        return
    speaker = Speaker(model_directory(), "--silent" in sys.argv)
    emit("idle")
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                emit("error", error="command_too_large")
                break
            try:
                command = json.loads(line)
                if command.get("kind") == "shutdown":
                    break
                speaker.command(command)
            except (ValueError, TypeError, AttributeError):
                emit("error", error="invalid_command")
    finally:
        speaker.close()


if __name__ == "__main__":
    main()
