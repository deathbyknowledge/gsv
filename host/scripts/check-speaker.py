#!/usr/bin/env python3
"""Exercise the shipped speaker without a source checkout, Python or an audio device."""

import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading


def check(binary, model_source=None):
    with tempfile.TemporaryDirectory(prefix="gsv-speaker-smoke-") as temporary:
        directory = Path(temporary)
        executable = directory / binary.name
        shutil.copy2(binary, executable)
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("PYTHON", "GSV_SPEAK"))}
        environment["PATH"] = str(directory)
        environment["GSV_SPEAK_MODEL_DIR"] = str(directory / "models")
        if sys.platform == "linux":
            audio_config = directory / "asound.conf"
            audio_config.write_text("pcm.!default { type null }\n")
            environment["ALSA_CONFIG_PATH"] = str(audio_config)
        if model_source:
            # Local checks can reuse verified assets; CI exercises the first-use download.
            source = directory / "source"
            source.mkdir()
            shutil.copy2(model_source / "model.onnx", source / "model-fp32.onnx")
            shutil.copy2(model_source / "voices.bin", source / "voices.bin")
            environment["GSV_SPEAK_MODEL_SOURCE_DIR"] = str(source)
        runtime = subprocess.run([executable, "--check-runtime"], cwd=directory, env=environment,
                                 capture_output=True, text=True, timeout=60, check=True)
        status = json.loads(runtime.stdout)
        assert status["runtime"] == "ready" and status["bundled_audio"], status
        process = subprocess.Popen([executable, "--silent"], cwd=directory, env=environment,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        events = queue.Queue()
        def read():
            for line in process.stdout:
                events.put(json.loads(line))
            events.put(None)
        threading.Thread(target=read, daemon=True).start()
        def send(command):
            process.stdin.write(json.dumps(command) + "\n")
            process.stdin.flush()
        def wait_for(phase, request_id=None):
            while True:
                event = events.get(timeout=180)
                assert event is not None, "speaker exited before completing the operation"
                assert event["phase"] != "error", event
                if event["phase"] == phase and (request_id is None or event["id"] == request_id):
                    return
        try:
            wait_for("idle")
            for language, text in [("en", "Your Ship is ready."), ("es", "Tu Ship está lista.")]:
                send({"kind": "speak", "id": language, "language": language, "chunks": [text]})
                wait_for("finished", language)
            send({"kind": "cancel"})
            wait_for("idle")
            assert (directory / "models/model.onnx").is_file()
            assert (directory / "models/voices.bin").is_file()
            assert not list((directory / "models").glob("*.partial"))
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
        assert process.returncode == 0, process.stderr.read()
        print("Packaged speech runtime, first-use setup, English/Spanish synthesis and EOF shutdown passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--model-source", type=Path)
    arguments = parser.parse_args()
    check(arguments.binary.resolve(), arguments.model_source)
