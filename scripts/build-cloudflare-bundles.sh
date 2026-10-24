#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/cloudflare"
GSV_RELEASE_REF="${GSV_RELEASE_REF:-dev}"
GSV_RELEASE_DEFINE="$(node -p 'JSON.stringify(process.argv[1])' "${GSV_RELEASE_REF}")"

# Prevent macOS tar/cp from emitting AppleDouble sidecar files in bundles.
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

install_dir() {
  local dir="$1"
  npm ci --prefix "$dir" --workspaces=false
}

echo "==> Installing dependencies"
(cd "${ROOT_DIR}" && npm ci --ignore-scripts)
npm run build --workspace packages/gsv --prefix "$ROOT_DIR"
install_dir "${ROOT_DIR}/workers/ripgit"

ADAPTER_ROWS=()
ADAPTER_CATALOG_ROWS="$(node "${ROOT_DIR}/scripts/adapter-catalog.mjs")"
while IFS= read -r row; do
  ADAPTER_ROWS+=("${row}")
done <<< "${ADAPTER_CATALOG_ROWS}"

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
mkdir -p "${DIST_DIR}/installations/worker" "${DIST_DIR}/inference/worker" "${DIST_DIR}/pds/worker"
for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name component _source_dir _wrangler_config _dev_state <<< "${row}"
  mkdir -p "${DIST_DIR}/${component}/worker"
done

(
  cd "${ROOT_DIR}/workers/gateway"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --define "__GSV_RELEASE__:${GSV_RELEASE_DEFINE}" --outdir "${DIST_DIR}/gateway/worker" --metafile "${DIST_DIR}/gateway-bundle-meta.json"
)
node "${ROOT_DIR}/scripts/assert-gateway-inference-boundary.mjs" "${DIST_DIR}/gateway-bundle-meta.json"
rm "${DIST_DIR}/gateway-bundle-meta.json"
node "${ROOT_DIR}/scripts/normalize-worker-text-modules.mjs" "${DIST_DIR}/gateway/worker"
(
  cd "${ROOT_DIR}/workers/ripgit"
  npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/ripgit/worker"
)
for component in installations inference pds; do
  (
    cd "${ROOT_DIR}/workers/${component}"
    npm exec --workspaces=false -- wrangler deploy --minify --dry-run --outdir "${DIST_DIR}/${component}/worker"
  )
done
for row in "${ADAPTER_ROWS[@]}"; do
  IFS=$'\t' read -r _adapter_id _display_name component source_dir wrangler_config _dev_state <<< "${row}"
  (
    cd "${ROOT_DIR}/${source_dir}"
    npm exec --workspaces=false -- wrangler deploy --config "${wrangler_config}" --minify --dry-run --outdir "${DIST_DIR}/${component}/worker"
  )
  node --input-type=module - "${DIST_DIR}/${component}/worker" "${ROOT_DIR}/${source_dir}/adapter.json" <<'NODE'
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const [directory, manifestFile] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const emitted = basename(manifest.deployment.main).replace(/\.[cm]?tsx?$/, ".js");
if (emitted !== "index.js") {
  const source = readFileSync(join(directory, emitted), "utf8");
  renameSync(join(directory, emitted), join(directory, "index.js"));
  writeFileSync(join(directory, "index.js"), source.replace(`sourceMappingURL=${emitted}.map`, "sourceMappingURL=index.js.map"));
  renameSync(join(directory, `${emitted}.map`), join(directory, "index.js.map"));
}
NODE
done

echo "==> Assembling deployment files"
cp -R "${ROOT_DIR}/web/dist" "${DIST_DIR}/gateway/assets"
cp -R "${ROOT_DIR}/workers/installations/migrations" "${DIST_DIR}/installations/migrations"

node "${ROOT_DIR}/scripts/build-deployment-manifest.mjs" \
  "${DIST_DIR}/deployment-manifest.json"

# Remove host-specific metadata files from bundle contents.
find "${DIST_DIR}" \
  \( -name '._*' -o -name '.DS_Store' -o -path '*/__MACOSX/*' \) \
  -type f -exec rm -f {} +

echo ""
echo "Cloudflare deployment files ready in: ${DIST_DIR}"
