#!/bin/bash
# GSV Installer
# 
# Installs the GSV CLI.
#
# Usage:
#   curl -sSL https://install.gsv.space | bash
#
# Environment variables:
#   GSV_INSTALL_DIR  - Where to install CLI (default: /usr/local/bin)
#   GSV_CHANNEL      - Release channel: stable or dev (default: stable)
#   GSV_VERSION      - Exact GitHub release tag to install (e.g. v0.1.0)

set -e

# ============================================================================
# Configuration
# ============================================================================

REPO="deathbyknowledge/gsv"
INSTALL_DIR="${GSV_INSTALL_DIR:-/usr/local/bin}"
CHANNEL="${GSV_CHANNEL:-stable}"
VERSION="${GSV_VERSION:-}"
CONFIG_DIR="${HOME}/.config/gsv"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ============================================================================
# Helpers
# ============================================================================

print_banner() {
    echo ""
    echo -e "${CYAN}  ╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}  ║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}      ${BOLD}██████╗ ███████╗██╗   ██╗${NC}                                ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}     ${BOLD}██╔════╝ ██╔════╝██║   ██║${NC}                                ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}     ${BOLD}██║  ███╗███████╗██║   ██║${NC}                                ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}     ${BOLD}██║   ██║╚════██║╚██╗ ██╔╝${NC}                                ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}     ${BOLD}╚██████╔╝███████║ ╚████╔╝${NC}                                 ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}      ${BOLD}╚═════╝ ╚══════╝  ╚═══╝${NC}                                  ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}                    ${BOLD}GSV Installer${NC}                              ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}  ╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

info() {
    echo -e "  ${CYAN}→${NC} $1"
}

success() {
    echo -e "  ${GREEN}✓${NC} $1"
}

warn() {
    echo -e "  ${YELLOW}!${NC} $1"
}

error() {
    echo -e "  ${RED}✗${NC} $1"
}

# ============================================================================
# Detection
# ============================================================================

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        linux) OS="linux" ;;
        darwin) OS="darwin" ;;
        msys*|mingw*|cygwin*) 
            error "Windows is not currently supported."
            error "Please use WSL2 (Windows Subsystem for Linux) instead."
            exit 1 
            ;;
        *) error "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64) ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) error "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY_NAME="gsv-${OS}-${ARCH}"
}

check_existing_config() {
    [ -f "${CONFIG_DIR}/config.toml" ]
}

validate_channel() {
    case "$CHANNEL" in
        stable|dev) ;;
        *) error "Invalid channel: $CHANNEL (must be 'stable' or 'dev')"; exit 1 ;;
    esac
}

github_api_get() {
    local url="$1"

    if command -v curl > /dev/null 2>&1; then
        curl -fsSL \
            -H "Accept: application/vnd.github+json" \
            -H "User-Agent: gsv-installer" \
            "$url"
        return
    fi

    if command -v wget > /dev/null 2>&1; then
        wget -q -O - \
            --header="Accept: application/vnd.github+json" \
            --header="User-Agent: gsv-installer" \
            "$url"
        return
    fi

    error "curl or wget required"
    exit 1
}

resolve_release_ref() {
    if [ -n "$VERSION" ]; then
        printf '%s\n' "$VERSION"
        return
    fi

    validate_channel

    if [ "$CHANNEL" = "stable" ]; then
        local response
        response=$(github_api_get "https://api.github.com/repos/${REPO}/releases/latest")
        local tag
        tag=$(printf '%s' "$response" | tr -d '\n' | sed -n 's/.*"tag_name":"\([^"]*\)".*/\1/p')
        if [ -z "$tag" ]; then
            error "Could not resolve latest stable release tag"
            exit 1
        fi
        printf '%s\n' "$tag"
        return
    fi

    local response
    response=$(github_api_get "https://api.github.com/repos/${REPO}/releases?per_page=20")
    local tag
    tag=$(
        printf '%s' "$response" \
          | tr -d '\n' \
          | grep -Eo '"tag_name":"[^"]*"|"draft":[^,}]*|"prerelease":[^,}]*' \
          | awk -F: '
              /"tag_name"/ {
                  tag=$2
                  gsub(/"/, "", tag)
                  draft=""
                  prerelease=""
                  next
              }
              /"draft"/ {
                  draft=$2
                  next
              }
              /"prerelease"/ {
                  prerelease=$2
                  if (draft == "false" && prerelease == "true" && tag ~ /^v[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/) {
                      print tag
                      exit
                  }
              }
          '
    )
    if [ -z "$tag" ]; then
        error "Could not resolve latest dev prerelease tag"
        exit 1
    fi
    printf '%s\n' "$tag"
}

# ============================================================================
# CLI Installation
# ============================================================================

download_cli() {
    local release_ref
    release_ref="$(resolve_release_ref)"

    local url="https://github.com/${REPO}/releases/download/${release_ref}/${BINARY_NAME}"
    local tmp_dir=$(mktemp -d)
    local tmp_file="${tmp_dir}/gsv"
    
    info "Downloading CLI (${release_ref}) for ${OS}-${ARCH}..."
    
    if command -v curl > /dev/null 2>&1; then
        HTTP_CODE=$(curl -sSL -w "%{http_code}" -o "$tmp_file" "$url" 2>/dev/null)
        if [ "$HTTP_CODE" != "200" ]; then
            error "Download failed (HTTP ${HTTP_CODE})"
            error "URL: $url"
            rm -rf "$tmp_dir"
            exit 1
        fi
    elif command -v wget > /dev/null 2>&1; then
        wget -q -O "$tmp_file" "$url" || {
            error "Download failed"
            rm -rf "$tmp_dir"
            exit 1
        }
    else
        error "curl or wget required"
        exit 1
    fi
    
    success "Downloaded CLI binary"
    
    # Install
    chmod +x "$tmp_file"
    if [ -w "$INSTALL_DIR" ]; then
        mv "$tmp_file" "${INSTALL_DIR}/gsv"
    else
        info "Installing to ${INSTALL_DIR} (requires sudo)..."
        sudo mv "$tmp_file" "${INSTALL_DIR}/gsv"
    fi
    rm -rf "$tmp_dir"
    
    success "Installed to ${INSTALL_DIR}/gsv"
}

ensure_config_file() {
    local config_file="${CONFIG_DIR}/config.toml"
    mkdir -p "${CONFIG_DIR}"

    if check_existing_config; then
        info "Found existing config at ${config_file}, leaving unchanged"
        return
    fi

    cat > "${config_file}" <<'EOF'
# GSV CLI configuration
# Set values explicitly when ready, e.g.:
#   gsv local-config set gateway.url wss://<your-gateway>.workers.dev/ws
#   gsv local-config set gateway.token <your-auth-token>
EOF

    if [ -z "$VERSION" ]; then
        printf "\n[release]\nchannel = \"%s\"\n" "$CHANNEL" >> "${config_file}"
    else
        cat >> "${config_file}" <<'EOF'

[release]
# Preferred default upgrade/setup channel (`stable` or `dev`)
# channel = "stable"
EOF
    fi

    success "Created config file at ${config_file}"
}

persist_release_channel() {
    if [ -n "$VERSION" ]; then
        return
    fi

    local gsv_bin="${INSTALL_DIR}/gsv"
    if [ ! -x "$gsv_bin" ]; then
        return
    fi

    if "$gsv_bin" local-config set release.channel "$CHANNEL" >/dev/null 2>&1; then
        success "Saved default release channel (${CHANNEL})"
    else
        warn "Could not persist release.channel in local config"
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    print_banner
    detect_platform
    
    if [ -n "$VERSION" ]; then
        echo -e "  Platform: ${BOLD}${OS}-${ARCH}${NC}  Version: ${BOLD}${VERSION}${NC}"
    else
        echo -e "  Platform: ${BOLD}${OS}-${ARCH}${NC}  Channel: ${BOLD}${CHANNEL}${NC}"
    fi
    echo ""
    
    # Install CLI
    echo ""
    download_cli

    echo ""
    ensure_config_file
    persist_release_channel
    
    # Done!
    echo ""
    echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${GREEN}║${NC}                    ${BOLD}Setup Complete!${NC}                            ${GREEN}║${NC}"
    echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    echo "  CLI installed."
    echo "  Config:  ${CONFIG_DIR}/config.toml"
    echo ""
    echo "  Next steps:"
    echo "    gsv setup                      # Deploy + configure local node"
    echo "    gsv local-config set gateway.url wss://<your-gateway>.workers.dev/ws"
    echo "    gsv local-config set gateway.token <your-auth-token>"
    echo "    gsv client \"Hello!\"     # Start chatting"
    echo ""
    
    echo "  For help: gsv --help"
    echo "  Docs: https://github.com/${REPO}"
    echo ""
}

main "$@"
