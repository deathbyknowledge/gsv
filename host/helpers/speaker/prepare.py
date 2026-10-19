"""Fetch the pinned model into the user's cache before local synthesis."""
import hashlib
import os
from pathlib import Path
import ssl
import sys
import tempfile
import urllib.request

import certifi

ROOT = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
FILES = [
    ("model.onnx", "kokoro-v1.0.onnx", "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a", "model-fp32.onnx"),
    ("voices.bin", "voices-v1.0.bin", "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d", "voices.bin"),
]


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def model_directory():
    if override := os.environ.get("GSV_SPEAK_MODEL_DIR"):
        return Path(override)
    if sys.platform == "win32":
        cache = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    elif sys.platform == "darwin":
        cache = Path.home() / "Library/Caches"
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    return cache / "gsv/speech/kokoro-v1"


class PreparationCancelled(Exception):
    pass


def prepare_model(directory, cancelled=lambda: False):
    directory.mkdir(parents=True, exist_ok=True)
    source_dir = os.environ.get("GSV_SPEAK_MODEL_SOURCE_DIR")
    for name, remote, expected, source_name in FILES:
        if cancelled():
            raise PreparationCancelled()
        destination = directory / name
        if destination.is_file() and digest(destination) == expected:
            continue
        with tempfile.NamedTemporaryFile(dir=directory, prefix=name + ".", suffix=".partial", delete=False) as output:
            temporary = Path(output.name)
        try:
            if source_dir and (Path(source_dir) / source_name).is_file():
                source = (Path(source_dir) / source_name).open("rb")
            else:
                source = urllib.request.urlopen(ROOT + remote, timeout=15,
                                                context=ssl.create_default_context(cafile=certifi.where()))
            with source, temporary.open("wb") as output:
                size = 0
                while chunk := source.read(1024 * 1024):
                    if cancelled():
                        raise PreparationCancelled()
                    size += len(chunk)
                    if size > 400 * 1024 * 1024:
                        raise ValueError("voice_model_too_large")
                    output.write(chunk)
            if digest(temporary) != expected:
                raise ValueError("voice_model_checksum_mismatch")
            if cancelled():
                raise PreparationCancelled()
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    prepare_model(model_directory())
    print("Kokoro model and voices verified.")
