#!/usr/bin/env python3
"""Package the transcription libraries and CPU variants staged by Cargo."""

import argparse
from pathlib import Path
import tarfile
import zipfile


def package_runtime(binary_dir: Path, platform: str, output: Path):
    runtime = binary_dir / "gsv-transcribe-runtime"
    files = sorted(path for path in runtime.iterdir() if path.is_file())
    if not files or not any("transcribe" in path.name for path in files):
        raise ValueError("transcription runtime is missing")
    if platform.endswith("-x64") and not any("ggml-cpu-x64." in path.name for path in files):
        raise ValueError("baseline x86-64 CPU backend is missing")
    output.mkdir(parents=True, exist_ok=True)
    stem = f"gsv-transcribe-runtime-{platform}"
    if platform.startswith("windows-"):
        archive = output / f"{stem}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in files:
                bundle.write(path, f"{runtime.name}/{path.name}")
    else:
        archive = output / f"{stem}.tar.gz"
        with tarfile.open(archive, "w:gz", dereference=True) as bundle:
            for path in files:
                bundle.add(path, arcname=f"{runtime.name}/{path.name}", recursive=False)
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary-dir", type=Path, required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--output", type=Path, default=Path("release"))
    args = parser.parse_args()
    print(package_runtime(args.binary_dir, args.platform, args.output))
