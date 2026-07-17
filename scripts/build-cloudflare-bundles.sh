#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/cloudflare"
OUT_DIR="${1:-${ROOT_DIR}/release/local}"
GSV_RELEASE_REF="${GSV_RELEASE_REF:-dev}"
GSV_SOURCE_COMMIT_SHA="${GSV_SOURCE_COMMIT_SHA:-$(git -C "${ROOT_DIR}" rev-parse HEAD)}"
GSV_RELEASE_DEFINE="$(node -p 'JSON.stringify(process.argv[1])' "${GSV_RELEASE_REF}")"
TAR_BIN="${TAR_BIN:-tar}"

if [[ ! "${GSV_SOURCE_COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GSV_SOURCE_COMMIT_SHA must be an exact lowercase 40-character Git commit SHA" >&2
  exit 1
fi

GSV_SOURCE_DATE_EPOCH="${GSV_SOURCE_DATE_EPOCH:-$(git -C "${ROOT_DIR}" show -s --format=%ct "${GSV_SOURCE_COMMIT_SHA}")}"
if [[ ! "${GSV_SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
  echo "GSV_SOURCE_DATE_EPOCH must be the source commit's Unix timestamp" >&2
  exit 1
fi
if ! "${TAR_BIN}" --version 2>/dev/null | head -n 1 | grep -q "GNU tar"; then
  echo "Cloudflare release bundles require GNU tar (set TAR_BIN=gtar on macOS)" >&2
  exit 1
fi
export LC_ALL=C

# Prevent macOS tar/cp from emitting AppleDouble sidecar files in bundles.
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

install_dir() {
  local dir="$1"
  npm ci --prefix "$dir" --workspaces=false
}

install_workspaces() {
  local args=()
  local workspace
  for workspace in "$@"; do
    args+=(--workspace "$workspace")
  done
  (
    cd "${ROOT_DIR}"
    npm ci "${args[@]}" --include-workspace-root=false --ignore-scripts
  )
}

echo "==> Installing dependencies"
# Keep these root workspaces in one npm ci call; separate workspace installs prune
# root node_modules and can remove either assembler's wrangler or the SDK deps.
install_workspaces \
  "assembler" \
  "packages/gsv" \
  "packages/portable-archive" \
  "packages/worker-runtime" \
  "packages/cloudflare-release"
npm run public-packages:build
install_dir "${ROOT_DIR}/gateway"
install_dir "${ROOT_DIR}/web"
install_dir "${ROOT_DIR}/ripgit"
install_dir "${ROOT_DIR}/adapters/whatsapp"
install_dir "${ROOT_DIR}/adapters/discord"
install_dir "${ROOT_DIR}/adapters/telegram"

echo "==> Building web UI"
npm run build --prefix "${ROOT_DIR}/web"

echo "==> Bundling workers with wrangler --dry-run"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/assembler/worker"
mkdir -p "${DIST_DIR}/gateway/worker"
mkdir -p "${DIST_DIR}/ripgit/worker"
mkdir -p "${DIST_DIR}/channel-whatsapp/worker"
mkdir -p "${DIST_DIR}/channel-discord/worker"
mkdir -p "${DIST_DIR}/channel-telegram/worker"

(
  cd "${ROOT_DIR}"
  npm exec --workspace assembler -- wrangler deploy --minify --dry-run --config "${ROOT_DIR}/assembler/wrangler.toml" --outdir "${DIST_DIR}/assembler/worker"
)
(
  cd "${ROOT_DIR}/gateway"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --define "__GSV_RELEASE__:${GSV_RELEASE_DEFINE}" --outdir "${DIST_DIR}/gateway/worker"
)
(
  cd "${ROOT_DIR}/ripgit"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/ripgit/worker"
)
(
  cd "${ROOT_DIR}/adapters/whatsapp"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/channel-whatsapp/worker"
)
(
  cd "${ROOT_DIR}/adapters/discord"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/channel-discord/worker"
)
(
  cd "${ROOT_DIR}/adapters/telegram"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/channel-telegram/worker"
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
    "wranglerConfig": "wrangler.jsonc"
  }
}
EOF

cp "${ROOT_DIR}/adapters/telegram/wrangler.jsonc" "${DIST_DIR}/channel-telegram/wrangler.jsonc"
cat > "${DIST_DIR}/channel-telegram/manifest.json" <<'EOF'
{
  "component": "channel-telegram",
  "worker": {
    "entrypoint": "worker/index.js",
    "wranglerConfig": "wrangler.jsonc"
  }
}
EOF

# Remove host-specific metadata files from bundle contents.
find "${DIST_DIR}" \
  \( -name '._*' -o -name '.DS_Store' -o -path '*/__MACOSX/*' \) \
  -type f -exec rm -f {} +

# Source maps are not part of the deployment upload. Excluding them keeps each
# release artifact small and avoids making every deployer unpack files that are
# never sent to the Workers runtime (the gateway map alone can exceed 20 MiB).
find "${DIST_DIR}" -path '*/worker/*.map' -type f -exec rm -f {} +

echo "==> Creating local tarballs"
mkdir -p "${OUT_DIR}"
rm -f \
  "${OUT_DIR}/gsv-cloudflare-"*.tar.gz \
  "${OUT_DIR}/cloudflare-checksums.txt" \
  "${OUT_DIR}/gsv-cloudflare-release.json" \
  2>/dev/null || true

create_component_archive() {
  local component="$1"
  local output="$2"
  "${TAR_BIN}" \
    --sort=name \
    --mtime="@${GSV_SOURCE_DATE_EPOCH}" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --format=ustar \
    -C "${DIST_DIR}" \
    -cf - \
    "${component}" | gzip -n > "${output}"
}

create_component_archive assembler "${OUT_DIR}/gsv-cloudflare-assembler.tar.gz"
create_component_archive gateway "${OUT_DIR}/gsv-cloudflare-gateway.tar.gz"
create_component_archive ripgit "${OUT_DIR}/gsv-cloudflare-ripgit.tar.gz"
create_component_archive channel-whatsapp "${OUT_DIR}/gsv-cloudflare-channel-whatsapp.tar.gz"
create_component_archive channel-discord "${OUT_DIR}/gsv-cloudflare-channel-discord.tar.gz"
create_component_archive channel-telegram "${OUT_DIR}/gsv-cloudflare-channel-telegram.tar.gz"

(
  cd "${OUT_DIR}"
  sha256sum gsv-cloudflare-*.tar.gz > cloudflare-checksums.txt
)

echo "==> Writing public release descriptor"
node "${ROOT_DIR}/packages/cloudflare-release/scripts/generate-release-descriptor.mjs" \
  --release "${GSV_RELEASE_REF}" \
  --source-commit "${GSV_SOURCE_COMMIT_SHA}" \
  --dist "${DIST_DIR}" \
  --artifacts "${OUT_DIR}" \
  --checksums "${OUT_DIR}/cloudflare-checksums.txt" \
  --output "${OUT_DIR}/gsv-cloudflare-release.json"

# The descriptor binds the component digests to the public source commit. Its
# own checksum completes the trust chain without introducing a self-reference.
(
  cd "${OUT_DIR}"
  sha256sum gsv-cloudflare-release.json >> cloudflare-checksums.txt
)

echo ""
echo "Cloudflare bundles ready in: ${OUT_DIR}"
ls -lh \
  "${OUT_DIR}"/gsv-cloudflare-*.tar.gz \
  "${OUT_DIR}/gsv-cloudflare-release.json" \
  "${OUT_DIR}/cloudflare-checksums.txt"
