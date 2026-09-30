#!/usr/bin/env python3
"""Check the shipped helper without opening a microphone or preparing a model."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    binary = parser.parse_args().binary.resolve(strict=True)

    # Resolve every dynamic import now, including ones otherwise deferred until
    # inference. Unit tests on the build runner cannot catch cross-distro BLAS ABI
    # differences, so Linux artifacts must also contain their own math library.
    result = subprocess.run(
        [str(binary)],
        input='{"type":"shutdown"}\n',
        capture_output=True,
        text=True,
        timeout=15,
        env={**os.environ, "LD_BIND_NOW": "1"},
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

    print("Voice helper handshake, clean shutdown and runtime linkage passed")


if __name__ == "__main__":
    main()
