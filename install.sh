#!/usr/bin/env bash
# Install one verified, same-version GSV host distribution.

set -euo pipefail

REPO="deathbyknowledge/gsv"
# New installations go to a per-user directory so the daemon can update itself
# without privileges. GSV_INSTALL_DIR overrides it; an existing installation is
# updated where it is.
DEFAULT_INSTALL_DIR="${HOME}/.gsv/bin"
# Where installations landed before the per-user default; overridable so a
# machine with an unrelated system-wide install can be told to ignore it.
LEGACY_INSTALL_DIR="${GSV_LEGACY_INSTALL_DIR:-/usr/local/bin}"
INSTALL_DIR=""
INSTALL_DIR_SOURCE=""
# Set when the gsvd service runs from inside the Desktop application bundle,
# which Desktop updates as a whole; the installer leaves it alone.
DESKTOP_MANAGED_DAEMON=0
CHANNEL="${GSV_CHANNEL:-stable}"
VERSION="${GSV_VERSION:-}"
if [ "$(uname -s)" = "Darwin" ]; then
    CONFIG_HOME="${HOME}/Library/Application Support"
else
    CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
fi
CONFIG_DIR="${CONFIG_HOME}/gsv"
DEV_RELEASE_TAG="dev"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "  ${CYAN}→${NC} $1"; }
success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
error() { echo -e "  ${RED}✗${NC} $1" >&2; }

detect_platform() {
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "$OS" in
        linux|darwin) ;;
        msys*|mingw*|cygwin*)
            error "Use install.ps1 on Windows."
            exit 1
            ;;
        *) error "Unsupported OS: $OS"; exit 1 ;;
    esac
    case "$ARCH" in
        x86_64|amd64) ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) error "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    PLATFORM="${OS}-${ARCH}"
}

validate_channel() {
    case "$CHANNEL" in
        stable|dev) ;;
        *) error "Invalid channel: $CHANNEL (must be stable or dev)"; exit 1 ;;
    esac
    if [ -n "$VERSION" ]; then
        case "$VERSION" in
            *[!A-Za-z0-9._-]*) error "Invalid GSV_VERSION release tag"; exit 1 ;;
        esac
    fi
}

# Turn a plist string back into the path it encodes: the five XML entities
# and their numeric forms. `&amp;` goes last so an encoded entity stays literal.
decode_plist_string() {
    sed -e 's/&lt;/</g; s/&#60;/</g' \
        -e 's/&gt;/>/g; s/&#62;/>/g' \
        -e 's/&quot;/"/g; s/&#34;/"/g' \
        -e "s/&apos;/'/g; s/&#39;/'/g" \
        -e 's/&#38;/\&/g; s/&amp;/\&/g'
}

# The first word of a systemd ExecStart line: the CLI writes it as a
# double-quoted string with embedded quotes and backslashes escaped.
decode_exec_start_program() {
    local line="$1"
    case "$line" in
        \"*)
            printf '%s\n' "$line" \
                | sed -n 's/^"\(\([^"\\]\|\\.\)*\)".*/\1/p' \
                | sed 's/\\\(.\)/\1/g'
            ;;
        *) printf '%s\n' "${line%% *}" ;;
    esac
}

# The program a previous installation registered as the gsvd service, if any:
# gsvd itself, or gsv from the `gsv device run` compatibility launcher.
service_definition_executable() {
    local line=""
    if [ "$OS" = "linux" ]; then
        local unit="${CONFIG_HOME}/systemd/user/gsvd.service"
        [ -f "$unit" ] || return 0
        line="$(grep -m 1 '^ExecStart=' "$unit" || true)"
        decode_exec_start_program "${line#ExecStart=}"
    else
        local plist="${HOME}/Library/LaunchAgents/gsvd.plist"
        [ -f "$plist" ] || return 0
        sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$plist" \
            | sed -n 's/^[[:space:]]*<string>\(.*\)<\/string>.*/\1/p' \
            | head -n 1 \
            | decode_plist_string
    fi
}

# Where a previous installation lives: the directory the gsvd service runs
# from, else the pre-per-user default. Empty when this is a fresh install. A
# service inside the Desktop application bundle does not count: loose release
# binaries must never be written into the bundle.
existing_install_dir() {
    local service_exe
    service_exe="$(service_definition_executable)"
    case "$service_exe" in
        *.app/Contents/*) service_exe="" ;;
    esac
    if [ -n "$service_exe" ] && [ -x "$(dirname "$service_exe")/gsv" ]; then
        dirname "$service_exe"
        return
    fi
    if [ -x "${LEGACY_INSTALL_DIR}/gsv" ]; then
        printf '%s\n' "$LEGACY_INSTALL_DIR"
    fi
}

resolve_install_dir() {
    case "$(service_definition_executable)" in
        *.app/Contents/*) DESKTOP_MANAGED_DAEMON=1 ;;
    esac
    if [ -n "${GSV_INSTALL_DIR:-}" ]; then
        INSTALL_DIR="$GSV_INSTALL_DIR"
        INSTALL_DIR_SOURCE="explicit"
    else
        INSTALL_DIR="$(existing_install_dir)"
        if [ -n "$INSTALL_DIR" ]; then
            INSTALL_DIR_SOURCE="existing"
        else
            INSTALL_DIR="$DEFAULT_INSTALL_DIR"
            INSTALL_DIR_SOURCE="default"
        fi
    fi
    case "$INSTALL_DIR" in
        ""|/|"$HOME") error "GSV_INSTALL_DIR must name a dedicated binary directory"; exit 1 ;;
        /*) ;;
        *) error "GSV_INSTALL_DIR must be an absolute path"; exit 1 ;;
    esac
}

resolve_release_ref() {
    if [ -n "$VERSION" ]; then
        printf '%s\n' "$VERSION"
    elif [ "$CHANNEL" = "stable" ]; then
        printf '%s\n' "latest"
    else
        printf '%s\n' "$DEV_RELEASE_TAG"
    fi
}

release_asset_url() {
    local release_ref="$1"
    local asset="$2"
    if [ "$release_ref" = "latest" ]; then
        printf 'https://github.com/%s/releases/latest/download/%s\n' "$REPO" "$asset"
    else
        printf 'https://github.com/%s/releases/download/%s/%s\n' "$REPO" "$release_ref" "$asset"
    fi
}

cache_bust_url_if_mutable() {
    local release_ref="$1"
    local url="$2"
    if [ "$release_ref" = "latest" ] || [ "$release_ref" = "$DEV_RELEASE_TAG" ]; then
        printf '%s?ts=%s\n' "$url" "$(date +%s)"
    else
        printf '%s\n' "$url"
    fi
}

download_file() {
    local url="$1"
    local output="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$output" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$output" "$url"
    else
        error "curl or wget is required"
        return 1
    fi
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        error "sha256sum, shasum, or openssl is required"
        return 1
    fi
}

verify_asset() {
    local asset="$1"
    local path="$2"
    local checksum_file="$3"
    local expected
    expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$checksum_file")"
    if [ -z "$expected" ]; then
        error "Release checksum is missing for $asset"
        return 1
    fi
    local actual
    actual="$(sha256_file "$path")" || return 1
    if [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" != "$expected" ]; then
        error "Checksum verification failed for $asset"
        return 1
    fi
}

delegate_to_pinned_installer() {
    if [ -z "$VERSION" ] || [ "${GSV_INSTALLER_RELEASE_BOUND:-0}" = "1" ]; then
        return
    fi

    local bootstrap_dir
    bootstrap_dir="$(mktemp -d)"
    local checksum_file="${bootstrap_dir}/checksums.txt"
    local installer_file="${bootstrap_dir}/install.sh"
    local checksum_url
    checksum_url="$(cache_bust_url_if_mutable "$VERSION" "$(release_asset_url "$VERSION" checksums.txt)")"
    local installer_url
    installer_url="$(cache_bust_url_if_mutable "$VERSION" "$(release_asset_url "$VERSION" install.sh)")"

    info "Downloading installer for pinned release $VERSION"
    if ! download_file "$checksum_url" "$checksum_file" || \
        ! download_file "$installer_url" "$installer_file"; then
        rm -rf "$bootstrap_dir"
        error "Could not download the installer for $VERSION"
        exit 1
    fi
    if ! verify_asset install.sh "$installer_file" "$checksum_file"; then
        rm -rf "$bootstrap_dir"
        exit 1
    fi
    success "Verified installer for $VERSION"

    local status=0
    GSV_INSTALLER_RELEASE_BOUND=1 bash "$installer_file" || status=$?
    rm -rf "$bootstrap_dir"
    exit "$status"
}

prepare_install_dir() {
    if mkdir -p "$INSTALL_DIR" 2>/dev/null && [ -w "$INSTALL_DIR" ]; then
        USE_SUDO=0
        return
    fi
    if [ "$INSTALL_DIR_SOURCE" = "default" ]; then
        error "Cannot write $INSTALL_DIR"
        exit 1
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        error "Cannot write $INSTALL_DIR and sudo is unavailable"
        exit 1
    fi
    sudo mkdir -p "$INSTALL_DIR"
    USE_SUDO=1
}

explain_existing_install_dir() {
    if [ "$DESKTOP_MANAGED_DAEMON" -eq 1 ]; then
        info "The Desktop application manages the gsvd service and updates it; adding a separate command-line installation in $INSTALL_DIR"
    fi
    [ "$INSTALL_DIR_SOURCE" = "existing" ] || return 0
    if [ -w "$INSTALL_DIR" ]; then
        info "Updating the existing installation in $INSTALL_DIR"
        return
    fi
    warn "Updating the existing installation in $INSTALL_DIR. Automatic daemon updates need a directory this user can write; to move to the default, run: curl -fsSL https://install.gsv.space | GSV_INSTALL_DIR=\"\$HOME/.gsv/bin\" bash, then remove the old gsv, gsvd, gsv-desktop, gsv-transcribe, and gsv-vision files from $INSTALL_DIR and run gsv daemon install."
}

PATH_MARKER="# Added by the GSV installer"

path_already_configured() {
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) return 0 ;;
    esac
    return 1
}

append_path_line() {
    local file="$1"
    local line="$2"
    if [ -f "$file" ] && grep -qF "$PATH_MARKER" "$file"; then
        return 1
    fi
    mkdir -p "$(dirname "$file")"
    printf '\n%s %s\n' "$line" "$PATH_MARKER" >> "$file"
    return 0
}

# Put the default directory on PATH for new shells, the way rustup does: one
# guarded, marked line per shell profile, never twice, and never when asked
# not to.
configure_path() {
    [ "$INSTALL_DIR_SOURCE" = "default" ] || return 0
    PATH_FILES_UPDATED=""
    if [ "${GSV_NO_MODIFY_PATH:-0}" = "1" ]; then
        info "Left PATH alone (GSV_NO_MODIFY_PATH=1); add $INSTALL_DIR yourself"
        return
    fi
    if path_already_configured; then
        return
    fi
    local posix_line='case ":$PATH:" in *":$HOME/.gsv/bin:"*) ;; *) export PATH="$HOME/.gsv/bin:$PATH" ;; esac'
    local fish_line='if not contains "$HOME/.gsv/bin" $PATH; set -gx PATH "$HOME/.gsv/bin" $PATH; end'
    local file
    for file in "${HOME}/.profile" "${HOME}/.bash_profile" "${HOME}/.bashrc" "${HOME}/.zshrc"; do
        case "$file" in
            "${HOME}/.profile") ;;
            "${HOME}/.zshrc") [ -f "$file" ] || case "${SHELL:-}" in */zsh) ;; *) continue ;; esac ;;
            *) [ -f "$file" ] || continue ;;
        esac
        if append_path_line "$file" "$posix_line"; then
            PATH_FILES_UPDATED="${PATH_FILES_UPDATED:+$PATH_FILES_UPDATED, }~${file#"$HOME"}"
        fi
    done
    if [ -d "${HOME}/.config/fish" ]; then
        if append_path_line "${HOME}/.config/fish/conf.d/gsv.fish" "$fish_line"; then
            PATH_FILES_UPDATED="${PATH_FILES_UPDATED:+$PATH_FILES_UPDATED, }~/.config/fish/conf.d/gsv.fish"
        fi
    fi
    if [ -n "$PATH_FILES_UPDATED" ]; then
        success "Added $INSTALL_DIR to PATH in $PATH_FILES_UPDATED"
    fi
}

as_installer() {
    if [ "$USE_SUDO" -eq 1 ]; then
        sudo "$@"
    else
        "$@"
    fi
}

service_snapshot() {
    SERVICE_INSTALLED=0
    SERVICE_WAS_ACTIVE=0
    SERVICE_WAS_ENABLED=0
    # Desktop owns that service and the executable it runs; do not stop,
    # migrate, or restart it here.
    [ "$DESKTOP_MANAGED_DAEMON" -eq 0 ] || return 0
    if [ "$OS" = "linux" ]; then
        SERVICE_PATH="${CONFIG_HOME}/systemd/user/gsvd.service"
        if [ -f "$SERVICE_PATH" ]; then
            SERVICE_INSTALLED=1
            cp "$SERVICE_PATH" "$TMP_DIR/service-definition"
            if systemctl --user is-active --quiet gsvd.service; then SERVICE_WAS_ACTIVE=1; fi
            if systemctl --user is-enabled --quiet gsvd.service; then SERVICE_WAS_ENABLED=1; fi
        fi
    else
        SERVICE_PATH="${HOME}/Library/LaunchAgents/gsvd.plist"
        if [ -f "$SERVICE_PATH" ]; then
            SERVICE_INSTALLED=1
            cp "$SERVICE_PATH" "$TMP_DIR/service-definition"
            if launchctl print "gui/$(id -u)/gsvd" >/dev/null 2>&1; then SERVICE_WAS_ACTIVE=1; fi
        fi
    fi
}

stop_existing_service() {
    [ "$SERVICE_INSTALLED" -eq 1 ] || return 0
    if [ "$OS" = "linux" ]; then
        systemctl --user stop gsvd.service
    else
        launchctl bootout "gui/$(id -u)" "$SERVICE_PATH" >/dev/null 2>&1 || true
    fi
}

restore_service_snapshot() {
    [ "$SERVICE_INSTALLED" -eq 1 ] || return 0
    if [ "$OS" = "linux" ]; then
        cp "$TMP_DIR/service-definition" "$SERVICE_PATH"
        systemctl --user daemon-reload || true
        if [ "$SERVICE_WAS_ENABLED" -eq 1 ]; then
            systemctl --user enable gsvd.service >/dev/null 2>&1 || true
        else
            systemctl --user disable gsvd.service >/dev/null 2>&1 || true
        fi
        if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then systemctl --user start gsvd.service || true; fi
    else
        launchctl bootout "gui/$(id -u)" "$SERVICE_PATH" >/dev/null 2>&1 || true
        cp "$TMP_DIR/service-definition" "$SERVICE_PATH"
        if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
            launchctl bootstrap "gui/$(id -u)" "$SERVICE_PATH" >/dev/null 2>&1 || true
        fi
    fi
}

health_check_service() {
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if "${INSTALL_DIR}/gsv" daemon doctor >/dev/null 2>&1 && \
            "${INSTALL_DIR}/gsv" daemon status >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

rollback_binaries() {
    local index
    for ((index=${#BACKUPS[@]}-1; index>=0; index--)); do
        local target="${INSTALL_DIR}/${TARGETS[$index]}"
        local backup="${BACKUPS[$index]:-}"
        local staged="${INSTALL_DIR}/.${TARGETS[$index]}.new.$$"
        as_installer rm -f "$staged" || true
        if [ -n "$backup" ]; then
            if as_installer test -e "$backup"; then
                as_installer rm -f "$target" || true
                as_installer mv "$backup" "$target" || true
            fi
        else
            as_installer rm -f "$target" || true
        fi
    done
}

replace_binaries() {
    local index
    BACKUPS=()
    for ((index=0; index<${#TARGETS[@]}; index++)); do
        local target="${INSTALL_DIR}/${TARGETS[$index]}"
        local staged="${INSTALL_DIR}/.${TARGETS[$index]}.new.$$"
        local backup=""
        if as_installer test -e "$target"; then
            backup="${INSTALL_DIR}/.${TARGETS[$index]}.backup.$$"
        fi
        BACKUPS+=("$backup")
        as_installer cp "$TMP_DIR/${ASSETS[$index]}" "$staged" || {
            as_installer rm -f "$staged" || true
            return 1
        }
        if [ "${EXECUTABLES[$index]}" -eq 1 ]; then
            as_installer chmod 0755 "$staged" || {
                as_installer rm -f "$staged" || true
                return 1
            }
        else
            as_installer chmod 0644 "$staged" || {
                as_installer rm -f "$staged" || true
                return 1
            }
        fi
        if [ -n "$backup" ]; then
            as_installer mv "$target" "$backup" || {
                as_installer rm -f "$staged" || true
                return 1
            }
        fi
        if ! as_installer mv "$staged" "$target"; then
            as_installer rm -f "$staged" || true
            return 1
        fi
    done
}

remove_backups() {
    local backup
    for backup in "${BACKUPS[@]}"; do
        if [ -n "$backup" ]; then as_installer rm -f "$backup"; fi
    done
}

ensure_config_file() {
    local config_file="${CONFIG_DIR}/config.toml"
    mkdir -p "$CONFIG_DIR"
    if [ -f "$config_file" ]; then
        info "Found existing config at $config_file; leaving it unchanged"
        return
    fi
    {
        echo "# GSV host application configuration"
        echo "# gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws"
        echo ""
        echo "[release]"
        if [ -z "$VERSION" ]; then
            echo "channel = \"${CHANNEL}\""
        elif [ "$VERSION" = "$DEV_RELEASE_TAG" ]; then
            # A pinned install of the moving tag is a dev-channel machine.
            echo "channel = \"${DEV_RELEASE_TAG}\""
        else
            echo "# channel = \"stable\""
        fi
    } > "$config_file"
    chmod 0600 "$config_file"
    success "Created config at $config_file"
}

# Set release.channel in an existing config without touching anything else:
# replace the key inside [release], add it to an existing [release] table, or
# append the table.
set_release_channel_in_config() {
    local channel="$1"
    local config_file="${CONFIG_DIR}/config.toml"
    [ -f "$config_file" ] || return 0
    local updated="${config_file}.new.$$"
    awk -v channel="$channel" '
        function emit_channel() { print "channel = \"" channel "\""; done = 1 }
        /^[[:space:]]*\[release\][[:space:]]*$/ { in_release = 1; seen_release = 1; print; next }
        /^[[:space:]]*\[/ {
            if (in_release && !done) emit_channel()
            in_release = 0; print; next
        }
        in_release && !done && /^[[:space:]]*#?[[:space:]]*channel[[:space:]]*=/ { emit_channel(); next }
        { print }
        END {
            if (!done) {
                if (!seen_release) { print ""; print "[release]" }
                emit_channel()
            }
        }
    ' "$config_file" > "$updated" || { rm -f "$updated"; return 1; }
    chmod 0600 "$updated" && mv "$updated" "$config_file"
}

persist_release_channel() {
    if [ -z "$VERSION" ]; then
        "${INSTALL_DIR}/gsv" config --local set release.channel "$CHANNEL" >/dev/null 2>&1 || \
            warn "Could not persist release.channel"
    elif [ "$VERSION" = "$DEV_RELEASE_TAG" ]; then
        # A machine on the moving tag is a dev-channel machine, whatever its
        # config said before; a pinned stable tag leaves the channel alone.
        set_release_channel_in_config "$DEV_RELEASE_TAG" || warn "Could not persist release.channel"
    fi
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$status" -ne 0 ] && [ "${INSTALL_IN_PROGRESS:-0}" -eq 1 ]; then
        stop_existing_service || true
        rollback_binaries || true
        restore_service_snapshot || true
        error "Installation did not complete; restored the previous binaries and service"
    fi
    if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
    exit "$status"
}

main() {
    detect_platform
    validate_channel
    delegate_to_pinned_installer
    resolve_install_dir
    local release_ref
    release_ref="$(resolve_release_ref)"
    TMP_DIR="$(mktemp -d)"
    INSTALL_IN_PROGRESS=0
    BACKUPS=()
    trap cleanup EXIT INT TERM

    ASSETS=(
        "gsv-${PLATFORM}"
        "gsvd-${PLATFORM}"
        "gsv-desktop-${PLATFORM}"
        "gsv-transcribe-${PLATFORM}"
        "gsv-vision-${PLATFORM}"
        "gsv-transcribe-THIRD_PARTY.md"
        "gsv-vision-LICENSE.apache-2.0"
        "gsv-vision-PROVENANCE.md"
    )
    TARGETS=(
        "gsv"
        "gsvd"
        "gsv-desktop"
        "gsv-transcribe"
        "gsv-vision"
        "gsv-transcribe-THIRD_PARTY.md"
        "gsv-vision-LICENSE.apache-2.0"
        "gsv-vision-PROVENANCE.md"
    )
    EXECUTABLES=(1 1 1 1 1 0 0 0)

    echo ""
    echo -e "  ${BOLD}GSV host installer${NC} · ${PLATFORM} · ${release_ref}"
    echo ""
    info "Downloading release manifest"
    local checksum_url
    checksum_url="$(cache_bust_url_if_mutable "$release_ref" "$(release_asset_url "$release_ref" checksums.txt)")"
    download_file "$checksum_url" "$TMP_DIR/checksums.txt"

    local asset
    for asset in "${ASSETS[@]}"; do
        info "Downloading $asset"
        local asset_url
        asset_url="$(cache_bust_url_if_mutable "$release_ref" "$(release_asset_url "$release_ref" "$asset")")"
        download_file "$asset_url" "$TMP_DIR/$asset"
        verify_asset "$asset" "$TMP_DIR/$asset" "$TMP_DIR/checksums.txt"
    done
    success "Verified ${#ASSETS[@]} release artifacts"

    explain_existing_install_dir
    prepare_install_dir
    service_snapshot
    INSTALL_IN_PROGRESS=1
    stop_existing_service

    if ! replace_binaries; then
        error "Could not replace the host binaries"
        exit 1
    fi

    # The config must be complete before the replacement daemon starts, or
    # it reads the old release channel until its next restart.
    ensure_config_file
    persist_release_channel

    if [ "$SERVICE_INSTALLED" -eq 1 ]; then
        if ! "${INSTALL_DIR}/gsv" daemon start >/dev/null || ! health_check_service; then
            error "The updated daemon did not become healthy"
            exit 1
        fi
        if [ "$SERVICE_WAS_ACTIVE" -eq 0 ]; then "${INSTALL_DIR}/gsv" daemon stop >/dev/null; fi
        if [ "$OS" = "linux" ] && [ "$SERVICE_WAS_ENABLED" -eq 0 ]; then
            systemctl --user disable gsvd.service >/dev/null
        fi
        success "Migrated and verified the gsvd service"
    fi

    INSTALL_IN_PROGRESS=0
    remove_backups
    configure_path
    success "Installed gsv, gsvd, Desktop, and local helpers to $INSTALL_DIR"
    echo ""
    if [ "$INSTALL_DIR_SOURCE" = "default" ] && ! path_already_configured; then
        echo "  Open a new shell, or run now: export PATH=\"\$HOME/.gsv/bin:\$PATH\""
    fi
    echo "  Next: gsv auth setup"
    echo "  Open: gsv desktop"
    echo ""
}

main "$@"
