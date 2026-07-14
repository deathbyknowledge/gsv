#!/usr/bin/env bash

# All CLI infrastructure lifecycle calls live here. Keep this file as the only
# integration point when the CLI surface or lease schema changes.

lifecycle_cli() {
  env \
    HOME="${DEPLOY_HOME}" \
    XDG_CONFIG_HOME="${DEPLOY_XDG_CONFIG_HOME}" \
    "${GSV_BIN}" "$@"
}

lifecycle_assert_absent() {
  lifecycle_cli infra status \
    --instance "${INSTANCE}" \
    --all \
    --json >"${STATUS_BEFORE}"
  node "${E2E_DIR}/lib/config.mjs" assert-status-absent "${STATUS_BEFORE}" "${INSTANCE}"
}

lifecycle_deploy() {
  lifecycle_cli infra deploy \
    --version "${RELEASE_SHA}" \
    --instance "${INSTANCE}" \
    --component ripgit \
    --component assembler \
    --component gateway \
    --bundle-dir "${BUNDLE_DIR}" \
    --force-fetch \
    --lease-manifest "${LEASE_MANIFEST}"
}

lifecycle_validate_lease() {
  node "${E2E_DIR}/lib/config.mjs" validate-lease \
    "${LEASE_MANIFEST}" "${INSTANCE}" "${RELEASE_SHA}"
}

lifecycle_gateway_url() {
  node "${E2E_DIR}/lib/config.mjs" gateway-url \
    "${LEASE_MANIFEST}" "${INSTANCE}" "${RELEASE_SHA}"
}

lifecycle_websocket_url() {
  node "${E2E_DIR}/lib/config.mjs" websocket-url \
    "${LEASE_MANIFEST}" "${INSTANCE}" "${RELEASE_SHA}"
}

lifecycle_destroy() {
  lifecycle_cli infra destroy \
    --instance "${INSTANCE}" \
    --component gateway \
    --component assembler \
    --component ripgit \
    --delete-bucket \
    --purge-bucket \
    --keep-device \
    --verify
}

lifecycle_cleanup_command() {
  printf '%q ' "${GSV_BIN}" infra destroy \
    --instance "${INSTANCE}" \
    --component gateway \
    --component assembler \
    --component ripgit \
    --delete-bucket \
    --purge-bucket \
    --keep-device \
    --verify
  printf '\n'
}
