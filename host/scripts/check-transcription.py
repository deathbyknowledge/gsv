#!/usr/bin/env python3
"""Run streaming speech inference against a pinned recording, without a microphone."""

import argparse
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import wave


FIXTURE_URL = (
    "https://raw.githubusercontent.com/ggml-org/whisper.cpp/"
    "b0a11594aec50892a02cd8d129eee2dfe93a8bb8/samples/jfk.wav"
)
FIXTURE_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    with urllib.request.urlopen(FIXTURE_URL, timeout=30) as response:
        data = response.read(352_079)
    if len(data) != 352_078 or hashlib.sha256(data).hexdigest() != FIXTURE_SHA256:
        raise SystemExit("recorded speech fixture failed checksum verification")
    with wave.open(io.BytesIO(data)) as recording:
        if (
            recording.getnchannels() != 1
            or recording.getframerate() != 16_000
            or recording.getsampwidth() != 2
            or recording.getcomptype() != "NONE"
        ):
            raise SystemExit("recorded speech must be 16 kHz mono signed 16-bit PCM")
        pcm = recording.readframes(recording.getnframes())
    host = Path(__file__).resolve().parent.parent
    command = ["cargo", "test", "--locked", "--manifest-path", str(host / "Cargo.toml")]
    if args.release:
        command.append("--release")
    command.extend(["--package", "transcriber", "transcribes_recorded_audio", "--", "--ignored"])
    with tempfile.TemporaryDirectory(prefix="gsv-transcription-") as directory:
        fixture = Path(directory) / "speech.pcm"
        fixture.write_bytes(pcm)
        subprocess.run(
            command,
            check=True,
            timeout=600,
            env={**os.environ, "GSV_TRANSCRIBE_TEST_AUDIO": str(fixture)},
        )
    print("Recorded speech inference and final transcript passed")


if __name__ == "__main__":
    main()
