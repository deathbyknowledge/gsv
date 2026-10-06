#!/usr/bin/env python3
"""Check the shipped helper without opening a microphone or preparing a model."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    binary = parser.parse_args().binary.resolve(strict=True)

    # Resolve every dynamic import now, including ones otherwise deferred until
    # inference. Unit tests on the build runner cannot catch cross-distro BLAS ABI
    # differences, so Linux artifacts must also contain their own math library.
    runtime = binary.parent / "gsv-transcribe-runtime"
    with tempfile.TemporaryDirectory(prefix="gsv-helper-check-") as directory:
        installed = Path(directory) / binary.name
        shutil.copy2(binary, installed)
        shutil.copytree(runtime, installed.parent / runtime.name)
        environment = {**os.environ, "LD_BIND_NOW": "1"}
        for key in ["LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "GGML_BACKEND_PATH"]:
            environment.pop(key, None)
        environment["PATH"] = str(installed.parent / runtime.name) + os.pathsep + environment.get("PATH", "")
        result = subprocess.run(
            [str(installed)],
            input='{"type":"shutdown"}\n',
            capture_output=True,
            text=True,
            timeout=15,
            cwd=directory,
            env=environment,
        )
    if result.returncode != 0:
        raise SystemExit(f"voice helper exited {result.returncode}:\n{result.stderr}")
    events = [json.loads(line) for line in result.stdout.splitlines()]
    if events != [{
        "type": "hello",
        "protocol_version": 2,
        "contract": "gsv-voice-v2-continuous-segments",
    }]:
        raise SystemExit(f"unexpected voice helper handshake: {events!r}")

    if sys.platform == "linux":
        for artifact in [binary, *runtime.iterdir()]:
            check_linux_linkage(artifact)

    print("Voice helper relocation, handshake, clean shutdown and runtime linkage passed")


def check_linux_linkage(binary):
    sections = subprocess.check_output(
        ["readelf", "--sections", "--wide", str(binary)], text=True
    )
    if re.search(r"\]\s+\.(?:ctors|dtors)\s", sections):
        raise SystemExit(
            "voice helper contains legacy constructors that may never run; "
            "link with GNU ld so static OpenBLAS is initialized"
        )
    dynamic = subprocess.check_output(["readelf", "--dynamic", str(binary)], text=True)
    dependencies = re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic)
    external_math = [
        name for name in dependencies
        if re.match(r"lib(?:openblas|blas|cblas|lapack|gfortran|quadmath|gomp)", name)
    ]
    if external_math:
        raise SystemExit(f"voice helper requires external math libraries: {external_math}")
    symbols = subprocess.check_output(
        ["readelf", "--dyn-syms", "--wide", str(binary)], text=True
    )
    if re.search(r"\bUND\b[^\n]*\bcblas_", symbols):
        raise SystemExit("voice helper has unresolved CBLAS imports")


if __name__ == "__main__":
    main()
