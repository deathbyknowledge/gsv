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

# Service-manager and privilege calls must never reach the real machine from a
# test: systemctl records what it was asked and succeeds, sudo always fails.
SYSTEMCTL_LOG="$TEST_ROOT/systemctl.log"
cat > "$FAKE_BIN/systemctl" <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "${GSV_TEST_SYSTEMCTL_LOG:-/dev/null}"
exit 0
SH
chmod 0755 "$FAKE_BIN/systemctl"
printf '#!/usr/bin/env sh\nexit 1\n' > "$FAKE_BIN/sudo"
chmod 0755 "$FAKE_BIN/sudo"
# uname can be told to report macOS so the launchd paths get exercised here.
cat > "$FAKE_BIN/uname" <<'SH'
#!/usr/bin/env sh
if [ -n "${GSV_TEST_UNAME_S:-}" ]; then
    case "$1" in
        -s) printf '%s\n' "$GSV_TEST_UNAME_S"; exit 0 ;;
        -m) printf 'x86_64\n'; exit 0 ;;
    esac
fi
exec /usr/bin/uname "$@"
SH
chmod 0755 "$FAKE_BIN/uname"
printf '#!/usr/bin/env sh\nexit 1\n' > "$FAKE_BIN/launchctl"
chmod 0755 "$FAKE_BIN/launchctl"

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
    env -u XDG_CONFIG_HOME \
        HOME="$TEST_HOME" \
        PATH="$FAKE_BIN:$PATH" \
        GSV_TEST_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
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
    env -u XDG_CONFIG_HOME \
        HOME="$TEST_HOME" \
        PATH="$FAKE_BIN:$PATH" \
        GSV_TEST_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
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
make_fixture gsv-darwin-x64 gsv-mac
make_fixture gsvd-darwin-x64 gsvd-mac
make_fixture gsv-desktop-darwin-x64 desktop-mac
make_fixture gsv-transcribe-darwin-x64 transcribe-mac
make_fixture gsv-vision-darwin-x64 vision-mac
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

# A fresh install with no GSV_INSTALL_DIR goes to ~/.gsv/bin and puts it on
# PATH once, however often the installer runs.
DEFAULT_HOME="$TEST_ROOT/default-home"
mkdir -p "$DEFAULT_HOME"
printf '# existing profile\n' > "$DEFAULT_HOME/.bashrc"
run_default_installer() {
    env -u GSV_INSTALL_DIR -u XDG_CONFIG_HOME \
        HOME="$DEFAULT_HOME" \
        SHELL="/bin/bash" \
        PATH="$FAKE_BIN:/usr/bin:/bin" \
        GSV_INSTALLER_RELEASE_BOUND=0 \
        GSV_TEST_RELEASE_DIR="$FIXTURES" \
        GSV_TEST_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
        GSV_LEGACY_INSTALL_DIR="$TEST_ROOT/no-legacy" \
        GSV_VERSION="v-test" \
        "$@" bash "$REPOSITORY_ROOT/install.sh"
}
DEFAULT_OUTPUT="$(run_default_installer env)"
test "$("$DEFAULT_HOME/.gsv/bin/gsv")" = "gsv-v2"
test "$("$DEFAULT_HOME/.gsv/bin/gsvd")" = "gsvd-v2"
printf '%s\n' "$DEFAULT_OUTPUT" | grep -q "Added $DEFAULT_HOME/.gsv/bin to PATH in ~/.profile, ~/.bashrc"
printf '%s\n' "$DEFAULT_OUTPUT" | grep -q 'Open a new shell, or run now: export PATH="$HOME/.gsv/bin:$PATH"'
test "$(grep -c 'Added by the GSV installer' "$DEFAULT_HOME/.profile")" = "1"
test "$(grep -c 'Added by the GSV installer' "$DEFAULT_HOME/.bashrc")" = "1"
test ! -e "$DEFAULT_HOME/.zshrc"
grep -q '^case ":$PATH:" in \*":$HOME/.gsv/bin:"\*) ;; \*) export PATH="$HOME/.gsv/bin:$PATH" ;; esac # Added by the GSV installer$' "$DEFAULT_HOME/.profile"
# The guarded line is valid sh and prepends the directory exactly once.
test "$(HOME="$DEFAULT_HOME" PATH="/usr/bin:/bin" sh -c ". \"$DEFAULT_HOME/.profile\"; . \"$DEFAULT_HOME/.profile\"; printf '%s' \"\$PATH\"")" = "$DEFAULT_HOME/.gsv/bin:/usr/bin:/bin"
run_default_installer env >/dev/null
test "$(grep -c 'Added by the GSV installer' "$DEFAULT_HOME/.profile")" = "1"
test "$(grep -c 'Added by the GSV installer' "$DEFAULT_HOME/.bashrc")" = "1"

# Opting out leaves every profile untouched; a PATH that already has the
# directory needs nothing.
OPT_OUT_HOME="$TEST_ROOT/opt-out-home"
mkdir -p "$OPT_OUT_HOME"
DEFAULT_HOME="$OPT_OUT_HOME" run_default_installer env GSV_NO_MODIFY_PATH=1 | grep -q "Left PATH alone"
test ! -e "$OPT_OUT_HOME/.profile"
ON_PATH_HOME="$TEST_ROOT/on-path-home"
mkdir -p "$ON_PATH_HOME"
DEFAULT_HOME="$ON_PATH_HOME" run_default_installer env PATH="$ON_PATH_HOME/.gsv/bin:$FAKE_BIN:/usr/bin:/bin" >/dev/null
test ! -e "$ON_PATH_HOME/.profile"

# An installation the gsvd service already runs from stays where it is, with
# the migration hint, and nothing lands in ~/.gsv/bin.
EXISTING_HOME="$TEST_ROOT/existing-home"
LEGACY_DIR="$TEST_ROOT/legacy-bin"
mkdir -p "$EXISTING_HOME/.config/systemd/user" "$LEGACY_DIR"
cp "$INSTALL_DIR/gsv" "$LEGACY_DIR/gsv"
cp "$INSTALL_DIR/gsvd" "$LEGACY_DIR/gsvd"
printf '[Service]\nExecStart="%s/gsvd" "--foreground"\n' "$LEGACY_DIR" > "$EXISTING_HOME/.config/systemd/user/gsvd.service"
chmod 0555 "$LEGACY_DIR"
EXISTING_OUTPUT="$(DEFAULT_HOME="$EXISTING_HOME" run_default_installer env 2>&1 || true)"
chmod 0755 "$LEGACY_DIR"
if [ "$(id -u)" != "0" ]; then
    # Without sudo the read-only legacy directory cannot be updated, which is
    # the point: the installer must not fall back to ~/.gsv/bin instead.
    printf '%s\n' "$EXISTING_OUTPUT" | grep -q "Updating the existing installation in $LEGACY_DIR. Automatic daemon updates need a directory this user can write"
    printf '%s\n' "$EXISTING_OUTPUT" | grep -q 'GSV_INSTALL_DIR="$HOME/.gsv/bin" bash'
fi
test ! -e "$EXISTING_HOME/.gsv/bin"
test ! -e "$EXISTING_HOME/.profile"
EXISTING_OUTPUT="$(DEFAULT_HOME="$EXISTING_HOME" run_default_installer env)"
printf '%s\n' "$EXISTING_OUTPUT" | grep -q "Updating the existing installation in $LEGACY_DIR"
test "$("$LEGACY_DIR/gsv")" = "gsv-v2"
test "$("$LEGACY_DIR/gsvd")" = "gsvd-v2"
test ! -e "$EXISTING_HOME/.gsv/bin"
test ! -e "$EXISTING_HOME/.profile"
grep -q -- "--user stop gsvd.service" "$SYSTEMCTL_LOG"

# A writable installation in the old default location is also kept in place,
# without the migration warning.
LEGACY_DEFAULT_HOME="$TEST_ROOT/legacy-default-home"
LEGACY_DEFAULT_DIR="$TEST_ROOT/legacy-default-bin"
mkdir -p "$LEGACY_DEFAULT_HOME" "$LEGACY_DEFAULT_DIR"
cp "$INSTALL_DIR/gsv" "$LEGACY_DEFAULT_DIR/gsv"
LEGACY_OUTPUT="$(DEFAULT_HOME="$LEGACY_DEFAULT_HOME" run_default_installer env GSV_LEGACY_INSTALL_DIR="$LEGACY_DEFAULT_DIR")"
printf '%s\n' "$LEGACY_OUTPUT" | grep -q "Updating the existing installation in $LEGACY_DEFAULT_DIR$"
test "$("$LEGACY_DEFAULT_DIR/gsvd")" = "gsvd-v2"
test ! -e "$LEGACY_DEFAULT_HOME/.gsv/bin"
test ! -e "$LEGACY_DEFAULT_HOME/.profile"

# A daemon that Desktop enrolled from inside its application bundle is not an
# existing installation: nothing is written into the bundle, its service is
# left alone, and the command-line install goes to the default directory.
assert_bundle_left_alone() {
    local home="$1"
    local bundle_dir="$2"
    local output="$3"
    printf '%s\n' "$output" | grep -q "The Desktop application manages the gsvd service and updates it; adding a separate command-line installation in $home/.gsv/bin"
    test "$("$bundle_dir/gsv")" = "bundled-gsv"
    test "$("$bundle_dir/gsvd")" = "bundled-gsvd"
    test "$(find "$bundle_dir" -type f | wc -l)" = "2"
    test -x "$home/.gsv/bin/gsv"
    test "$(grep -c 'Added by the GSV installer' "$home/.profile")" = "1"
}
BUNDLE_MAC_HOME="$TEST_ROOT/bundle-mac-home"
BUNDLE_MAC_DIR="$TEST_ROOT/Applications/GSV.app/Contents/MacOS"
mkdir -p "$BUNDLE_MAC_HOME/Library/LaunchAgents" "$BUNDLE_MAC_DIR"
printf '#!/usr/bin/env sh\nprintf "bundled-gsv\\n"\n' > "$BUNDLE_MAC_DIR/gsv"
printf '#!/usr/bin/env sh\nprintf "bundled-gsvd\\n"\n' > "$BUNDLE_MAC_DIR/gsvd"
chmod 0755 "$BUNDLE_MAC_DIR/gsv" "$BUNDLE_MAC_DIR/gsvd"
cat > "$BUNDLE_MAC_HOME/Library/LaunchAgents/gsvd.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>gsvd</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUNDLE_MAC_DIR/gsvd</string>
    <string>--foreground</string>
  </array>
</dict>
</plist>
PLIST
: > "$SYSTEMCTL_LOG"
BUNDLE_OUTPUT="$(DEFAULT_HOME="$BUNDLE_MAC_HOME" run_default_installer env GSV_TEST_UNAME_S=Darwin)"
assert_bundle_left_alone "$BUNDLE_MAC_HOME" "$BUNDLE_MAC_DIR" "$BUNDLE_OUTPUT"
test "$("$BUNDLE_MAC_HOME/.gsv/bin/gsv")" = "gsv-mac"
test "$("$BUNDLE_MAC_HOME/.gsv/bin/gsvd")" = "gsvd-mac"
test -e "$BUNDLE_MAC_HOME/Library/LaunchAgents/gsvd.plist"
test ! -s "$SYSTEMCTL_LOG"

BUNDLE_LINUX_HOME="$TEST_ROOT/bundle-linux-home"
BUNDLE_LINUX_DIR="$TEST_ROOT/opt/GSV.app/Contents/MacOS"
mkdir -p "$BUNDLE_LINUX_HOME/.config/systemd/user" "$BUNDLE_LINUX_DIR"
printf '#!/usr/bin/env sh\nprintf "bundled-gsv\\n"\n' > "$BUNDLE_LINUX_DIR/gsv"
printf '#!/usr/bin/env sh\nprintf "bundled-gsvd\\n"\n' > "$BUNDLE_LINUX_DIR/gsvd"
chmod 0755 "$BUNDLE_LINUX_DIR/gsv" "$BUNDLE_LINUX_DIR/gsvd"
printf '[Service]\nExecStart="%s/gsvd" "--foreground"\n' "$BUNDLE_LINUX_DIR" > "$BUNDLE_LINUX_HOME/.config/systemd/user/gsvd.service"
BUNDLE_OUTPUT="$(DEFAULT_HOME="$BUNDLE_LINUX_HOME" run_default_installer env)"
assert_bundle_left_alone "$BUNDLE_LINUX_HOME" "$BUNDLE_LINUX_DIR" "$BUNDLE_OUTPUT"
test "$("$BUNDLE_LINUX_HOME/.gsv/bin/gsv")" = "gsv-v2"
test ! -s "$SYSTEMCTL_LOG"

echo "host installer checksum, replacement, default directory, PATH, and bundle smoke passed"
