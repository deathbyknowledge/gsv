"""Fetch and verify the pinned model; optionally reuse an existing local audition cache."""
import hashlib
import os
from pathlib import Path
import shutil
import urllib.request

ROOT = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
FILES = [
    ("model.onnx", "kokoro-v1.0.onnx", "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a", "model-fp32.onnx"),
    ("voices.bin", "voices-v1.0.bin", "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d", "voices.bin"),
]


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    directory = Path(os.environ["GSV_SPEAK_MODEL_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    source_dir = os.environ.get("GSV_SPEAK_MODEL_SOURCE_DIR")
    for name, remote, expected, source_name in FILES:
        destination = directory / name
        if destination.is_file() and digest(destination) == expected:
            continue
        temporary = directory / (name + ".partial")
        print(f"Preparing {name}…", flush=True)
        if source_dir and (Path(source_dir) / source_name).is_file():
            shutil.copyfile(Path(source_dir) / source_name, temporary)
        else:
            with urllib.request.urlopen(ROOT + remote, timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
        if digest(temporary) != expected:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {name}")
        temporary.replace(destination)
    print("Kokoro model and voices verified.")


if __name__ == "__main__":
    main()
