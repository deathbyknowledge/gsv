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
  host/packaging/macos/en.lproj/InfoPlist.strings \
  host/apps/desktop/Entitlements.plist \
  host/helpers/transcriber/THIRD_PARTY.md \
  web/public/brand/gsv-ship.png; do
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
binary_names="$(cargo metadata --locked --no-deps --format-version 1 --manifest-path "$repository_root/host/Cargo.toml" | python3 -c '
import json, sys
packages = {"desktop", "gsv", "machine", "transcriber"}
print(" ".join(target["name"] for package in json.load(sys.stdin)["packages"] if package["name"] in packages
    for target in package["targets"] if "bin" in target["kind"]))
')"
read -r -a binaries <<< "$binary_names"
for binary in "${binaries[@]}"; do
  cp "$scratch/executable" "$binary_dir/$binary"
done

mkdir -p "$binary_dir/gsv-transcribe-runtime"
printf 'int transcribe_fixture(void) { return 0; }\n' | clang -dynamiclib -x c - -o "$binary_dir/gsv-transcribe-runtime/libtranscribe.dylib"
printf 'int backend_fixture(void) { return 0; }\n' | clang -bundle -x c - -o "$binary_dir/gsv-transcribe-runtime/libggml-cpu-x64.so"
codesign --force --sign - "$binary_dir/gsv-transcribe-runtime/libggml-cpu-x64.so"
codesign --remove-signature "$binary_dir/gsv-transcribe-runtime/libggml-cpu-x64.so"

output="$scratch/packaged app"
bash "$fixture/host/scripts/package-macos.sh" --release --skip-build --output "$output"
archives=("$output/"*.zip)
[[ "${#archives[@]}" == 1 && -f "${archives[0]}" ]]
ditto -x -k "${archives[0]}" "$scratch/unpacked"
app="$scratch/unpacked/GSV.app"
codesign --verify --deep --strict "$app"
plutil -lint "$app/Contents/Info.plist"
swift - "$app" <<'SWIFT'
import Foundation
let path = CommandLine.arguments[1]
let bundle = Bundle(path: path)!
assert(bundle.bundleIdentifier == "space.gsv.desktop")
assert(bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String == "Ship")
let displayName = FileManager.default.displayName(atPath: path)
assert(displayName == "Ship" || displayName == "Ship.app", displayName)
SWIFT
cmp "$repository_root/host/helpers/transcriber/THIRD_PARTY.md" \
  "$app/Contents/Resources/licenses/transcriber/THIRD_PARTY.md"
[[ ! -e "$app/Contents/MacOS/THIRD_PARTY.md" ]]
for binary in "${binaries[@]}"; do
  codesign --verify --strict "$app/Contents/MacOS/$binary"
done
codesign --verify --strict "$app/Contents/MacOS/gsv-transcribe-runtime/libtranscribe.dylib"
codesign --verify --strict "$app/Contents/MacOS/gsv-transcribe-runtime/libggml-cpu-x64.so"
printf 'macOS bundle and ZIP signing checks passed\n'
