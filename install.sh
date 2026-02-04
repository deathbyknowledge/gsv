#!/bin/bash
# GSV Installer
# 
# Installs the GSV CLI and optionally deploys the gateway.
#
# Usage:
#   curl -sSL https://gsv.dev/install.sh | sh
#   curl -sSL https://raw.githubusercontent.com/deathbyknowledge/gsv/main/install.sh | sh
#
# Environment variables:
#   GSV_INSTALL_DIR  - Where to install CLI (default: /usr/local/bin)
#   GSV_VERSION      - CLI version to install (default: latest)
#   GSV_SKIP_DEPLOY  - Skip deployment prompt (default: false)
#   GSV_GATEWAY_URL  - Use this gateway URL (skips deployment)

set -e

# ============================================================================
# Configuration
# ============================================================================

REPO="deathbyknowledge/gsv"
INSTALL_DIR="${GSV_INSTALL_DIR:-/usr/local/bin}"
VERSION="${GSV_VERSION:-latest}"
GSV_SRC_DIR="${HOME}/.gsv/src"
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

check_bun() {
    if command -v bun > /dev/null 2>&1; then
        BUN_VERSION=$(bun --version 2>/dev/null)
        return 0
    fi
    return 1
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
# Deployment (via Alchemy)
# ============================================================================

deploy_gateway() {
    info "Deploying GSV Gateway to Cloudflare..."
    echo ""
    
    # Check for bun
    if ! check_bun; then
        error "bun is required for deployment"
        echo ""
        echo "  Install bun:"
        echo "    curl -fsSL https://bun.sh/install | bash"
        echo ""
        echo "  Then run this installer again."
        exit 1
    fi
    success "bun ${BUN_VERSION} found"
    
    # Check/setup alchemy auth
    if [ ! -f "${HOME}/.alchemy/config.json" ]; then
        info "Setting up Cloudflare authentication..."
        echo ""
        echo "  Alchemy will open your browser to authenticate with Cloudflare."
        echo "  This uses OAuth - no API tokens needed."
        echo ""
        
        if ! prompt_yn "Continue with authentication?"; then
            echo ""
            warn "Skipping deployment. You can deploy manually later:"
            echo "    cd ~/.gsv/src/gateway && bunx alchemy deploy alchemy/deploy.ts"
            return 1
        fi
        
        (cd "${GSV_SRC_DIR}/gateway" && bunx alchemy login cloudflare)
    fi
    success "Cloudflare authentication configured"
    
    # Run alchemy deploy
    info "Running alchemy deploy (this may take a minute)..."
    echo ""
    
    DEPLOY_OUTPUT=$(cd "${GSV_SRC_DIR}/gateway" && bunx alchemy deploy alchemy/deploy.ts --adopt 2>&1) || {
        error "Deployment failed"
        echo "$DEPLOY_OUTPUT"
        return 1
    }
    
    # Parse output for URL
    GATEWAY_URL=$(echo "$DEPLOY_OUTPUT" | grep -o 'https://[^[:space:]]*workers.dev' | head -1)
    
    if [ -z "$GATEWAY_URL" ]; then
        warn "Could not parse gateway URL from output"
        echo "$DEPLOY_OUTPUT"
        GATEWAY_URL=$(prompt_input "Enter the gateway URL manually")
    fi
    
    success "Gateway deployed: ${GATEWAY_URL}"
    echo ""
}

clone_repository() {
    if [ -d "${GSV_SRC_DIR}/.git" ]; then
        info "Updating existing repository..."
        (cd "${GSV_SRC_DIR}" && git pull --quiet) || warn "Could not update repo"
    else
        info "Cloning GSV repository..."
        mkdir -p "$(dirname "${GSV_SRC_DIR}")"
        git clone --quiet "https://github.com/${REPO}.git" "${GSV_SRC_DIR}" || {
            error "Failed to clone repository"
            exit 1
        }
    fi
    success "Repository ready at ${GSV_SRC_DIR}"
    
    # Install dependencies
    info "Installing dependencies..."
    (cd "${GSV_SRC_DIR}/gateway" && bun install --silent) || {
        error "Failed to install dependencies"
        exit 1
    }
    success "Dependencies installed"
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
    
    mkdir -p "${CONFIG_DIR}"
    
    # Generate auth token
    local auth_token="gsv_$(openssl rand -hex 16 2>/dev/null || date +%s | sha256sum | head -c 32)"
    
    # Create config
    cat > "${CONFIG_DIR}/config.toml" << EOF
# GSV CLI Configuration
# Generated by install.sh

[gateway]
url = "${gateway_url}/ws"
token = "${auth_token}"

[workspace]
# path = "/path/to/workspace"

[r2]
# account_id = ""
# access_key_id = ""
# secret_access_key = ""
# bucket = "gsv-storage"
EOF

    success "Configuration saved to ${CONFIG_DIR}/config.toml"
    
    # Show the token (user needs to set it on the worker)
    echo ""
    echo -e "  ${YELLOW}Important:${NC} Set the auth token on your gateway worker:"
    echo ""
    echo "    cd ~/.gsv/src/gateway"
    echo "    echo '${auth_token}' | bunx wrangler secret put AUTH_TOKEN"
    echo ""
    echo "  Or via Cloudflare dashboard → Workers → gsv-gateway → Settings → Variables"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    print_banner
    detect_platform
    
    echo -e "  Platform: ${BOLD}${OS}-${ARCH}${NC}"
    echo ""
    
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
            GATEWAY_URL=$(prompt_input "Enter your gateway URL" "https://gsv-gateway.xxx.workers.dev")
        else
            echo ""
            info "Setting up a new GSV deployment..."
            echo ""
            echo "  This will:"
            echo "    1. Clone the GSV repository"
            echo "    2. Deploy the gateway to Cloudflare Workers"
            echo "    3. Install the CLI"
            echo ""
            echo "  Requirements:"
            echo "    - bun (https://bun.sh)"
            echo "    - Cloudflare account (free tier works!)"
            echo ""
            
            if ! prompt_yn "Continue with deployment?"; then
                echo ""
                warn "Skipping deployment."
                echo ""
                echo "  To deploy manually later:"
                echo "    git clone https://github.com/${REPO}"
                echo "    cd gsv/gateway"
                echo "    bunx alchemy deploy alchemy/deploy.ts"
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
            
            echo ""
            clone_repository
            echo ""
            deploy_gateway || {
                warn "Deployment failed, but you can try again later:"
                echo "    cd ~/.gsv/src/gateway && bunx alchemy deploy alchemy/deploy.ts"
                echo ""
            }
        fi
    fi
    
    # Install CLI
    echo ""
    download_cli
    
    # Configure if we have a URL
    if [ -n "$GATEWAY_URL" ]; then
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
        echo "    gsv node                 # Run tool-providing node"
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
