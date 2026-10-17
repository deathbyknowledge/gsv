"""Local Kokoro synthesis and playback. Private JSON-lines stdin; status-only stdout."""

import collections
import json
import math
import os
from pathlib import Path
import queue
import sys
import threading

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("ORT_LOGGING_LEVEL", "4")

import numpy as np

RATE = 24000
MAX_LINE = 256 * 1024
VOICES = {"en": ("af_heart", "en-us"), "es": ("ef_dora", "es")}
output_lock = threading.Lock()


def emit(phase, request_id=None, error=None):
    with output_lock:
        print(json.dumps({"phase": phase, "id": request_id, "error": error}), flush=True)


class Speaker:
    def __init__(self, model_dir, silent=False):
        self.model_dir = model_dir
        self.condition = threading.Condition()
        self.generation = 0
        self.closed = False
        self.requests = collections.deque()
        self.audio = collections.deque()
        self.offset = 0
        self.playing = None
        self.events = queue.SimpleQueue()
        self.model = None
        self.stream = None
        self.silent = silent
        self.worker = threading.Thread(target=self.generate, daemon=True)
        self.reporter = threading.Thread(target=self.report, daemon=True)
        self.worker.start()
        self.reporter.start()

    def output(self, out, frames, _time, _status):
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
                self.offset += count
                position += count
                if self.offset == len(samples):
                    self.audio.popleft()
                    self.offset = 0
            self.condition.notify_all()

    def report(self):
        while True:
            event = self.events.get()
            if event is None:
                return
            generation, phase, request_id = event
            with self.condition:
                if generation == self.generation:
                    emit(phase, request_id)

    def prepare(self):
        if self.model is not None:
            return
        emit("loading")
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
        emit("ready")

    def append(self, generation, request_id, samples):
        with self.condition:
            self.condition.wait_for(lambda: self.closed or generation != self.generation or len(self.audio) < 3)
            if self.closed or generation != self.generation:
                return False
            if self.silent:
                if samples is None:
                    emit("finished", request_id)
                else:
                    emit("speaking", request_id)
                return True
            if self.stream is None:
                import sounddevice as sd
                self.stream = sd.OutputStream(samplerate=RATE, channels=1, dtype="float32",
                                              blocksize=480, latency="low", callback=self.output)
                self.stream.start()
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
                self.prepare()
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
            except Exception as error:
                with self.condition:
                    if generation == self.generation:
                        self.requests.clear()
                        self.audio.clear()
                        self.offset = 0
                        self.playing = None
                        # Exception messages from phonemizers may contain private input.
                        emit("error", request_id, type(error).__name__)

    def cancel(self):
        with self.condition:
            self.generation += 1
            self.requests.clear()
            self.audio.clear()
            self.offset = 0
            self.playing = None
            self.condition.notify_all()
            emit("idle")

    def command(self, command):
        kind = command.get("kind")
        if kind == "cancel":
            self.cancel()
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
        self.cancel()
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        if self.stream:
            self.stream.abort()
            self.stream.close()
        self.events.put(None)


def main():
    speaker = Speaker(Path(os.environ["GSV_SPEAK_MODEL_DIR"]), "--silent" in sys.argv)
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
