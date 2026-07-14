#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${E2E_DIR}/.." && pwd)"

# shellcheck source=e2e/lib/lifecycle.sh
source "${E2E_DIR}/lib/lifecycle.sh"
# shellcheck source=e2e/lib/runtime.sh
source "${E2E_DIR}/lib/runtime.sh"

usage() {
  cat <<'EOF'
Usage: ./e2e/run.sh [options]

Deploy a disposable core GSV instance, run fresh onboarding plus deterministic
agent/device smoke scenarios, and destroy every owned Cloudflare resource.

Required environment:
  CF_API_TOKEN       Cloudflare API token for the dedicated test account
  CF_ACCOUNT_ID      Cloudflare account ID for the dedicated test account

Options:
  --instance NAME            Override the generated gsv-e2e-* instance name
  --results-dir PATH         Sanitized output directory (default: e2e/results/<run>)
  --bootstrap-source URL     Public immutable-bootstrap Git URL (default: origin)
  --bootstrap-ref REF        Immutable bootstrap ref (default: checked-out SHA)
  --bundle-dir PATH          Reuse local bundles and skip their build
  --skip-cli-build           Reuse cli/target/debug/gsv
  --skip-bundle-build        Reuse release/local (or --bundle-dir)
  --skip-build               Reuse both CLI and Cloudflare bundles
  --allow-dirty              Explicitly allow a non-reproducible working tree
  --provider-port PORT       Fixed runner-local mock-provider port
  --headed                   Show the Playwright browser
  --keep-on-failure          Keep Cloudflare resources only after a failed run
  -h, --help                 Show this help

Keeping resources is never the default. Child processes and ephemeral local
credentials are stopped and removed even when --keep-on-failure is selected.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_environment() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "${name} is required"
}

record_check() {
  node "${E2E_DIR}/lib/results.mjs" check "${CHECKS_FILE}" "$1" "$2"
}

pass_check() {
  record_check "$1" passed
  CURRENT_CHECK=""
}

print_cleanup_recovery() {
  local heading="$1"
  printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '%s: %s\n' "${heading}" "${INSTANCE}"
  printf 'Remote test accounts and process state may remain until cleanup.\n'
  printf 'Set CF_API_TOKEN and CF_ACCOUNT_ID, then clean it up with:\n  '
  lifecycle_cleanup_command
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n'
}

user_cli() {
  env \
    HOME="${USER_HOME}" \
    XDG_CONFIG_HOME="${USER_XDG_CONFIG_HOME}" \
    "${GSV_BIN}" --url "${GATEWAY_WS_URL}" "$@"
}

root_cli() {
  env \
    HOME="${ROOT_HOME}" \
    XDG_CONFIG_HOME="${ROOT_XDG_CONFIG_HOME}" \
    "${GSV_BIN}" --url "${GATEWAY_WS_URL}" "$@"
}

validate_bundle_dir() {
  local path="$1"
  local component
  [[ -f "${path}/cloudflare-checksums.txt" ]] || die "bundle checksums missing from ${path}"
  for component in ripgit assembler gateway; do
    [[ -f "${path}/gsv-cloudflare-${component}.tar.gz" ]] \
      || die "${component} bundle missing from ${path}"
  done
}

SKIP_CLI_BUILD=0
SKIP_BUNDLE_BUILD=0
ALLOW_DIRTY=0
KEEP_ON_FAILURE=0
HEADED=0
INSTANCE=""
RESULTS_DIR=""
BUNDLE_DIR=""
BOOTSTRAP_SOURCE=""
BOOTSTRAP_REF=""
BOOTSTRAP_REF_EXPLICIT=0
PROVIDER_PORT=""

while (($# > 0)); do
  case "$1" in
    --instance)
      (($# >= 2)) || die "--instance requires a value"
      INSTANCE="$2"
      shift 2
      ;;
    --results-dir)
      (($# >= 2)) || die "--results-dir requires a value"
      RESULTS_DIR="$2"
      shift 2
      ;;
    --bootstrap-source)
      (($# >= 2)) || die "--bootstrap-source requires a value"
      BOOTSTRAP_SOURCE="$2"
      shift 2
      ;;
    --bootstrap-ref)
      (($# >= 2)) || die "--bootstrap-ref requires a value"
      BOOTSTRAP_REF="$2"
      BOOTSTRAP_REF_EXPLICIT=1
      shift 2
      ;;
    --bundle-dir)
      (($# >= 2)) || die "--bundle-dir requires a value"
      BUNDLE_DIR="$2"
      SKIP_BUNDLE_BUILD=1
      shift 2
      ;;
    --skip-cli-build)
      SKIP_CLI_BUILD=1
      shift
      ;;
    --skip-bundle-build)
      SKIP_BUNDLE_BUILD=1
      shift
      ;;
    --skip-build)
      SKIP_CLI_BUILD=1
      SKIP_BUNDLE_BUILD=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --provider-port)
      (($# >= 2)) || die "--provider-port requires a value"
      PROVIDER_PORT="$2"
      shift 2
      ;;
    --headed)
      HEADED=1
      shift
      ;;
    --keep-on-failure)
      KEEP_ON_FAILURE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

for command in cargo curl git grep node npm openssl python3 sed tail tee; do
  require_command "${command}"
done
require_environment CF_API_TOKEN
require_environment CF_ACCOUNT_ID

RELEASE_SHA="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
SOURCE_DIRTY=false
if [[ -n "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal)" ]]; then
  SOURCE_DIRTY=true
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 3)"
if [[ -z "${INSTANCE}" ]]; then
  INSTANCE="gsv-e2e-$(date -u +%m%d%H%M)-$(openssl rand -hex 2)"
fi
node "${E2E_DIR}/lib/config.mjs" validate-instance "${INSTANCE}" >/dev/null

if [[ -z "${RESULTS_DIR}" ]]; then
  RESULTS_DIR="${E2E_DIR}/results/${RUN_ID}"
fi
if [[ -e "${RESULTS_DIR}" && ! -d "${RESULTS_DIR}" ]]; then
  die "results path exists and is not a directory: ${RESULTS_DIR}"
fi
if [[ -d "${RESULTS_DIR}" && -n "$(ls -A "${RESULTS_DIR}")" ]]; then
  die "results directory must be empty: ${RESULTS_DIR}"
fi
mkdir -p "${RESULTS_DIR}"
RESULTS_DIR="$(cd "${RESULTS_DIR}" && pwd)"
chmod 700 "${RESULTS_DIR}"
RUN_LOG="${RESULTS_DIR}/run.log"
CHECKS_FILE="${RESULTS_DIR}/checks.ndjson"
SUMMARY_FILE="${RESULTS_DIR}/summary.json"
touch "${RUN_LOG}"
chmod 600 "${RUN_LOG}"
exec > >(tee -a "${RUN_LOG}") 2>&1

RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsv-e2e.${RUN_ID}.XXXXXX")"
chmod 700 "${RUNTIME_DIR}"
DEPLOY_HOME="${RUNTIME_DIR}/deploy-home"
DEPLOY_XDG_CONFIG_HOME="${RUNTIME_DIR}/deploy-xdg"
USER_HOME="${RUNTIME_DIR}/user-home"
USER_XDG_CONFIG_HOME="${RUNTIME_DIR}/user-xdg"
ROOT_HOME="${RUNTIME_DIR}/root-home"
ROOT_XDG_CONFIG_HOME="${RUNTIME_DIR}/root-xdg"
DEVICE_HOME="${RUNTIME_DIR}/device-home"
DEVICE_XDG_CONFIG_HOME="${RUNTIME_DIR}/device-xdg"
DEVICE_WORKSPACE="${RUNTIME_DIR}/device-workspace"

GSV_BIN="${ROOT_DIR}/cli/target/debug/gsv"
LEASE_MANIFEST="${RESULTS_DIR}/lease.json"
STATUS_BEFORE="${RUNTIME_DIR}/status-before.json"
GATEWAY_URL=""
GATEWAY_WS_URL=""
DEVICE_PID=""
PROVIDER_PID=""
DEPLOY_ATTEMPTED=0
CURRENT_CHECK="preflight"
CURRENT_STAGE="preflight"

cleanup() {
  local original_status=$?
  local final_status="${original_status}"
  local outcome="failed"
  local terminal_stage="${CURRENT_STAGE}"
  trap - EXIT INT TERM
  set +e

  stop_child "${DEVICE_PID}" "foreground device"
  stop_child "${PROVIDER_PID}" "mock provider"

  if ((DEPLOY_ATTEMPTED == 1)); then
    if ((original_status != 0 && KEEP_ON_FAILURE == 1)); then
      record_check teardown skipped >/dev/null 2>&1 || true
      print_cleanup_recovery "DISPOSABLE INSTANCE KEPT AFTER FAILURE"
    else
      printf 'Destroying owned Cloudflare instance %s...\n' "${INSTANCE}"
      if lifecycle_destroy; then
        record_check teardown passed >/dev/null 2>&1 || true
      else
        printf 'error: strict teardown verification failed for %s\n' "${INSTANCE}" >&2
        record_check teardown failed >/dev/null 2>&1 || true
        final_status=1
        terminal_stage="teardown"
        print_cleanup_recovery "STRICT TEARDOWN INCOMPLETE"
      fi
    fi
  fi

  if ((original_status != 0)) && [[ -n "${CURRENT_CHECK}" ]]; then
    record_check "${CURRENT_CHECK}" failed >/dev/null 2>&1 || true
  fi

  rm -rf "${RUNTIME_DIR}"
  CURRENT_STAGE="${terminal_stage}"
  if ((final_status == 0)); then
    outcome="passed"
    CURRENT_STAGE="complete"
  fi
  node "${E2E_DIR}/lib/results.mjs" summary \
    "${SUMMARY_FILE}" "${RUN_ID}" "${INSTANCE}" "${RELEASE_SHA}" \
    "${CURRENT_STAGE}" "${outcome}" "${SOURCE_DIRTY}" "${GATEWAY_URL}" \
    >/dev/null 2>&1 || true

  if ((final_status == 0)); then
    printf '\nCore disposable e2e passed. Sanitized results: %s\n' "${RESULTS_DIR}"
  else
    printf '\nCore disposable e2e failed during %s. Sanitized results: %s\n' \
      "${CURRENT_STAGE}" "${RESULTS_DIR}" >&2
  fi
  exit "${final_status}"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p \
  "${DEPLOY_HOME}" "${DEPLOY_XDG_CONFIG_HOME}" \
  "${USER_HOME}" "${USER_XDG_CONFIG_HOME}" \
  "${ROOT_HOME}" "${ROOT_XDG_CONFIG_HOME}" \
  "${DEVICE_HOME}" "${DEVICE_XDG_CONFIG_HOME}" \
  "${DEVICE_WORKSPACE}"

printf 'GSV disposable core e2e\n'
printf '  run:      %s\n' "${RUN_ID}"
printf '  instance: %s\n' "${INSTANCE}"
printf '  release:  %s\n' "${RELEASE_SHA}"
printf '  results:  %s\n' "${RESULTS_DIR}"

if [[ "${SOURCE_DIRTY}" == true && "${ALLOW_DIRTY}" != 1 ]]; then
  die "working tree is dirty; commit/stash changes or pass --allow-dirty explicitly"
fi
if [[ "${SOURCE_DIRTY}" == true ]]; then
  printf 'warning: --allow-dirty makes this run non-reproducible; bootstrap still pins HEAD\n'
fi

if [[ -z "${BOOTSTRAP_SOURCE}" ]]; then
  BOOTSTRAP_SOURCE="$(git -C "${ROOT_DIR}" remote get-url origin)"
fi
BOOTSTRAP_SOURCE="$(node "${E2E_DIR}/lib/config.mjs" normalize-bootstrap-source "${BOOTSTRAP_SOURCE}")"
if [[ -z "${BOOTSTRAP_REF}" ]]; then
  BOOTSTRAP_REF="${RELEASE_SHA}"
fi
if ((BOOTSTRAP_REF_EXPLICIT == 0)) \
  && [[ -z "$(git -C "${ROOT_DIR}" branch -r --contains "${RELEASE_SHA}")" ]]; then
  die "checked-out SHA is not contained by a known remote ref; push it or pass an explicit reachable --bootstrap-ref"
fi

PLAYWRIGHT_BIN="${E2E_DIR}/node_modules/.bin/playwright"
[[ -x "${PLAYWRIGHT_BIN}" ]] \
  || die "Playwright is not installed; run: npm ci --prefix e2e && npm --prefix e2e exec -- playwright install chromium"

pass_check preflight
CURRENT_CHECK="helper-tests"
printf 'Running pure harness validation...\n'
npm --prefix "${E2E_DIR}" test
(
  cd "${ROOT_DIR}"
  PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts.test_mock_openai_provider
)
pass_check helper-tests

CURRENT_CHECK="build"
CURRENT_STAGE="build"
if ((SKIP_CLI_BUILD == 0)); then
  printf 'Building CLI from %s...\n' "${RELEASE_SHA}"
  env \
    GSV_BUILD_CHANNEL=e2e \
    GSV_BUILD_SHA="${RELEASE_SHA}" \
    GSV_BUILD_TIMESTAMP="$(git -C "${ROOT_DIR}" show -s --format=%ct "${RELEASE_SHA}")" \
    cargo build --locked --manifest-path "${ROOT_DIR}/cli/Cargo.toml"
else
  printf 'Reusing existing CLI build (--skip-cli-build).\n'
fi
[[ -x "${GSV_BIN}" ]] || die "CLI executable is missing: ${GSV_BIN}"

if ((SKIP_BUNDLE_BUILD == 0)); then
  BUNDLE_DIR="${RUNTIME_DIR}/bundles"
  printf 'Building Cloudflare bundles from %s...\n' "${RELEASE_SHA}"
  GSV_RELEASE_REF="${RELEASE_SHA}" \
    "${ROOT_DIR}/scripts/build-cloudflare-bundles.sh" "${BUNDLE_DIR}"
else
  if [[ -z "${BUNDLE_DIR}" ]]; then
    BUNDLE_DIR="${ROOT_DIR}/release/local"
  fi
  [[ -d "${BUNDLE_DIR}" ]] || die "bundle directory does not exist: ${BUNDLE_DIR}"
  BUNDLE_DIR="$(cd "${BUNDLE_DIR}" && pwd)"
  printf 'Reusing Cloudflare bundles from %s.\n' "${BUNDLE_DIR}"
fi
validate_bundle_dir "${BUNDLE_DIR}"
pass_check build

CURRENT_CHECK="namespace"
CURRENT_STAGE="namespace-check"
printf 'Checking that instance namespace is absent...\n'
lifecycle_assert_absent
pass_check namespace

CURRENT_CHECK="deployment"
CURRENT_STAGE="deployment"
DEPLOY_ATTEMPTED=1
printf 'Deploying core instance (ripgit, assembler, gateway)...\n'
lifecycle_deploy
lifecycle_validate_lease
GATEWAY_URL="$(lifecycle_gateway_url)"
GATEWAY_WS_URL="$(lifecycle_websocket_url)"
pass_check deployment

CURRENT_CHECK="readiness"
CURRENT_STAGE="readiness"
printf 'Waiting for gateway health and web assets...\n'
wait_for_http_contains "${GATEWAY_URL}/health" '"status":"healthy"' 180 \
  || die "gateway health did not become ready"
wait_for_http_ok "${GATEWAY_URL}/" 120 \
  || die "gateway web assets did not become ready"
pass_check readiness

CURRENT_CHECK="onboarding"
CURRENT_STAGE="onboarding"
USERNAME="e2e_$(openssl rand -hex 4)"
USER_PASSWORD="E2e-user-$(openssl rand -hex 16)"
ROOT_PASSWORD="E2e-root-$(openssl rand -hex 16)"
printf 'Running fresh browser onboarding and session recovery...\n'
if ! env \
  GSV_E2E_GATEWAY_URL="${GATEWAY_URL}" \
  GSV_E2E_USERNAME="${USERNAME}" \
  GSV_E2E_USER_PASSWORD="${USER_PASSWORD}" \
  GSV_E2E_ROOT_PASSWORD="${ROOT_PASSWORD}" \
  GSV_E2E_BOOTSTRAP_SOURCE="${BOOTSTRAP_SOURCE}" \
  GSV_E2E_BOOTSTRAP_REF="${BOOTSTRAP_REF}" \
  GSV_E2E_PLAYWRIGHT_OUTPUT_DIR="${RUNTIME_DIR}/playwright-artifacts" \
  GSV_E2E_HEADED="${HEADED}" \
  "${PLAYWRIGHT_BIN}" test --config "${E2E_DIR}/playwright.config.mjs" \
  >"${RUNTIME_DIR}/playwright.raw.log" 2>&1; then
  die "browser onboarding or session recovery failed (raw output removed during cleanup)"
fi
pass_check onboarding

CURRENT_CHECK="cli-login"
CURRENT_STAGE="cli-login"
printf 'Authenticating isolated user and root CLI sessions...\n'
user_cli auth login --username "${USERNAME}" --password "${USER_PASSWORD}" --ttl-hours 2 \
  >"${RUNTIME_DIR}/user-login.out" 2>&1
root_cli auth login --username root --password "${ROOT_PASSWORD}" --ttl-hours 2 \
  >"${RUNTIME_DIR}/root-login.out" 2>&1
pass_check cli-login

CURRENT_CHECK="cli-version"
CURRENT_STAGE="cli-smoke"
VERSION_OUTPUT="${RUNTIME_DIR}/version.out"
user_cli version >"${VERSION_OUTPUT}"
grep -Fq "package version:" "${VERSION_OUTPUT}" || die "CLI version output is malformed"
if ((SKIP_CLI_BUILD == 0)); then
  grep -Fq "commit: ${RELEASE_SHA:0:12}" "${VERSION_OUTPUT}" \
    || die "CLI version does not identify the tested commit"
fi
pass_check cli-version

CURRENT_CHECK="proc-list"
PROC_LIST_OUTPUT="${RUNTIME_DIR}/proc-list.out"
user_cli proc list >"${PROC_LIST_OUTPUT}"
grep -Fq "state=" "${PROC_LIST_OUTPUT}" || die "proc list did not return a process"
pass_check proc-list

CURRENT_CHECK="mock-provider"
CURRENT_STAGE="device-provider"
if [[ -z "${PROVIDER_PORT}" ]]; then
  PROVIDER_PORT="$(find_free_port)"
fi
[[ "${PROVIDER_PORT}" =~ ^[0-9]+$ ]] \
  && ((PROVIDER_PORT >= 1024 && PROVIDER_PORT <= 65535)) \
  || die "provider port must be an integer from 1024 through 65535"
DEVICE_ID="${INSTANCE}-runner"
PROVIDER_LOG="${RUNTIME_DIR}/provider.raw.log"
printf 'Starting deterministic mock provider on the runner...\n'
python3 "${ROOT_DIR}/scripts/mock-openai-provider.py" \
  --host 127.0.0.1 \
  --port "${PROVIDER_PORT}" \
  --shell-target "${DEVICE_ID}" \
  --delay-ms 15000 \
  >"${PROVIDER_LOG}" 2>&1 &
PROVIDER_PID=$!
wait_for_http_contains "http://127.0.0.1:${PROVIDER_PORT}/health" '"status":"ok"' 30 \
  || die "mock provider did not become ready"
pass_check mock-provider

CURRENT_CHECK="device"
DEVICE_TOKEN_OUTPUT="${RUNTIME_DIR}/device-token.raw"
DEVICE_EXPIRES_AT="$(node -p 'Date.now() + (2 * 60 * 60 * 1000)')"
user_cli auth token create \
  --kind device \
  --device "${DEVICE_ID}" \
  --label "disposable e2e runner" \
  --expires-at "${DEVICE_EXPIRES_AT}" \
  >"${DEVICE_TOKEN_OUTPUT}"
DEVICE_TOKEN="$(extract_issued_token "${DEVICE_TOKEN_OUTPUT}")" \
  || die "could not parse issued device token"
rm -f "${DEVICE_TOKEN_OUTPUT}"

DEVICE_LOG="${RUNTIME_DIR}/device.raw.log"
printf 'Starting isolated foreground device %s...\n' "${DEVICE_ID}"
env \
  HOME="${DEVICE_HOME}" \
  XDG_CONFIG_HOME="${DEVICE_XDG_CONFIG_HOME}" \
  GSV_TOKEN="${DEVICE_TOKEN}" \
  GSV_DEVICE_CONSOLE_FORMAT=json \
  "${GSV_BIN}" --url "${GATEWAY_WS_URL}" --user "${USERNAME}" \
    device run --id "${DEVICE_ID}" --workspace "${DEVICE_WORKSPACE}" \
    >"${DEVICE_LOG}" 2>&1 &
DEVICE_PID=$!
unset DEVICE_TOKEN
wait_for_log_marker "${DEVICE_LOG}" '"event":"connect.ok"' "${DEVICE_PID}" 90 \
  || die "foreground device did not connect"
pass_check device

CURRENT_CHECK="model-routing"
printf 'Routing custom AI traffic through the foreground device...\n'
root_cli config set config/ai/provider custom
root_cli config set config/ai/model gsv-mock
root_cli config set config/ai/base_url "http://127.0.0.1:${PROVIDER_PORT}/v1"
root_cli config set config/ai/provider_style openai-chat-completions
root_cli config set config/ai/transport_target "${DEVICE_ID}"
root_cli config set config/ai/fallback_model_profile ""
root_cli config set config/ai/reasoning off
root_cli config set config/ai/max_tokens 512
root_cli config set config/ai/generation/streaming off
root_cli config set config/ai/tools/approval '{"default":"auto","rules":[]}'
pass_check model-routing

CURRENT_CHECK="text-turn"
CURRENT_STAGE="agent-smoke"
printf 'Running scripted text agent turn...\n'
user_cli proc send '[[gsv-e2e:exact]]' >"${RUNTIME_DIR}/send-text.out"
wait_for_command_marker GSV_E2E_TEXT_OK 120 "${RUNTIME_DIR}/history-text.raw" \
  user_cli proc history --tail --limit 40 \
  || die "scripted text turn did not complete"
pass_check text-turn

CURRENT_CHECK="shell-turn"
printf 'Running scripted device Shell tool turn...\n'
user_cli proc send '[[gsv-e2e:shell]]' >"${RUNTIME_DIR}/send-shell.out"
wait_for_command_marker GSV_E2E_SHELL_OK 180 "${RUNTIME_DIR}/history-shell.raw" \
  user_cli proc history --tail --limit 80 \
  || die "scripted Shell tool turn did not complete"
pass_check shell-turn

CURRENT_CHECK="delegation-turn"
printf 'Running scripted durable delegation turn...\n'
user_cli proc send '[[gsv-e2e:delegate]]' >"${RUNTIME_DIR}/send-delegate.out"
wait_for_command_marker GSV_E2E_DELEGATE_OK 240 "${RUNTIME_DIR}/history-delegate.raw" \
  user_cli proc history --tail --limit 120 \
  || die "scripted delegation did not complete"
pass_check delegation-turn

CURRENT_CHECK="cancellation-turn"
printf 'Running delayed-inference cancellation and stale-output check...\n'
user_cli proc reset >"${RUNTIME_DIR}/reset-before-cancel.out"
user_cli proc send '[[gsv-e2e:delay]]' >"${RUNTIME_DIR}/send-delay.out"
wait_for_command_marker 'state=running' 30 "${RUNTIME_DIR}/proc-delay.raw" \
  user_cli proc list \
  || die "delayed agent turn did not enter the running state"
user_cli proc send '[[gsv-e2e:exact]]' >"${RUNTIME_DIR}/send-successor.out"
wait_for_log_marker "${PROVIDER_LOG}" '"outcome":"disconnected"' "${PROVIDER_PID}" 30 \
  || die "cancelled provider request did not observe transport disconnect"
wait_for_command_marker GSV_E2E_TEXT_OK 120 "${RUNTIME_DIR}/history-successor.raw" \
  user_cli proc history --tail --limit 40 \
  || die "successor agent turn did not complete"
user_cli proc history --tail --limit 80 >"${RUNTIME_DIR}/history-after-cancel.raw"
if grep -Fq GSV_E2E_DELAY_OK "${RUNTIME_DIR}/history-after-cancel.raw"; then
  die "cancelled provider output mutated active process history"
fi
rm -f "${RUNTIME_DIR}/history-after-cancel.raw"
pass_check cancellation-turn

CURRENT_STAGE="tests-complete"
CURRENT_CHECK=""
printf 'All core assertions passed; teardown will now verify resource absence.\n'
