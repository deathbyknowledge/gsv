#!/usr/bin/env bash
# Install one verified, same-version GSV host distribution.

set -euo pipefail

REPO="deathbyknowledge/gsv"
INSTALL_DIR="${GSV_INSTALL_DIR:-/usr/local/bin}"
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

prepare_install_dir() {
    if mkdir -p "$INSTALL_DIR" 2>/dev/null && [ -w "$INSTALL_DIR" ]; then
        USE_SUDO=0
        return
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        error "Cannot write $INSTALL_DIR and sudo is unavailable"
        exit 1
    fi
    sudo mkdir -p "$INSTALL_DIR"
    USE_SUDO=1
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
        if [ -z "$VERSION" ]; then echo "channel = \"${CHANNEL}\""; else echo "# channel = \"stable\""; fi
    } > "$config_file"
    chmod 0600 "$config_file"
    success "Created config at $config_file"
}

persist_release_channel() {
    if [ -z "$VERSION" ]; then
        "${INSTALL_DIR}/gsv" config --local set release.channel "$CHANNEL" >/dev/null 2>&1 || \
            warn "Could not persist release.channel"
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

    prepare_install_dir
    service_snapshot
    INSTALL_IN_PROGRESS=1
    stop_existing_service

    if ! replace_binaries; then
        error "Could not replace the host binaries"
        exit 1
    fi

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
    ensure_config_file
    persist_release_channel
    success "Installed gsv, gsvd, Desktop, and local helpers to $INSTALL_DIR"
    echo ""
    echo "  Next: gsv auth setup"
    echo "  Open: gsv desktop"
    echo ""
}

main "$@"
