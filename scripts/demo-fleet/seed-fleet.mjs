#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEMO_INCIDENT_INDEXES,
  DEMO_MAX_DEVICE_COUNT,
  deviceIdForIndex,
  deviceIndexForId,
} from "./fleet-state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = process.env.DEMO_FLEET_GENERATED_DIR || path.join(scriptDir, ".generated");
const scenarioName = "checkout-config-rollout-incident";
const fleetMarkerName = ".gsv-demo-fleet.json";
const fleetMarkerOwner = "gsv-demo-fleet-seed";
const fleetMarkerVersion = 1;
const repairTimestampToken = "$RESTART_AT";

const affected = new Set(DEMO_INCIDENT_INDEXES);
const diskWarnings = new Set([5, 20, 41, 66, 72, 91]);
const oldAuthWarnings = new Set([11, 34, 57, 86]);
const highLatency = new Set([16, 48, 79]);
const regionalEu = new Set([24, 73]);
const canaryHealthy = new Set([6, 10, 18, 26, 32, 45, 54, 62, 70, 85]);

const defaults = {
  root: process.env.DEMO_FLEET_DIR || path.join(generatedDir, "fleet"),
  truth: process.env.DEMO_FLEET_GROUND_TRUTH_FILE || path.join(generatedDir, "ground-truth.json"),
  count: Number(process.env.DEMO_FLEET_DEVICE_COUNT || 100),
  clean: true,
};

function usage() {
  console.log(`Usage: node scripts/demo-fleet/seed-fleet.mjs [--root PATH] [--truth PATH] [--devices N] [--no-clean]

Creates deterministic demo device workspaces for the incident demo (100 devices by default, up to 1,000).
Generated files default to scripts/demo-fleet/.generated/ and are ignored by git.`);
}

function parseArgs(argv) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--root") {
      opts.root = argv[++i];
    } else if (arg === "--truth") {
      opts.truth = argv[++i];
    } else if (arg === "--devices") {
      opts.count = Number(argv[++i]);
    } else if (arg === "--no-clean") {
      opts.clean = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > DEMO_MAX_DEVICE_COUNT) {
    throw new Error(`--devices must be an integer from 1 to ${DEMO_MAX_DEVICE_COUNT}`);
  }
  return opts;
}

function deviceId(index) {
  return deviceIdForIndex(index);
}

function stableZone(index, region) {
  const suffix = ["a", "b", "c"][index % 3];
  return `${region}${suffix}`;
}

function jsonHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

function parseScenarioClock(value) {
  if (value !== undefined && value.trim() === "") {
    throw new Error("DEMO_FLEET_NOW must be a valid ISO-8601 date-time");
  }

  const parsed = value === undefined ? Date.now() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`DEMO_FLEET_NOW is not a valid date-time: ${value}`);
  }

  return Math.floor(parsed / 1000) * 1000;
}

function buildTimeline(nowMilliseconds) {
  const at = (secondsFromNow) => isoTimestamp(nowMilliseconds + secondsFromNow * 1000);
  const badRolloutAt = at(-42 * 60);
  const healthyCanaryRolloutAt = at(-46 * 60);
  const stableConfigAt = at(-9 * 24 * 60 * 60);

  return {
    now: at(0),
    stableConfigAt,
    stableRolloutLabel: `${stableConfigAt.slice(0, 10)}-stable`,
    bootAt: at(-72 * 60 * 60),
    oldAuthWarningAt: at(-11 * 60 * 60),
    regionalPinAt: at(-3 * 60 * 60),
    deployHeartbeatAt: at(-2 * 60 * 60),
    inventoryAt: at(-115 * 60),
    ntpAt: at(-90 * 60),
    checkoutStartAt: at(-75 * 60),
    preRolloutSampleAt: at(-60 * 60),
    healthyCanaryRolloutAt,
    healthyCanaryRolloutLabel: `${healthyCanaryRolloutAt.slice(0, 10)}-canary-a`,
    healthyCanaryRestartAt: at(-45 * 60),
    badRolloutAt,
    badRolloutLabel: `${badRolloutAt.slice(0, 10)}-canary-b`,
    badRestartAt: at(-41 * 60),
    firstPaymentTimeoutAt: at(-40 * 60),
    retryExhaustedAt: at(-37 * 60),
    secondPaymentTimeoutAt: at(-34 * 60),
    noRolloutAt: at(-33 * 60),
    diskWarningAt: at(-30 * 60),
    degradedAt: at(-28 * 60),
    highLatencyAt: at(-24 * 60),
    healthySampleAt: at(-18 * 60),
    healthObservedAt: at(-3 * 60),
  };
}

function sortLogLines(lines) {
  return `${lines.sort((a, b) => a.localeCompare(b)).join("\n")}\n`;
}

function baseNode(index, id, homeRegion) {
  return {
    deviceId: id,
    role: "edge-checkout",
    site: `store-${String((index % 25) + 1).padStart(2, "0")}`,
    homeRegion,
    zone: stableZone(index, homeRegion),
    owner: "retail-platform",
    environment: "production-demo",
  };
}

function checkoutConfig(index, homeRegion, timeline) {
  const isAffected = affected.has(index);
  const isEuRegional = regionalEu.has(index);
  const batch = isAffected
    ? timeline.badRolloutLabel
    : canaryHealthy.has(index)
      ? timeline.healthyCanaryRolloutLabel
      : timeline.stableRolloutLabel;

  return {
    service: "checkout",
    version: isAffected || canaryHealthy.has(index) ? "2.8.4" : "2.8.3",
    rolloutBatch: batch,
    paymentGatewayRegion: isAffected ? "eu-west-1" : homeRegion,
    taxEngineV2: isAffected,
    retryBudget: 3,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 0.08,
      cooldownSeconds: 45,
    },
    lastChangedAt: isAffected
      ? timeline.badRolloutAt
      : canaryHealthy.has(index)
        ? timeline.healthyCanaryRolloutAt
        : isEuRegional
          ? timeline.regionalPinAt
          : timeline.stableConfigAt,
  };
}

function deployLog(index, config, node, timeline) {
  const lines = [
    `${timeline.deployHeartbeatAt} INFO deploy-agent heartbeat version=${timeline.now.slice(0, 10).replaceAll("-", ".")}.1`,
    `${timeline.inventoryAt} INFO inventory site=${node.site} home_region=${node.homeRegion} zone=${node.zone}`,
  ];
  if (affected.has(index)) {
    lines.push(
      `${timeline.badRolloutAt} INFO rollout applied service=checkout batch=${config.rolloutBatch} version=${config.version}`,
      `${isoTimestamp(Date.parse(timeline.badRolloutAt) + 1000)} INFO config changed paymentGatewayRegion=${config.paymentGatewayRegion} taxEngineV2=${config.taxEngineV2}`,
    );
  } else if (canaryHealthy.has(index)) {
    lines.push(
      `${timeline.healthyCanaryRolloutAt} INFO rollout applied service=checkout batch=${config.rolloutBatch} version=${config.version}`,
      `${isoTimestamp(Date.parse(timeline.healthyCanaryRolloutAt) + 1000)} INFO config validated paymentGatewayRegion=${config.paymentGatewayRegion} taxEngineV2=${config.taxEngineV2}`,
    );
  } else if (regionalEu.has(index)) {
    lines.push(
      `${timeline.regionalPinAt} INFO regional pin refreshed paymentGatewayRegion=eu-west-1 reason=local-acquirer`,
      `${timeline.noRolloutAt} INFO no checkout rollout scheduled for regional pin group`,
    );
  } else {
    lines.push(`${timeline.noRolloutAt} INFO no pending rollout service=checkout`);
  }
  return sortLogLines(lines);
}

function checkoutLog(index, config, node, timeline) {
  const preRolloutVersion = affected.has(index) || canaryHealthy.has(index) ? "2.8.3" : config.version;
  const lines = [
    `${timeline.checkoutStartAt} INFO checkout.start version=${preRolloutVersion}`,
    `${timeline.preRolloutSampleAt} INFO checkout.sample status=ok gateway_region=${node.homeRegion} taxEngineV2=false phase=pre-rollout`,
  ];

  if (oldAuthWarnings.has(index)) {
    lines.push(`${timeline.oldAuthWarningAt} ERROR oidc_refresh_failed provider=legacy-idp retry=1 resolved=true`);
  }

  if (highLatency.has(index)) {
    lines.push(`${timeline.highLatencyAt} WARN inventory.lookup_slow p95_ms=680 status=degraded_dependency`);
    lines.push(`${timeline.healthySampleAt} INFO checkout.sample status=ok gateway_region=${config.paymentGatewayRegion}`);
  } else if (affected.has(index)) {
    lines.push(
      `${timeline.firstPaymentTimeoutAt} ERROR checkout.payment_timeout request=pay_${index}_01 gateway_region=${config.paymentGatewayRegion} expected_region=${node.homeRegion} taxEngineV2=${config.taxEngineV2}`,
      `${timeline.retryExhaustedAt} WARN checkout.retry_budget_exhausted failures_5m=41 batch=${config.rolloutBatch}`,
      `${timeline.secondPaymentTimeoutAt} ERROR checkout.payment_timeout request=pay_${index}_02 gateway_region=${config.paymentGatewayRegion} expected_region=${node.homeRegion} taxEngineV2=${config.taxEngineV2}`,
      `${timeline.degradedAt} ERROR checkout.degraded reason=payment_timeout customer_impact=true`,
    );
  } else {
    lines.push(`${timeline.healthySampleAt} INFO checkout.sample status=ok gateway_region=${config.paymentGatewayRegion}`);
  }

  return sortLogLines(lines);
}

function systemLog(index, timeline) {
  const lines = [
    `${timeline.bootAt} INFO kernel boot_id=demo uptime_hours=72`,
    `${timeline.ntpAt} INFO ntp synchronized offset_ms=2`,
  ];
  if (diskWarnings.has(index)) {
    lines.push(`${timeline.diskWarningAt} WARN disk_pressure path=/var/cache used_pct=86 impact=none`);
  }
  lines.push(`${timeline.healthObservedAt} INFO watchdog status=ok`);
  return sortLogLines(lines);
}

function healthFor(index, config, node, timeline) {
  const healthy = config.paymentGatewayRegion === node.homeRegion && config.taxEngineV2 === false;
  const lastRestartAt = affected.has(index)
    ? timeline.badRestartAt
    : canaryHealthy.has(index)
      ? timeline.healthyCanaryRestartAt
      : timeline.checkoutStartAt;
  return {
    deviceId: node.deviceId,
    service: "checkout",
    status: healthy ? "ok" : "degraded",
    checkedAt: timeline.healthObservedAt,
    lastRestartAt,
    reason: healthy ? null : "payment_timeout",
    checks: {
      process: "running",
      configRegionMatchesHome: config.paymentGatewayRegion === node.homeRegion,
      taxEngineV2Allowed: config.taxEngineV2 === false,
      paymentGatewayReachable: healthy,
    },
  };
}

function metricsFor(index, healthy, timeline) {
  return {
    window: "5m",
    requests: 1200 + index * 7,
    checkoutErrors: healthy ? (highLatency.has(index) ? 2 : 0) : 87 + (index % 9),
    failureRate: healthy ? (highLatency.has(index) ? 0.006 : 0.001) : 0.24 + (index % 5) / 100,
    p95LatencyMs: healthy ? (highLatency.has(index) ? 720 : 118 + (index % 20)) : 3100 + index,
    updatedAt: timeline.healthObservedAt,
  };
}

function repairedConfigFor(config, homeRegion) {
  return {
    ...config,
    paymentGatewayRegion: homeRegion,
    taxEngineV2: false,
  };
}

function repairedHealthFor(node) {
  return {
    deviceId: node.deviceId,
    service: "checkout",
    status: "ok",
    checkedAt: repairTimestampToken,
    lastRestartAt: repairTimestampToken,
    reason: null,
    checks: {
      process: "running",
      configRegionMatchesHome: true,
      taxEngineV2Allowed: true,
      paymentGatewayReachable: true,
    },
  };
}

function repairedMetricsFor(metrics) {
  return {
    window: metrics.window,
    requests: metrics.requests,
    checkoutErrors: 0,
    failureRate: 0.001,
    p95LatencyMs: 125,
    updatedAt: repairTimestampToken,
  };
}

function readmeFor(node) {
  return `# ${node.deviceId}

This container simulates one production edge checkout node.

Useful local paths:

- config/checkout.json: checkout runtime configuration.
- config/node.json: node identity and home region.
- logs/checkout.log: checkout service logs.
- logs/deploy.log: rollout and config deployment logs.
- logs/system.log: local system warnings.
- state/health.json: current checkout health.
- state/metrics.json: recent checkout metrics.
- bin/checkout-snapshot: print one compact JSON checkout snapshot.
- bin/check-health: print health and metrics.
- bin/recent-errors: show recent warnings and errors.
- bin/service restart checkout: recompute health after a config change.

Only change this node when local evidence shows it is part of the active checkout incident.
`;
}

const serviceScript = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${FLEET_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG="$ROOT/config/checkout.json"
NODE="$ROOT/config/node.json"
HEALTH="$ROOT/state/health.json"
METRICS="$ROOT/state/metrics.json"
LOG="$ROOT/logs/checkout.log"
STATUS_FILE="$ROOT/state/service-status.txt"

now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

write_state() {
  local ts
  local device_id
  local payment_region
  local home_region
  local tax_v2
  local rollout
  local status
  local reason_json
  local gateway_ok
  local tax_ok
  local healthy
  local window
  local requests
  local errors
  local failure_rate
  local latency
  local health_tmp
  local metrics_tmp

  ts="$(now_utc)"
  device_id="$(jq -er 'if (.deviceId | type) == "string" and (.deviceId | length) > 0 then .deviceId else error("node.deviceId must be a non-empty string") end' "$NODE")"
  home_region="$(jq -er 'if (.homeRegion | type) == "string" and (.homeRegion | length) > 0 then .homeRegion else error("node.homeRegion must be a non-empty string") end' "$NODE")"
  payment_region="$(jq -er 'if (.paymentGatewayRegion | type) == "string" and (.paymentGatewayRegion | length) > 0 then .paymentGatewayRegion else error("config.paymentGatewayRegion must be a non-empty string") end' "$CONFIG")"
  tax_v2="$(jq -er 'if (.taxEngineV2 | type) == "boolean" then (.taxEngineV2 | tostring) else error("config.taxEngineV2 must be a boolean") end' "$CONFIG")"
  rollout="$(jq -er 'if (.rolloutBatch | type) == "string" and (.rolloutBatch | length) > 0 then .rolloutBatch else error("config.rolloutBatch must be a non-empty string") end' "$CONFIG")"
  window="$(jq -er 'if (.window | type) == "string" and (.window | length) > 0 then .window else error("metrics.window must be a non-empty string") end' "$METRICS")"
  requests="$(jq -er 'if (.requests | type) == "number" and .requests >= 0 and (.requests | floor) == .requests then .requests else error("metrics.requests must be a non-negative integer") end' "$METRICS")"

  gateway_ok=false
  tax_ok=false
  healthy=false
  if [[ "$payment_region" == "$home_region" ]]; then
    gateway_ok=true
  fi
  if [[ "$tax_v2" == "false" ]]; then
    tax_ok=true
  fi

  if [[ "$gateway_ok" == "true" && "$tax_ok" == "true" ]]; then
    healthy=true
    status="ok"
    reason_json="null"
    errors=0
    failure_rate="0.001"
    latency=125
  else
    status="degraded"
    reason_json='"payment_timeout"'
    errors=92
    failure_rate="0.260"
    latency=3200
  fi

  health_tmp="\${HEALTH}.tmp.$$"
  metrics_tmp="\${METRICS}.tmp.$$"
  trap 'rm -f "$health_tmp" "$metrics_tmp"' EXIT

  jq -n \\
    --arg device_id "$device_id" \\
    --arg status "$status" \\
    --arg ts "$ts" \\
    --argjson reason "$reason_json" \\
    --argjson gateway_ok "$gateway_ok" \\
    --argjson tax_ok "$tax_ok" \\
    --argjson healthy "$healthy" \\
    '{
      deviceId: $device_id,
      service: "checkout",
      status: $status,
      checkedAt: $ts,
      lastRestartAt: $ts,
      reason: $reason,
      checks: {
        process: "running",
        configRegionMatchesHome: $gateway_ok,
        taxEngineV2Allowed: $tax_ok,
        paymentGatewayReachable: $healthy
      }
    }' > "$health_tmp"

  jq -n \\
    --arg window "$window" \\
    --argjson requests "$requests" \\
    --argjson errors "$errors" \\
    --argjson failure_rate "$failure_rate" \\
    --argjson latency "$latency" \\
    --arg ts "$ts" \\
    '{
      window: $window,
      requests: $requests,
      checkoutErrors: $errors,
      failureRate: $failure_rate,
      p95LatencyMs: $latency,
      updatedAt: $ts
    }' > "$metrics_tmp"

  mv "$health_tmp" "$HEALTH"
  mv "$metrics_tmp" "$METRICS"
  trap - EXIT

  printf 'running\\n' > "$STATUS_FILE"
  if [[ "$healthy" == "true" ]]; then
    printf '%s INFO checkout.recovered device=%s gateway_region=%s rollout=%s\\n' "$ts" "$device_id" "$payment_region" "$rollout" >> "$LOG"
  else
    printf '%s ERROR checkout.degraded device=%s gateway_region=%s expected_region=%s taxEngineV2=%s\\n' "$ts" "$device_id" "$payment_region" "$home_region" "$tax_v2" >> "$LOG"
  fi
}

case "\${1:-status} \${2:-}" in
  "restart checkout"|"checkout restart")
    printf '%s INFO service.restart requested service=checkout\\n' "$(now_utc)" >> "$LOG"
    write_state
    cat "$HEALTH"
    ;;
  "start checkout")
    write_state
    cat "$HEALTH"
    ;;
  "stop checkout")
    printf 'stopped\\n' > "$STATUS_FILE"
    printf '%s WARN service.stopped service=checkout\\n' "$(now_utc)" >> "$LOG"
    ;;
  "status "|"status checkout")
    cat "$HEALTH"
    ;;
  *)
    echo "usage: bin/service {status|restart checkout|start checkout|stop checkout}" >&2
    exit 2
    ;;
esac
`;

const checkHealthScript = `#!/usr/bin/env bash
set -euo pipefail
ROOT="\${FLEET_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
cat "$ROOT/state/health.json"
echo
cat "$ROOT/state/metrics.json"
`;

const checkoutSnapshotScript = `#!/usr/bin/env bash
set -euo pipefail
ROOT="\${FLEET_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"

jq -ce -n \\
  --slurpfile node "$ROOT/config/node.json" \\
  --slurpfile config "$ROOT/config/checkout.json" \\
  --slurpfile health "$ROOT/state/health.json" \\
  --slurpfile metrics "$ROOT/state/metrics.json" \\
  '
    if ($node | length) != 1 or ($node[0] | type) != "object" then
      error("config/node.json must contain one JSON object")
    elif ($config | length) != 1 or ($config[0] | type) != "object" then
      error("config/checkout.json must contain one JSON object")
    elif ($health | length) != 1 or ($health[0] | type) != "object" then
      error("state/health.json must contain one JSON object")
    elif ($metrics | length) != 1 or ($metrics[0] | type) != "object" then
      error("state/metrics.json must contain one JSON object")
    else
      $node[0] as $node
      | $config[0] as $config
      | $health[0] as $health
      | $metrics[0] as $metrics
      | if ($node.deviceId | type) != "string" or $health.deviceId != $node.deviceId then
          error("node and health device IDs must match")
        else
          {
            node: ($node | {deviceId, role, site, homeRegion, zone}),
            config: $config,
            health: $health,
            metrics: $metrics
          }
        end
    end
  '
`;

const recentErrorsScript = `#!/usr/bin/env bash
set -euo pipefail
ROOT="\${FLEET_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
grep -Eh "ERROR|WARN" "$ROOT"/logs/*.log | tail -n 80 || true
`;

async function writeExecutable(file, content) {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

function isDeviceWorkspaceName(name) {
  return deviceIndexForId(name) !== null;
}

async function readFleetMarker(root) {
  const markerPath = path.join(root, fleetMarkerName);
  let markerStats;
  try {
    markerStats = await lstat(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
    throw new Error(`Refusing to seed: fleet marker is not a regular file: ${markerPath}`);
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Refusing to seed: invalid fleet marker ${markerPath}: ${error.message}`);
  }

  const validDeviceIds =
    Array.isArray(marker.deviceIds) &&
    marker.deviceIds.every((id) => typeof id === "string" && isDeviceWorkspaceName(id)) &&
    new Set(marker.deviceIds).size === marker.deviceIds.length;
  if (
    marker.owner !== fleetMarkerOwner ||
    marker.schemaVersion !== fleetMarkerVersion ||
    marker.scenario !== scenarioName ||
    !validDeviceIds
  ) {
    throw new Error(`Refusing to seed: unrecognized fleet marker ${markerPath}`);
  }

  return marker;
}

async function isRecognizedGeneratedDevice(root, name) {
  const devicePath = path.join(root, name);
  let deviceStats;
  try {
    deviceStats = await lstat(devicePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!deviceStats.isDirectory() || deviceStats.isSymbolicLink()) return false;

  try {
    const [node, config, health] = await Promise.all([
      readFile(path.join(devicePath, "config", "node.json"), "utf8").then(JSON.parse),
      readFile(path.join(devicePath, "config", "checkout.json"), "utf8").then(JSON.parse),
      readFile(path.join(devicePath, "state", "health.json"), "utf8").then(JSON.parse),
    ]);
    return (
      node.deviceId === name &&
      node.role === "edge-checkout" &&
      node.owner === "retail-platform" &&
      node.environment === "production-demo" &&
      config.service === "checkout" &&
      health.deviceId === name &&
      health.service === "checkout"
    );
  } catch {
    return false;
  }
}

async function prepareFleetRoot(root, targetDeviceIds, clean) {
  await mkdir(root, { recursive: true });
  const marker = await readFleetMarker(root);
  const markerDeviceIds = new Set(marker?.deviceIds ?? []);

  if (clean) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!isDeviceWorkspaceName(entry.name)) continue;
      const recognized = await isRecognizedGeneratedDevice(root, entry.name);
      if (markerDeviceIds.has(entry.name) || recognized) {
        await rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  for (const id of targetDeviceIds) {
    const devicePath = path.join(root, id);
    let deviceStats;
    try {
      deviceStats = await lstat(devicePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const recognized = await isRecognizedGeneratedDevice(root, id);
    if (
      deviceStats.isSymbolicLink() ||
      !deviceStats.isDirectory() ||
      (!markerDeviceIds.has(id) && !recognized)
    ) {
      throw new Error(`Refusing to overwrite unrecognized device workspace: ${devicePath}`);
    }
  }
}

async function writeFleetMarker(root, deviceIds, seededAt) {
  const markerPath = path.join(root, fleetMarkerName);
  let markerStats;
  try {
    markerStats = await lstat(markerPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (markerStats?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked fleet marker: ${markerPath}`);
  }

  await writeFile(
    markerPath,
    prettyJson({
      owner: fleetMarkerOwner,
      schemaVersion: fleetMarkerVersion,
      scenario: scenarioName,
      seededAt,
      deviceIds,
    }),
  );
}

async function seedDevice(root, index, truth, timeline) {
  const id = deviceId(index);
  const homeRegion = regionalEu.has(index) ? "eu-west-1" : "us-east-1";
  const node = baseNode(index, id, homeRegion);
  const config = checkoutConfig(index, homeRegion, timeline);
  const health = healthFor(index, config, node, timeline);
  const metrics = metricsFor(index, health.status === "ok", timeline);
  const expectedRepairedConfig = repairedConfigFor(config, homeRegion);
  const expectedRepairedHealth = repairedHealthFor(node);
  const expectedRepairedMetrics = repairedMetricsFor(metrics);
  const dir = path.join(root, id);

  await mkdir(path.join(dir, "bin"), { recursive: true });
  await mkdir(path.join(dir, "config"), { recursive: true });
  await mkdir(path.join(dir, "logs"), { recursive: true });
  await mkdir(path.join(dir, "state"), { recursive: true });

  await writeFile(path.join(dir, "README.md"), readmeFor(node));
  await writeFile(path.join(dir, "config", "node.json"), prettyJson(node));
  await writeFile(path.join(dir, "config", "checkout.json"), prettyJson(config));
  await writeFile(path.join(dir, "logs", "deploy.log"), deployLog(index, config, node, timeline));
  await writeFile(path.join(dir, "logs", "checkout.log"), checkoutLog(index, config, node, timeline));
  await writeFile(path.join(dir, "logs", "system.log"), systemLog(index, timeline));
  await writeFile(path.join(dir, "state", "health.json"), prettyJson(health));
  await writeFile(path.join(dir, "state", "metrics.json"), prettyJson(metrics));
  await writeFile(path.join(dir, "state", "service-status.txt"), "running\n");
  await writeExecutable(path.join(dir, "bin", "service"), serviceScript);
  await writeExecutable(path.join(dir, "bin", "checkout-snapshot"), checkoutSnapshotScript);
  await writeExecutable(path.join(dir, "bin", "check-health"), checkHealthScript);
  await writeExecutable(path.join(dir, "bin", "recent-errors"), recentErrorsScript);

  truth.devices[id] = {
    index,
    affected: affected.has(index),
    redHerrings: [
      diskWarnings.has(index) ? "disk-warning" : null,
      oldAuthWarnings.has(index) ? "old-auth-warning" : null,
      highLatency.has(index) ? "high-latency" : null,
      regionalEu.has(index) ? "intentional-eu-region" : null,
      canaryHealthy.has(index) ? "healthy-canary" : null,
    ].filter(Boolean),
    expectedHomeRegion: homeRegion,
    originalNode: node,
    originalConfig: config,
    originalConfigHash: jsonHash(config),
    originalHealth: health,
    originalHealthHash: jsonHash(health),
    originalMetrics: metrics,
    originalMetricsHash: jsonHash(metrics),
    originalServiceStatus: "running",
    originalLastRestartAt: health.lastRestartAt,
    seededState: {
      configHash: jsonHash(config),
      healthHash: jsonHash(health),
      metricsHash: jsonHash(metrics),
      serviceStatus: "running",
      lastRestartAt: health.lastRestartAt,
    },
    expectedFixedConfig: {
      paymentGatewayRegion: homeRegion,
      taxEngineV2: false,
    },
    expectedRepairedConfig,
    expectedRepairedConfigHash: jsonHash(expectedRepairedConfig),
    expectedRepairedHealth,
    expectedRepairedHealthHash: jsonHash(expectedRepairedHealth),
    expectedRepairedMetrics,
    expectedRepairedMetricsHash: jsonHash(expectedRepairedMetrics),
    expectedRepairedServiceStatus: "running",
    expectedRestart: {
      timestampToken: repairTimestampToken,
      originalLastRestartAt: health.lastRestartAt,
      synchronizedFields: ["health.checkedAt", "health.lastRestartAt", "metrics.updatedAt"],
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  const truthPath = path.resolve(opts.truth);
  const scenarioClock = parseScenarioClock(process.env.DEMO_FLEET_NOW);
  const timeline = buildTimeline(scenarioClock);
  const targetDeviceIds = Array.from({ length: opts.count }, (_, offset) => deviceId(offset + 1));

  await prepareFleetRoot(root, targetDeviceIds, opts.clean);
  await mkdir(path.dirname(truthPath), { recursive: true });

  const truth = {
    schemaVersion: 2,
    scenario: scenarioName,
    generatedAt: timeline.now,
    seededAt: timeline.now,
    repairTimestampToken,
    timeline,
    deviceCount: opts.count,
    affected: [],
    redHerrings: {
      diskWarnings: [],
      oldAuthWarnings: [],
      highLatency: [],
      regionalEu: [],
      canaryHealthy: [],
    },
    devices: {},
  };

  for (let index = 1; index <= opts.count; index += 1) {
    const id = deviceId(index);
    if (affected.has(index)) truth.affected.push(id);
    if (diskWarnings.has(index)) truth.redHerrings.diskWarnings.push(id);
    if (oldAuthWarnings.has(index)) truth.redHerrings.oldAuthWarnings.push(id);
    if (highLatency.has(index)) truth.redHerrings.highLatency.push(id);
    if (regionalEu.has(index)) truth.redHerrings.regionalEu.push(id);
    if (canaryHealthy.has(index)) truth.redHerrings.canaryHealthy.push(id);
    await seedDevice(root, index, truth, timeline);
  }

  await writeFleetMarker(root, targetDeviceIds, timeline.now);
  await writeFile(truthPath, prettyJson(truth));
  console.log(`Seeded ${opts.count} device workspaces in ${root}`);
  console.log(`Wrote verifier ground truth to ${truthPath}`);
  console.log(`Affected devices: ${truth.affected.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
