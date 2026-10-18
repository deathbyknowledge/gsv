#!/usr/bin/env bash
set -euo pipefail

VOICE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_PACKAGE="$VOICE_REPO/host/helpers/speaker"
VOICE_PREVIEW="$VOICE_REPO/.desktop-voice"
export GSV_SPEAK_MODEL_DIR="${GSV_SPEAK_MODEL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gsv/speech/kokoro-v1}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$VOICE_REPO/host/target}"

cd "$VOICE_REPO"
VOICE_PLATFORM_ARGS=()
if [[ "$(uname -s)" == Darwin ]]; then
    VOICE_ARCH="$(uname -m)"
    VOICE_PLATFORM_ARGS=(--python-platform "${VOICE_ARCH/arm64/aarch64}-apple-darwin")
    VOICE_MACOS_TARGET=13.0
fi
MACOSX_DEPLOYMENT_TARGET="${VOICE_MACOS_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-}}" \
    uv run --frozen --group build --project "$VOICE_PACKAGE" \
    "${VOICE_PLATFORM_ARGS[@]}" \
    python host/scripts/build-speaker.py --output "$VOICE_PREVIEW/bin"
npm run gsv:build
npm run build:desktop --workspace web
cargo build --locked --manifest-path host/Cargo.toml --package desktop

mkdir -p "$VOICE_PREVIEW"
export VOICE_REPO VOICE_PACKAGE VOICE_PREVIEW
python3 - <<'PY'
import os
import shutil
import sys
from pathlib import Path
from shlex import quote

package = Path(os.environ["VOICE_PACKAGE"])
preview = Path(os.environ["VOICE_PREVIEW"])
binaries = preview / "bin"
speaker = binaries / "gsv-speak"
binaries.mkdir(exist_ok=True)
native = binaries / "gsv-desktop"
pending_native = native.with_suffix(".next")
shutil.copy2(Path(os.environ["CARGO_TARGET_DIR"]) / "debug/gsv-desktop", pending_native)
pending_native.replace(native)
desktop = preview / "gsv-desktop"
desktop.write_text("#!/bin/sh\nexport GSV_SPEAK_HELPER=" + quote(str(speaker))
                   + "\nexport GSV_SPEAK_MODEL_DIR=" + quote(os.environ["GSV_SPEAK_MODEL_DIR"])
                   + '\nexport GSV_TRANSCRIBE_HELPER="${GSV_TRANSCRIBE_HELPER:-$HOME/.gsv/bin/gsv-transcribe}"'
                   + "\nexec " + quote(str(native)) + ' "$@"\n')
desktop.chmod(0o755)
if sys.platform == "linux":
    applications = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "applications"
    applications.mkdir(parents=True, exist_ok=True)
    entry = applications / "space.gsv.desktop.desktop"
    if not entry.exists():
        executable = str(desktop).replace("%", "%%")
        for char in ('\\', '"', '$', '`'):
            executable = executable.replace(char, "\\" + char)
        entry.write_text('[Desktop Entry]\nType=Application\nName=Ship\nComment=Local desktop voice preview\n'
                         + 'Exec="' + executable + '"\nTerminal=false\nNoDisplay=true\n')
print("\nRun this preview with:\n  GSV_DESKTOP_PATH=" + quote(str(desktop)) + " gsv desktop")
PY
