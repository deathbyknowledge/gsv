#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FIXTURES="$TEST_ROOT/release"
PINNED_FIXTURES="$TEST_ROOT/pinned-release"
FAKE_BIN="$TEST_ROOT/bin"
INSTALL_DIR="$TEST_ROOT/install"
PINNED_INSTALL_DIR="$TEST_ROOT/pinned-install"
TEST_HOME="$TEST_ROOT/home"
mkdir -p \
    "$FIXTURES" \
    "$PINNED_FIXTURES" \
    "$FAKE_BIN" \
    "$INSTALL_DIR" \
    "$PINNED_INSTALL_DIR" \
    "$TEST_HOME"

make_fixture() {
    local name="$1"
    local marker="$2"
    printf '#!/usr/bin/env sh\nprintf "%%s\\n" "%s"\n' "$marker" > "$FIXTURES/$name"
    chmod 0755 "$FIXTURES/$name"
}

write_checksums() {
    (
        cd "$FIXTURES"
        sha256sum gsv-* gsvd-* install.sh > checksums.txt
    )
}

make_fixture gsv-linux-x64 gsv-v1
make_fixture gsvd-linux-x64 gsvd-v1
make_fixture gsv-desktop-linux-x64 desktop-v1
make_fixture gsv-transcribe-linux-x64 transcribe-v1
make_fixture gsv-vision-linux-x64 vision-v1
printf 'license-v1\n' > "$FIXTURES/gsv-transcribe-THIRD_PARTY.md"
printf 'vision-license-v1\n' > "$FIXTURES/gsv-vision-LICENSE.apache-2.0"
printf 'vision-provenance-v1\n' > "$FIXTURES/gsv-vision-PROVENANCE.md"
cp "$REPOSITORY_ROOT/install.sh" "$FIXTURES/install.sh"
write_checksums

cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) output="$2"; shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
asset="${url%%\?*}"
asset="${asset##*/}"
cp "$GSV_TEST_RELEASE_DIR/$asset" "$output"
SH
chmod 0755 "$FAKE_BIN/curl"

cat > "$PINNED_FIXTURES/install.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "${GSV_INSTALLER_RELEASE_BOUND:-0}" = "1"
printf '%s:%s\n' "$GSV_VERSION" "$GSV_INSTALLER_RELEASE_BOUND" \
    > "$GSV_INSTALL_DIR/pinned-installer-ran"
SH
chmod 0755 "$PINNED_FIXTURES/install.sh"
(
    cd "$PINNED_FIXTURES"
    sha256sum install.sh > checksums.txt
)

run_pinned_installer() {
    env \
        HOME="$TEST_HOME" \
        PATH="$FAKE_BIN:$PATH" \
        GSV_INSTALL_DIR="$PINNED_INSTALL_DIR" \
        GSV_INSTALLER_RELEASE_BOUND=0 \
        GSV_TEST_RELEASE_DIR="$PINNED_FIXTURES" \
        GSV_VERSION="v-legacy" \
        bash "$REPOSITORY_ROOT/install.sh" >/dev/null
}

run_pinned_installer
test "$(cat "$PINNED_INSTALL_DIR/pinned-installer-ran")" = "v-legacy:1"
rm "$PINNED_INSTALL_DIR/pinned-installer-ran"
printf '\n# changed after checksums were written\n' >> "$PINNED_FIXTURES/install.sh"
if run_pinned_installer 2>/dev/null; then
    echo "installer accepted a pinned release installer that did not match checksums.txt" >&2
    exit 1
fi
test ! -e "$PINNED_INSTALL_DIR/pinned-installer-ran"

run_installer() {
    env \
        HOME="$TEST_HOME" \
        PATH="$FAKE_BIN:$PATH" \
        GSV_INSTALL_DIR="$INSTALL_DIR" \
        GSV_INSTALLER_RELEASE_BOUND=0 \
        GSV_TEST_RELEASE_DIR="$FIXTURES" \
        GSV_VERSION="v-test" \
        bash "$REPOSITORY_ROOT/install.sh" >/dev/null
}

run_installer
test "$("$INSTALL_DIR/gsv")" = "gsv-v1"
test "$("$INSTALL_DIR/gsvd")" = "gsvd-v1"
test "$("$INSTALL_DIR/gsv-desktop")" = "desktop-v1"
test "$("$INSTALL_DIR/gsv-transcribe")" = "transcribe-v1"
test "$("$INSTALL_DIR/gsv-vision")" = "vision-v1"
test "$(cat "$INSTALL_DIR/gsv-transcribe-THIRD_PARTY.md")" = "license-v1"
test "$(cat "$INSTALL_DIR/gsv-vision-LICENSE.apache-2.0")" = "vision-license-v1"
test "$(cat "$INSTALL_DIR/gsv-vision-PROVENANCE.md")" = "vision-provenance-v1"

make_fixture gsv-linux-x64 gsv-corrupt
if run_installer 2>/dev/null; then
    echo "installer accepted an artifact that did not match checksums.txt" >&2
    exit 1
fi
test "$("$INSTALL_DIR/gsv")" = "gsv-v1"

make_fixture gsv-linux-x64 gsv-v2
make_fixture gsvd-linux-x64 gsvd-v2
make_fixture gsv-desktop-linux-x64 desktop-v2
make_fixture gsv-transcribe-linux-x64 transcribe-v2
make_fixture gsv-vision-linux-x64 vision-v2
printf 'license-v2\n' > "$FIXTURES/gsv-transcribe-THIRD_PARTY.md"
printf 'vision-license-v2\n' > "$FIXTURES/gsv-vision-LICENSE.apache-2.0"
printf 'vision-provenance-v2\n' > "$FIXTURES/gsv-vision-PROVENANCE.md"
write_checksums
cat > "$FAKE_BIN/chmod" <<'SH'
#!/usr/bin/env sh
case "$*" in
    *gsv-vision.new.*) exit 1 ;;
esac
exec /usr/bin/chmod "$@"
SH
/usr/bin/chmod 0755 "$FAKE_BIN/chmod"
if run_installer 2>/dev/null; then
    echo "installer ignored a staged permission failure" >&2
    exit 1
fi
rm "$FAKE_BIN/chmod"
test "$("$INSTALL_DIR/gsv")" = "gsv-v1"
test "$("$INSTALL_DIR/gsvd")" = "gsvd-v1"
test "$("$INSTALL_DIR/gsv-desktop")" = "desktop-v1"
test "$("$INSTALL_DIR/gsv-transcribe")" = "transcribe-v1"
test "$("$INSTALL_DIR/gsv-vision")" = "vision-v1"
test "$(cat "$INSTALL_DIR/gsv-transcribe-THIRD_PARTY.md")" = "license-v1"
test "$(cat "$INSTALL_DIR/gsv-vision-LICENSE.apache-2.0")" = "vision-license-v1"
test "$(cat "$INSTALL_DIR/gsv-vision-PROVENANCE.md")" = "vision-provenance-v1"

echo "host installer checksum and replacement smoke passed"
