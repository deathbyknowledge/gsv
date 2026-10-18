#!/usr/bin/env python3
"""Freeze gsv-speak, including Python, pronunciation data and native audio libraries."""

import argparse
import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tempfile


def build(output):
    root = Path(__file__).resolve().parents[2]
    package = root / "host/helpers/speaker"
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gsv-speaker-build-") as temporary:
        stage = Path(temporary)
        notices = stage / "gsv-speak-THIRD_PARTY.md"
        with notices.open("w", encoding="utf-8") as stream:
            stream.write((package / "THIRD_PARTY.md").read_text(encoding="utf-8"))
            python_license = next(path for path in [Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
                                                   Path(sys.base_prefix) / "LICENSE.txt"] if path.is_file())
            stream.write("\n\n## CPython\n\n" + python_license.read_text(encoding="utf-8"))
            for distribution in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata["Name"]):
                name = distribution.metadata["Name"]
                stream.write(f"\n\n## {name} {distribution.version}\n")
                for entry in distribution.files or []:
                    if any(part.lower().startswith(("license", "copying", "notice")) for part in entry.parts):
                        path = distribution.locate_file(entry)
                        if path.is_file():
                            stream.write(f"\n### {entry}\n\n")
                            stream.write(path.read_text(encoding="utf-8", errors="replace"))
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noupx",
            "--name", "gsv-speak", "--distpath", str(stage / "dist"),
            "--workpath", str(stage / "work"), "--specpath", str(stage),
            "--collect-data", "espeakng_loader", "--collect-binaries", "espeakng_loader",
            "--collect-data", "phonemizer", "--collect-data", "kokoro_onnx", "--copy-metadata", "kokoro-onnx",
            "--runtime-hook", str(package / "frozen_audio.py"),
            "--add-data", f"{notices}:.", str(package / "speaker.py"),
        ], check=True)
        executable = "gsv-speak.exe" if sys.platform == "win32" else "gsv-speak"
        # Replace atomically, including when the local preview is still running.
        pending = output / (executable + ".next")
        shutil.copy2(stage / "dist" / executable, pending)
        pending.replace(output / executable)
        shutil.copy2(notices, output / notices.name)
    print(output / executable)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output.resolve())
