#!/usr/bin/env bash
set -euo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $EUID -eq 0 ]]; then
  echo "Refusing to run the HDZero emulator as root." >&2
  exit 1
fi

SOURCE_DIR=$($POC_DIR/scripts/prepare-emulator.sh)
BINARY="$SOURCE_DIR/build-gsv/HDZGOGGLE"

if [[ ! -x "$BINARY" ]]; then
  "$POC_DIR/scripts/build-emulator.sh" >/dev/null
fi

export GSV_HDZERO_SOCKET=${GSV_HDZERO_SOCKET:-"/tmp/gsv-hdzero-${UID}.sock"}

node "$POC_DIR/src/main.mjs" --socket "$GSV_HDZERO_SOCKET" "$@" &
BRIDGE_PID=$!

cleanup() {
  if kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 100); do
  [[ -S "$GSV_HDZERO_SOCKET" ]] && break
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    wait "$BRIDGE_PID"
    exit $?
  fi
  sleep 0.05
done

if [[ ! -S "$GSV_HDZERO_SOCKET" ]]; then
  echo "Bridge did not create $GSV_HDZERO_SOCKET" >&2
  exit 1
fi

cd "$SOURCE_DIR"
"$BINARY"
