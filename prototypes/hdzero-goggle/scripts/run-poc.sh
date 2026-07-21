#!/usr/bin/env bash
set -euo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $EUID -eq 0 ]]; then
  echo "Refusing to run the HDZero emulator as root." >&2
  exit 1
fi

configure_display() {
  if [[ -n ${SDL_VIDEODRIVER:-} || -n ${WAYLAND_DISPLAY:-} || -n ${DISPLAY:-} ]]; then
    return
  fi

  local runtime_dir=${XDG_RUNTIME_DIR:-"/run/user/$UID"}
  local socket
  for socket in "$runtime_dir"/wayland-*; do
    if [[ -S "$socket" ]]; then
      export XDG_RUNTIME_DIR="$runtime_dir"
      export XDG_SESSION_TYPE=wayland
      export WAYLAND_DISPLAY=${socket##*/}
      export SDL_VIDEODRIVER=wayland
      echo "Using Wayland display $WAYLAND_DISPLAY discovered from this TTY."
      return
    fi
  done

  for socket in /tmp/.X11-unix/X*; do
    if [[ -S "$socket" ]]; then
      export DISPLAY=":${socket##*X}"
      export SDL_VIDEODRIVER=x11
      echo "Using X11 display $DISPLAY discovered from this TTY."
      return
    fi
  done

  echo "No graphical display is available for the HDZero SDL emulator." >&2
  echo "Run it from a desktop terminal, use SSH X forwarding, or set SDL_VIDEODRIVER=dummy for a headless smoke test." >&2
  exit 1
}

configure_display

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
