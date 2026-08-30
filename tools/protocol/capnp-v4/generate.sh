#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_dir="$(cd "$prototype_dir/../../.." && pwd)"

if ! command -v capnp >/dev/null 2>&1; then
  echo "capnp 1.5.0 is required to regenerate the prototype" >&2
  exit 1
fi
if ! command -v capnpc-rust >/dev/null 2>&1; then
  echo "capnpc-rust 0.27.0 is required to regenerate Rust bindings" >&2
  exit 1
fi

export PATH="$repository_dir/node_modules/.bin:$PATH"

capnp compile \
  --src-prefix="$prototype_dir/schema" \
  -ots:"$prototype_dir/generated/current" \
  -orust:"$prototype_dir/rust/src" \
  "$prototype_dir/schema/wire-frame.capnp"

capnp compile \
  --src-prefix="$prototype_dir/schema" \
  -ots:"$prototype_dir/generated/v0" \
  -orust:"$prototype_dir/rust/src" \
  "$prototype_dir/schema/wire-frame-v0.capnp"
