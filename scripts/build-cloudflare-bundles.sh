#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/cloudflare"
OUT_DIR="${1:-${ROOT_DIR}/release/local}"

# Prevent macOS tar/cp from emitting AppleDouble sidecar files in bundles.
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

install_dir() {
  local dir="$1"
  npm ci --prefix "$dir" --workspaces=false
}

install_workspace() {
  local workspace="$1"
  (
    cd "${ROOT_DIR}"
    npm ci --workspace "$workspace" --include-workspace-root=false
  )
}

echo "==> Installing dependencies"
install_workspace "assembler"
install_dir "${ROOT_DIR}/gateway"
install_dir "${ROOT_DIR}/web"
install_dir "${ROOT_DIR}/ripgit"
install_dir "${ROOT_DIR}/adapters/whatsapp"
install_dir "${ROOT_DIR}/adapters/discord"

echo "==> Building web UI"
npm run build --prefix "${ROOT_DIR}/web"

echo "==> Bundling workers with wrangler --dry-run"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/assembler/worker"
mkdir -p "${DIST_DIR}/gateway/worker"
mkdir -p "${DIST_DIR}/ripgit/worker"
mkdir -p "${DIST_DIR}/channel-whatsapp/worker"
mkdir -p "${DIST_DIR}/channel-discord/worker"

(
  cd "${ROOT_DIR}"
  npm exec --workspace assembler -- wrangler deploy --dry-run --config "${ROOT_DIR}/assembler/wrangler.toml" --outdir "${DIST_DIR}/assembler/worker"
)
(
  cd "${ROOT_DIR}/gateway"
  npm exec --workspaces=false -- wrangler deploy --dry-run --outdir "${DIST_DIR}/gateway/worker"
)
(
  cd "${ROOT_DIR}/ripgit"
  npm exec --workspaces=false -- wrangler deploy --dry-run --outdir "${DIST_DIR}/ripgit/worker"
)
(
  cd "${ROOT_DIR}/adapters/whatsapp"
  npm exec --workspaces=false -- wrangler deploy --dry-run --outdir "${DIST_DIR}/channel-whatsapp/worker"
)
(
  cd "${ROOT_DIR}/adapters/discord"
  npm exec --workspaces=false -- wrangler deploy --dry-run --outdir "${DIST_DIR}/channel-discord/worker"
)

echo "==> Assembling component metadata"
cp "${ROOT_DIR}/assembler/wrangler.toml" "${DIST_DIR}/assembler/wrangler.toml"
cat > "${DIST_DIR}/assembler/manifest.json" <<'EOF'
{
  "component": "assembler",
  "worker": {
    "entrypoint": "worker/index.js",
    "wranglerConfig": "wrangler.toml"
  }
}
EOF

cp "${ROOT_DIR}/gateway/wrangler.jsonc" "${DIST_DIR}/gateway/wrangler.jsonc"
cp -R "${ROOT_DIR}/web/dist" "${DIST_DIR}/gateway/assets"
cat > "${DIST_DIR}/gateway/manifest.json" <<'EOF'
{
  "component": "gateway",
  "worker": {
    "entrypoint": "worker/index.js",
    "sourceMap": "worker/index.js.map",
    "wranglerConfig": "wrangler.jsonc"
  },
  "assetsDir": "assets"
}
EOF

cp "${ROOT_DIR}/ripgit/wrangler.toml" "${DIST_DIR}/ripgit/wrangler.toml"
cat > "${DIST_DIR}/ripgit/manifest.json" <<'EOF'
{
  "component": "ripgit",
  "worker": {
    "entrypoint": "worker/index.js",
    "wranglerConfig": "wrangler.toml"
  }
}
EOF

cp "${ROOT_DIR}/adapters/whatsapp/wrangler.jsonc" "${DIST_DIR}/channel-whatsapp/wrangler.jsonc"
cat > "${DIST_DIR}/channel-whatsapp/manifest.json" <<'EOF'
{
  "component": "channel-whatsapp",
  "worker": {
    "entrypoint": "worker/index.js",
    "sourceMap": "worker/index.js.map",
    "wranglerConfig": "wrangler.jsonc"
  }
}
EOF

cp "${ROOT_DIR}/adapters/discord/wrangler.jsonc" "${DIST_DIR}/channel-discord/wrangler.jsonc"
cat > "${DIST_DIR}/channel-discord/manifest.json" <<'EOF'
{
  "component": "channel-discord",
  "worker": {
    "entrypoint": "worker/index.js",
    "sourceMap": "worker/index.js.map",
    "wranglerConfig": "wrangler.jsonc"
  }
}
EOF

# Remove host-specific metadata files from bundle contents.
find "${DIST_DIR}" \
  \( -name '._*' -o -name '.DS_Store' -o -path '*/__MACOSX/*' \) \
  -type f -exec rm -f {} +

echo "==> Creating local tarballs"
mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}/gsv-cloudflare-"*.tar.gz "${OUT_DIR}/cloudflare-checksums.txt" 2>/dev/null || true

tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-assembler.tar.gz" assembler
tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-gateway.tar.gz" gateway
tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-ripgit.tar.gz" ripgit
tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-channel-whatsapp.tar.gz" channel-whatsapp
tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-channel-discord.tar.gz" channel-discord

(
  cd "${OUT_DIR}"
  sha256sum gsv-cloudflare-*.tar.gz > cloudflare-checksums.txt
)

echo ""
echo "Cloudflare bundles ready in: ${OUT_DIR}"
ls -lh "${OUT_DIR}"/gsv-cloudflare-*.tar.gz "${OUT_DIR}/cloudflare-checksums.txt"
