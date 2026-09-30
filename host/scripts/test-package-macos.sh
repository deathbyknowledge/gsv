#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { printf 'run this test on macOS\n' >&2; exit 1; }

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/gsv-macos-package-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
fixture="$scratch/repository"

for path in \
  LICENSE \
  host/Cargo.toml \
  host/scripts/package-macos.sh \
  host/packaging/macos/Info.plist \
  host/apps/desktop/Entitlements.plist \
  host/helpers/transcriber/THIRD_PARTY.md \
  host/helpers/gestures/THIRD_PARTY.md \
  host/helpers/gestures/models/LICENSE.apache-2.0 \
  host/helpers/gestures/models/PROVENANCE.md \
  web/public/icons/gsv-512.png; do
  mkdir -p "$fixture/$(dirname "$path")"
  cp "$repository_root/$path" "$fixture/$path"
done

case "$(uname -m)" in
  arm64) export CARGO_BUILD_TARGET=aarch64-apple-darwin ;;
  x86_64) export CARGO_BUILD_TARGET=x86_64-apple-darwin ;;
  *) printf 'unsupported macOS architecture\n' >&2; exit 1 ;;
esac
binary_dir="$fixture/host/target/$CARGO_BUILD_TARGET/release"
mkdir -p "$binary_dir"
printf 'int main(void) { return 0; }\n' | clang -x c - -o "$scratch/executable"
# Start with unsigned helpers on both architectures so signing order is tested.
codesign --force --sign - "$scratch/executable"
codesign --remove-signature "$scratch/executable"
for binary in gsv-desktop gsv gsvd gsv-vision gsv-transcribe; do
  cp "$scratch/executable" "$binary_dir/$binary"
done

output="$scratch/packaged app"
bash "$fixture/host/scripts/package-macos.sh" --release --skip-build --output "$output"
archives=("$output/"*.zip)
[[ "${#archives[@]}" == 1 && -f "${archives[0]}" ]]
ditto -x -k "${archives[0]}" "$scratch/unpacked"
app="$scratch/unpacked/GSV.app"
codesign --verify --deep --strict "$app"
plutil -lint "$app/Contents/Info.plist"
cmp "$repository_root/host/helpers/transcriber/THIRD_PARTY.md" \
  "$app/Contents/Resources/licenses/transcriber/THIRD_PARTY.md"
[[ ! -e "$app/Contents/MacOS/THIRD_PARTY.md" ]]
for binary in gsv-desktop gsv gsvd gsv-vision gsv-transcribe; do
  codesign --verify --strict "$app/Contents/MacOS/$binary"
done
printf 'macOS bundle and ZIP signing checks passed\n'
