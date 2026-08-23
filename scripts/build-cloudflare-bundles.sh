#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/cloudflare"
OUT_DIR="${1:-${ROOT_DIR}/release/local}"
GSV_RELEASE_REF="${GSV_RELEASE_REF:-dev}"
GSV_RELEASE_DEFINE="$(node -p 'JSON.stringify(process.argv[1])' "${GSV_RELEASE_REF}")"

ADAPTER_ROWS=()
ADAPTER_CATALOG_ROWS="$(node "${ROOT_DIR}/scripts/adapter-catalog.mjs")"
while IFS= read -r row; do
  ADAPTER_ROWS+=("${row}")
done <<< "${ADAPTER_CATALOG_ROWS}"

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
install_workspaces "packages/gsv"
npm run build --workspace packages/gsv
install_dir "${ROOT_DIR}/gateway"
install_dir "${ROOT_DIR}/web"
install_dir "${ROOT_DIR}/ripgit"

for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name _component source_dir _wrangler_config _dev_state <<< "${row}"
  install_dir "${ROOT_DIR}/${source_dir}"
done

echo "==> Building web UI"
npm run build --prefix "${ROOT_DIR}/web"

echo "==> Bundling workers with wrangler --dry-run"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/gateway/worker"
mkdir -p "${DIST_DIR}/ripgit/worker"
for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name component _source_dir _wrangler_config _dev_state <<< "${row}"
  mkdir -p "${DIST_DIR}/${component}/worker"
done

(
  cd "${ROOT_DIR}/gateway"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --define "__GSV_RELEASE__:${GSV_RELEASE_DEFINE}" --outdir "${DIST_DIR}/gateway/worker"
)
(
  cd "${ROOT_DIR}/ripgit"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/ripgit/worker"
)
for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name component source_dir wrangler_config _dev_state <<< "${row}"
  (
    cd "${ROOT_DIR}/${source_dir}"
    npm exec --workspaces=false -- wrangler deploy --config "${wrangler_config}" --minify --dry-run --outdir "${DIST_DIR}/${component}/worker"
  )
done

echo "==> Assembling component metadata"
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

for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r adapter_id display_name component source_dir wrangler_config _dev_state <<< "${row}"
  cp "${ROOT_DIR}/${source_dir}/${wrangler_config}" "${DIST_DIR}/${component}/${wrangler_config}"
  node --input-type=module - \
    "${DIST_DIR}/${component}/manifest.json" \
    "${adapter_id}" \
    "${display_name}" \
    "${component}" \
    "${wrangler_config}" <<'NODE'
import { writeFileSync } from "node:fs";
const [output, id, displayName, component, wranglerConfig] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({
  component,
  adapter: { id, displayName },
  worker: {
    entrypoint: "worker/index.js",
    sourceMap: "worker/index.js.map",
    wranglerConfig,
  },
}, null, 2)}\n`);
NODE
done

# Remove host-specific metadata files from bundle contents.
find "${DIST_DIR}" \
  \( -name '._*' -o -name '.DS_Store' -o -path '*/__MACOSX/*' \) \
  -type f -exec rm -f {} +

echo "==> Creating local tarballs"
mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}/gsv-cloudflare-"*.tar.gz "${OUT_DIR}/cloudflare-checksums.txt" 2>/dev/null || true

tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-gateway.tar.gz" gateway
tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-ripgit.tar.gz" ripgit
for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name component _source_dir _wrangler_config _dev_state <<< "${row}"
  tar -C "${DIST_DIR}" -czf "${OUT_DIR}/gsv-cloudflare-${component}.tar.gz" "${component}"
done

(
  cd "${OUT_DIR}"
  sha256sum gsv-cloudflare-*.tar.gz > cloudflare-checksums.txt
)

echo ""
echo "Cloudflare bundles ready in: ${OUT_DIR}"
ls -lh "${OUT_DIR}"/gsv-cloudflare-*.tar.gz "${OUT_DIR}/cloudflare-checksums.txt"
