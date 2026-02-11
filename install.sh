#!/bin/bash
# GSV Installer
# 
# Installs the GSV CLI and optionally deploys the gateway.
#
# Usage:
#   curl -sSL https://gsv.dev/install.sh | bash
#   curl -sSL https://raw.githubusercontent.com/deathbyknowledge/gsv/main/install.sh | bash
#
# Environment variables:
#   GSV_INSTALL_DIR  - Where to install CLI (default: /usr/local/bin)
#   GSV_VERSION      - CLI version to install (default: latest)
#   GSV_SKIP_DEPLOY  - Skip deployment prompt (default: false)
#   GSV_GATEWAY_URL  - Use this gateway URL (skips deployment)
#   CF_API_TOKEN     - Cloudflare API token (optional; prompted if deploying)
#   CF_ACCOUNT_ID    - Cloudflare account ID (optional; auto-detected if omitted)

set -e

# ============================================================================
# Configuration
# ============================================================================

REPO="deathbyknowledge/gsv"
INSTALL_DIR="${GSV_INSTALL_DIR:-/usr/local/bin}"
VERSION="${GSV_VERSION:-latest}"
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

prompt_yn() {
    local prompt="$1"
    local default="${2:-n}"
    local yn_hint="y/N"
    [ "$default" = "y" ] && yn_hint="Y/n"
    
    echo -ne "  ${CYAN}?${NC} ${prompt} (${yn_hint}): "
    read -r response
    response="${response:-$default}"
    [[ "$response" =~ ^[Yy] ]]
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local hint=""
    [ -n "$default" ] && hint=" [${default}]"
    
    echo -ne "  ${CYAN}?${NC} ${prompt}${hint}: "
    read -r response
    echo "${response:-$default}"
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

get_latest_version() {
    if [ "$VERSION" = "latest" ]; then
        VERSION=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | 
            grep '"tag_name":' | 
            sed -E 's/.*"([^"]+)".*/\1/' || echo "")
        
        if [ -z "$VERSION" ]; then
            VERSION="v0.1.0"
            warn "Could not fetch latest version, using ${VERSION}"
        fi
    fi
}

# ============================================================================
# Deployment (via gsv CLI)
# ============================================================================

deploy_with_cli() {
    info "Deploying GSV to Cloudflare..."
    echo ""

    local cf_token="${CF_API_TOKEN:-}"
    local cf_account="${CF_ACCOUNT_ID:-}"

    if [ -z "$cf_token" ]; then
        cf_token=$(prompt_input "Enter Cloudflare API token" "")
    fi

    if [ -z "$cf_token" ]; then
        warn "No Cloudflare API token provided. Skipping deployment."
        return 1
    fi

    if [ -z "$cf_account" ]; then
        cf_account=$(prompt_input "Enter Cloudflare account ID (optional)" "")
    fi

    info "Running deploy wizard (gsv deploy up --wizard --all)..."
    echo ""

    if [ -n "$cf_account" ]; then
        gsv deploy up --wizard --all --api-token "$cf_token" --account-id "$cf_account"
    else
        gsv deploy up --wizard --all --api-token "$cf_token"
    fi
}

# ============================================================================
# CLI Installation
# ============================================================================

download_cli() {
    get_latest_version
    
    local url="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"
    local tmp_dir=$(mktemp -d)
    local tmp_file="${tmp_dir}/gsv"
    
    info "Downloading CLI ${VERSION} for ${OS}-${ARCH}..."
    
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

configure_cli() {
    local gateway_url="$1"

    local auth_token="${2:-}"
    if [ -z "$auth_token" ]; then
        auth_token=$(prompt_input "Enter your gateway auth token (optional)" "")
    fi

    local gateway_ws="${gateway_url%/}"
    if [[ "$gateway_ws" != */ws ]]; then
        gateway_ws="${gateway_ws}/ws"
    fi

    gsv local-config set gateway.url "$gateway_ws" >/dev/null
    if [ -n "$auth_token" ]; then
        gsv local-config set gateway.token "$auth_token" >/dev/null
    fi

    success "Configuration saved to ${CONFIG_DIR}/config.toml"
}

# ============================================================================
# Main
# ============================================================================

main() {
    print_banner
    detect_platform
    
    echo -e "  Platform: ${BOLD}${OS}-${ARCH}${NC}"
    echo ""

    WANT_DEPLOY="false"
    DEPLOYED_WITH_CLI="false"
    
    # Check for existing deployment via env var
    if [ -n "$GSV_GATEWAY_URL" ]; then
        GATEWAY_URL="$GSV_GATEWAY_URL"
        info "Using gateway URL from environment: ${GATEWAY_URL}"
    # Check for existing config
    elif check_existing_config; then
        if prompt_yn "Existing config found. Reinstall CLI only?" "y"; then
            download_cli
            echo ""
            success "CLI reinstalled!"
            echo ""
            echo "  Run: gsv client \"Hello!\""
            echo ""
            exit 0
        fi
    fi
    
    # Ask about deployment
    if [ -z "$GATEWAY_URL" ] && [ "$GSV_SKIP_DEPLOY" != "true" ]; then
        echo ""
        if prompt_yn "Do you have an existing GSV deployment?"; then
            echo ""
            GATEWAY_URL=$(prompt_input "Enter your gateway URL" "https://gsv.xxx.workers.dev")
        else
            echo ""
            info "Setting up a new GSV deployment..."
            echo ""
            echo "  This will:"
            echo "    1. Install the GSV CLI"
            echo "    2. Run 'gsv deploy up --wizard --all'"
            echo "    3. Configure Gateway and channels on Cloudflare"
            echo ""
            echo "  Requirements:"
            echo "    - Cloudflare API token with Workers/R2/Queues permissions"
            echo "    - Cloudflare account (free tier works!)"
            echo ""
            
            if ! prompt_yn "Continue with deployment?"; then
                echo ""
                warn "Skipping deployment."
                echo ""
                echo "  To deploy manually later:"
                echo "    gsv deploy up --wizard --all"
                echo ""
                
                # Still offer to install CLI
                if prompt_yn "Install CLI anyway?"; then
                    download_cli
                    echo ""
                    echo "  Configure with:"
                    echo "    gsv init"
                    echo ""
                fi
                exit 0
            fi

            WANT_DEPLOY="true"
        fi
    fi
    
    # Install CLI
    echo ""
    download_cli

    if [ "$WANT_DEPLOY" = "true" ]; then
        echo ""
        if deploy_with_cli; then
            DEPLOYED_WITH_CLI="true"
            local_gateway_ws=$(gsv local-config get gateway.url 2>/dev/null | tail -n 1 || true)
            if [ -n "$local_gateway_ws" ]; then
                GATEWAY_URL="${local_gateway_ws%/ws}"
            fi
        else
            warn "Deployment failed, but you can try again later:"
            echo "    gsv deploy up --wizard --all"
            echo ""
        fi
    fi
    
    # Configure if we have a URL
    if [ -n "$GATEWAY_URL" ] && [ "$DEPLOYED_WITH_CLI" != "true" ]; then
        echo ""
        configure_cli "$GATEWAY_URL"
    fi
    
    # Done!
    echo ""
    echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${GREEN}║${NC}                    ${BOLD}Setup Complete!${NC}                            ${GREEN}║${NC}"
    echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    if [ -n "$GATEWAY_URL" ]; then
        echo "  Gateway: ${GATEWAY_URL}"
        echo "  Config:  ${CONFIG_DIR}/config.toml"
        echo ""
        echo "  Next steps:"
        echo "    gsv client \"Hello!\"     # Start chatting"
        echo "    gsv node install --id mypc --workspace ~/projects   # Run tool node daemon"
        echo ""
    else
        echo "  CLI installed. Configure with:"
        echo "    gsv init"
        echo ""
    fi
    
    echo "  For help: gsv --help"
    echo "  Docs: https://github.com/${REPO}"
    echo ""
}

main "$@"
