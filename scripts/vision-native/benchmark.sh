#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'vision-native-benchmark: %s\n' "$1" >&2
  exit 1
}

[[ "$#" -le 1 ]] || die "usage: $0 [report.json]"
command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v git >/dev/null 2>&1 || die "git is required"
command -v rustc >/dev/null 2>&1 || die "rustc is required"

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly requested_output="${1:-$repository_root/host/target/vision-native/benchmark/latest.json}"
if [[ "$requested_output" == /* ]]; then
  readonly output="$requested_output"
else
  readonly output="$PWD/$requested_output"
fi

readonly fixtures="$($script_dir/fixtures.sh)"
readonly revision="$(git -C "$repository_root" rev-parse HEAD)"
readonly rustc_version="$(rustc --version)"
if [[ -n "$(git -C "$repository_root" status --porcelain -- \
  host/crates/gesture-engine host/helpers/gestures host/Cargo.toml host/Cargo.lock \
  scripts/vision-native)" ]]; then
  readonly dirty=true
else
  readonly dirty=false
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  readonly processor="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
elif [[ -r /proc/cpuinfo ]]; then
  processor_name="$(awk -F ': ' '/^model name/ { print $2; exit }' /proc/cpuinfo)"
  readonly processor="${processor_name:-$(uname -m)}"
else
  readonly processor="$(uname -m)"
fi

GESTURE_ENGINE_BENCHMARK_FIXTURES="$fixtures" \
GESTURE_ENGINE_BENCHMARK_OUTPUT="$output" \
GESTURE_ENGINE_BENCHMARK_REVISION="$revision" \
GESTURE_ENGINE_BENCHMARK_DIRTY="$dirty" \
GESTURE_ENGINE_BENCHMARK_RUSTC="$rustc_version" \
GESTURE_ENGINE_BENCHMARK_CPU="$processor" \
  cargo test --release --manifest-path "$repository_root/host/Cargo.toml" \
  --package gesture-engine \
  vision::benchmark::benchmarks_native_pipeline -- --ignored --exact --nocapture

printf 'Native gesture benchmark report: %s\n' "$output"
