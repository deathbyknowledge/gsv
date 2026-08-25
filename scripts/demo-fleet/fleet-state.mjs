import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

export const DEMO_SCENARIO = "checkout-config-rollout-incident";
export const DEMO_DEVICE_COUNT = 100;
export const DEMO_MAX_DEVICE_COUNT = 1_000;
export const DEMO_INCIDENT_COUNT = 17;
export const DEMO_INCIDENT_INDEXES = Object.freeze([3, 8, 14, 19, 22, 27, 31, 38, 44, 52, 59, 63, 71, 76, 82, 88, 96]);

const DEVICE_ID_PATTERN = /^edge-(\d{3}|1000)$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function deviceIdForIndex(index) {
  if (!Number.isInteger(index) || index < 1 || index > DEMO_MAX_DEVICE_COUNT) {
    throw new RangeError(`device index must be an integer from 1 to ${DEMO_MAX_DEVICE_COUNT}`);
  }
  return `edge-${String(index).padStart(3, "0")}`;
}

export function deviceIndexForId(deviceId) {
  if (typeof deviceId !== "string") return null;
  const match = DEVICE_ID_PATTERN.exec(deviceId);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 1 && index <= DEMO_MAX_DEVICE_COUNT && deviceIdForIndex(index) === deviceId
    ? index
    : null;
}

export function semanticEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseInstant(value) {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortDeviceIds(left, right) {
  const leftIndex = deviceIndexForId(left);
  const rightIndex = deviceIndexForId(right);
  if (leftIndex !== null && rightIndex !== null) return leftIndex - rightIndex;
  return left.localeCompare(right);
}

export function repairedConfigFor(expected) {
  if (!isRecord(expected?.originalConfig)) return null;
  return {
    ...expected.originalConfig,
    paymentGatewayRegion: expected.expectedHomeRegion,
    taxEngineV2: false,
  };
}

export function materializeTimestampTemplate(template, token, timestamp) {
  if (template === token) return timestamp;
  if (Array.isArray(template)) {
    return template.map((value) => materializeTimestampTemplate(value, token, timestamp));
  }
  if (isRecord(template)) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, materializeTimestampTemplate(value, token, timestamp)]),
    );
  }
  return template;
}

function describeReadError(error, kind) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    return `missing ${kind}`;
  }
  if (error instanceof SyntaxError) return `invalid JSON: ${error.message}`;
  return `unreadable ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

async function readJsonResult(file, kind) {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, "utf8")), file };
  } catch (error) {
    return { ok: false, message: describeReadError(error, kind), file };
  }
}

async function readTextResult(file, kind) {
  try {
    return { ok: true, value: await readFile(file, "utf8"), file };
  } catch (error) {
    return { ok: false, message: describeReadError(error, kind), file };
  }
}

function issue(scope, message, file) {
  return { scope, message, file };
}

function validateExpectedDevice(deviceId, expected, affectedSet) {
  const issues = [];
  const deviceIndex = deviceIndexForId(deviceId);
  if (deviceIndex === null) {
    issues.push(issue(deviceId, "device ID must be canonical edge-NNN (or edge-1000) format"));
  }
  if (!isRecord(expected)) {
    issues.push(issue(deviceId, "ground truth device entry must be an object"));
    return issues;
  }
  if (!Number.isInteger(expected.index) || expected.index !== deviceIndex) {
    issues.push(issue(deviceId, "ground truth index does not match device ID"));
  }
  if (typeof expected.affected !== "boolean" || expected.affected !== affectedSet.has(deviceId)) {
    issues.push(issue(deviceId, "ground truth affected flag is inconsistent"));
  }
  if (!isRecord(expected.originalConfig)) {
    issues.push(issue(deviceId, "ground truth originalConfig must be an object"));
  }
  if (expected.originalNode !== undefined && !isRecord(expected.originalNode)) {
    issues.push(issue(deviceId, "ground truth originalNode must be an object"));
  }
  if (typeof expected.expectedHomeRegion !== "string" || expected.expectedHomeRegion.length === 0) {
    issues.push(issue(deviceId, "ground truth expectedHomeRegion must be a non-empty string"));
  }

  const repairedConfig = repairedConfigFor(expected);
  if (affectedSet.has(deviceId) && repairedConfig) {
    if (expected.originalConfig.paymentGatewayRegion === expected.expectedHomeRegion) {
      issues.push(issue(deviceId, "incident config does not contain the expected region fault"));
    }
    if (expected.originalConfig.taxEngineV2 !== true) {
      issues.push(issue(deviceId, "incident config does not contain the expected taxEngineV2 fault"));
    }
  }
  if (expected.expectedRepairedConfig !== undefined && !semanticEqual(expected.expectedRepairedConfig, repairedConfig)) {
    issues.push(issue(deviceId, "expectedRepairedConfig is inconsistent with the two surgical fixes"));
  }
  if (expected.expectedFixedConfig !== undefined) {
    const legacyExpected = {
      paymentGatewayRegion: expected.expectedHomeRegion,
      taxEngineV2: false,
    };
    if (!semanticEqual(expected.expectedFixedConfig, legacyExpected)) {
      issues.push(issue(deviceId, "expectedFixedConfig is inconsistent with the two surgical fixes"));
    }
  }
  if (expected.originalHealth !== undefined && !isRecord(expected.originalHealth)) {
    issues.push(issue(deviceId, "ground truth originalHealth must be an object"));
  }
  if (expected.originalMetrics !== undefined && !isRecord(expected.originalMetrics)) {
    issues.push(issue(deviceId, "ground truth originalMetrics must be an object"));
  }
  if (expected.expectedRepairedHealth !== undefined && !isRecord(expected.expectedRepairedHealth)) {
    issues.push(issue(deviceId, "ground truth expectedRepairedHealth must be an object"));
  }
  if (expected.expectedRepairedMetrics !== undefined && !isRecord(expected.expectedRepairedMetrics)) {
    issues.push(issue(deviceId, "ground truth expectedRepairedMetrics must be an object"));
  }
  if (expected.originalLastRestartAt !== undefined && parseInstant(expected.originalLastRestartAt) === null) {
    issues.push(issue(deviceId, "ground truth originalLastRestartAt must be an ISO-8601 UTC instant"));
  }
  if (expected.expectedRestart !== undefined) {
    if (!isRecord(expected.expectedRestart)) {
      issues.push(issue(deviceId, "ground truth expectedRestart must be an object"));
    } else {
      if (expected.expectedRestart.originalLastRestartAt !== expected.originalLastRestartAt) {
        issues.push(issue(deviceId, "expectedRestart original timestamp is inconsistent"));
      }
      if (typeof expected.expectedRestart.timestampToken !== "string") {
        issues.push(issue(deviceId, "expectedRestart timestampToken must be a string"));
      }
    }
  }
  return issues;
}

export function validateGroundTruth(truth) {
  const issues = [];
  if (!isRecord(truth)) return [issue("truth", "ground truth must be a JSON object")];
  if (truth.schemaVersion !== undefined && truth.schemaVersion !== 2) {
    issues.push(issue("truth", `unsupported schemaVersion ${JSON.stringify(truth.schemaVersion)}`));
  }
  if (truth.scenario !== DEMO_SCENARIO) {
    issues.push(issue("truth", `scenario must be ${DEMO_SCENARIO}`));
  }
  if (!isRecord(truth.devices)) {
    issues.push(issue("truth", "devices must be an object"));
    return issues;
  }
  if (!Array.isArray(truth.affected)) {
    issues.push(issue("truth", "affected must be an array"));
    return issues;
  }

  const deviceIds = Object.keys(truth.devices).sort(sortDeviceIds);
  const affectedIds = truth.affected.filter((deviceId) => typeof deviceId === "string");
  const affectedSet = new Set(affectedIds);
  if (affectedSet.size !== truth.affected.length || truth.affected.some((id) => typeof id !== "string")) {
    issues.push(issue("truth", "affected must contain unique device IDs"));
  }
  const deviceCountValid = Number.isInteger(truth.deviceCount)
    && truth.deviceCount >= 1
    && truth.deviceCount <= DEMO_MAX_DEVICE_COUNT;
  if (!deviceCountValid) {
    issues.push(issue("truth", `deviceCount must be an integer from 1 to ${DEMO_MAX_DEVICE_COUNT}`));
  }
  if (truth.deviceCount !== deviceIds.length) {
    issues.push(issue("truth", `deviceCount=${truth.deviceCount} but devices contains ${deviceIds.length} entries`));
  }
  const expectedCount = deviceCountValid ? truth.deviceCount : deviceIds.length;
  const expectedAffected = DEMO_INCIDENT_INDEXES
    .filter((index) => index <= expectedCount)
    .map(deviceIdForIndex);
  if (!semanticEqual([...affectedSet].sort(sortDeviceIds), expectedAffected)) {
    issues.push(issue("truth", `affected set does not match the deterministic ${expectedCount}-device scenario`));
  }
  for (let index = 1; index <= expectedCount; index += 1) {
    const expectedId = deviceIdForIndex(index);
    if (!Object.hasOwn(truth.devices, expectedId)) {
      issues.push(issue("truth", `missing device entry ${expectedId}`));
    }
  }
  for (const affectedId of affectedSet) {
    if (!Object.hasOwn(truth.devices, affectedId)) {
      issues.push(issue("truth", `affected device ${affectedId} has no device entry`));
    }
  }
  for (const deviceId of deviceIds) {
    issues.push(...validateExpectedDevice(deviceId, truth.devices[deviceId], affectedSet));
    const expectedToken = truth.devices[deviceId]?.expectedRestart?.timestampToken;
    if (expectedToken !== undefined && expectedToken !== truth.repairTimestampToken) {
      issues.push(issue(deviceId, "expectedRestart timestamp token differs from the fleet token"));
    }
  }

  const seededAt = truth.seededAt ?? truth.generatedAt;
  if (parseInstant(seededAt) === null) {
    issues.push(issue("truth", "seededAt (or legacy generatedAt) must be an ISO-8601 UTC instant"));
  }
  if (truth.repairTimestampToken !== undefined && typeof truth.repairTimestampToken !== "string") {
    issues.push(issue("truth", "repairTimestampToken must be a string"));
  }
  return issues;
}

async function findWorkspaceIssues(root, expectedIds) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const actualIds = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("edge-"))
      .map((entry) => entry.name);
    const expectedSet = new Set(expectedIds);
    return actualIds
      .filter((deviceId) => !expectedSet.has(deviceId))
      .sort(sortDeviceIds)
      .map((deviceId) => issue("fleet", `unexpected device workspace ${deviceId}`, path.join(root, deviceId)));
  } catch (error) {
    return [issue("fleet", describeReadError(error, "fleet directory"), root)];
  }
}

async function readDevice(root, deviceId, expected) {
  const deviceRoot = path.join(root, deviceId);
  const [config, node, health, metrics, serviceStatus, checkoutLog] = await Promise.all([
    readJsonResult(path.join(deviceRoot, "config", "checkout.json"), "checkout config"),
    readJsonResult(path.join(deviceRoot, "config", "node.json"), "node config"),
    readJsonResult(path.join(deviceRoot, "state", "health.json"), "health state"),
    readJsonResult(path.join(deviceRoot, "state", "metrics.json"), "metrics state"),
    readTextResult(path.join(deviceRoot, "state", "service-status.txt"), "service status"),
    readTextResult(path.join(deviceRoot, "logs", "checkout.log"), "checkout log"),
  ]);
  return { deviceId, expected, deviceRoot, config, node, health, metrics, serviceStatus, checkoutLog };
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function loadFleetSnapshot({ root, truthPath }) {
  const resolvedRoot = path.resolve(root);
  const resolvedTruthPath = path.resolve(truthPath);
  const truthResult = await readJsonResult(resolvedTruthPath, "ground truth");
  if (!truthResult.ok) {
    return {
      root: resolvedRoot,
      truthPath: resolvedTruthPath,
      truth: null,
      truthIssues: [issue("truth", truthResult.message, truthResult.file)],
      workspaceIssues: [],
      devices: [],
    };
  }

  const truth = truthResult.value;
  const truthIssues = validateGroundTruth(truth);
  const entries = isRecord(truth?.devices) ? Object.entries(truth.devices) : [];
  entries.sort(([left], [right]) => sortDeviceIds(left, right));
  const [workspaceIssues, devices] = await Promise.all([
    findWorkspaceIssues(resolvedRoot, entries.map(([deviceId]) => deviceId)),
    mapWithConcurrency(
      entries,
      64,
      ([deviceId, expected]) => readDevice(resolvedRoot, deviceId, expected),
    ),
  ]);
  return { resolvedRoot, root: resolvedRoot, truthPath: resolvedTruthPath, truth, truthIssues, workspaceIssues, devices };
}

function resultIssue(result) {
  return result.ok ? null : `${result.message} (${result.file})`;
}

function healthShapeProblems(device) {
  const problems = [];
  if (!device.health.ok || !device.config.ok || !device.node.ok || !device.serviceStatus.ok) {
    for (const result of [device.config, device.node, device.health, device.serviceStatus]) {
      const problem = resultIssue(result);
      if (problem) problems.push(problem);
    }
    return problems;
  }

  const { deviceId } = device;
  const config = device.config.value;
  const node = device.node.value;
  const health = device.health.value;
  if (!isRecord(config)) problems.push("checkout config must be a JSON object");
  if (!isRecord(node)) problems.push("node config must be a JSON object");
  if (!isRecord(health)) problems.push("health state must be a JSON object");
  if (problems.length > 0) return problems;

  if (node.deviceId !== deviceId) problems.push(`node deviceId is ${JSON.stringify(node.deviceId)}`);
  if (node.homeRegion !== device.expected?.expectedHomeRegion) {
    problems.push(`node homeRegion is ${JSON.stringify(node.homeRegion)}, expected ${JSON.stringify(device.expected?.expectedHomeRegion)}`);
  }
  if (health.deviceId !== deviceId) problems.push(`health deviceId is ${JSON.stringify(health.deviceId)}`);
  if (health.service !== "checkout") problems.push(`health service is ${JSON.stringify(health.service)}`);
  if (device.serviceStatus.value.trim() !== "running") {
    problems.push(`service status is ${JSON.stringify(device.serviceStatus.value.trim() || "empty")}`);
  }
  if (health.checks?.process !== "running") problems.push("health process check is not running");

  const regionMatches = config.paymentGatewayRegion === node.homeRegion;
  const taxAllowed = config.taxEngineV2 === false;
  if (health.checks?.configRegionMatchesHome !== regionMatches) {
    problems.push("region health check does not match current config");
  }
  if (health.checks?.taxEngineV2Allowed !== taxAllowed) {
    problems.push("tax-engine health check does not match current config");
  }
  if (parseInstant(health.checkedAt) === null) problems.push("health checkedAt is not an ISO-8601 UTC instant");
  if (parseInstant(health.lastRestartAt) === null) problems.push("health lastRestartAt is not an ISO-8601 UTC instant");
  return problems;
}

function strictHealthyProblems(device) {
  const problems = healthShapeProblems(device);
  if (!device.health.ok || !isRecord(device.health.value)) return problems;
  const health = device.health.value;
  if (health.status !== "ok") problems.push(`health status is ${JSON.stringify(health.status)}`);
  if (health.reason !== null) problems.push(`healthy reason must be null, found ${JSON.stringify(health.reason)}`);
  if (health.checks?.configRegionMatchesHome !== true) problems.push("region health check is not healthy");
  if (health.checks?.taxEngineV2Allowed !== true) problems.push("tax-engine health check is not healthy");
  if (health.checks?.paymentGatewayReachable !== true) problems.push("payment gateway health check is not healthy");
  return [...new Set(problems)];
}

function strictDegradedProblems(device) {
  const problems = healthShapeProblems(device);
  if (!device.health.ok || !isRecord(device.health.value)) return problems;
  const health = device.health.value;
  if (health.status !== "degraded") problems.push(`health status is ${JSON.stringify(health.status)}`);
  if (health.reason !== "payment_timeout") problems.push(`degraded reason is ${JSON.stringify(health.reason)}`);
  if (health.checks?.configRegionMatchesHome !== false) problems.push("region health check is not degraded");
  if (health.checks?.taxEngineV2Allowed !== false) problems.push("tax-engine health check is not degraded");
  if (health.checks?.paymentGatewayReachable !== false) problems.push("payment gateway health check is not degraded");
  return [...new Set(problems)];
}

function parseRecoveryEvents(log) {
  const restarts = [];
  const recoveries = [];
  for (const line of log.split(/\r?\n/)) {
    const restartMatch = /^(\S+) INFO service\.restart requested service=checkout(?:\s|$)/.exec(line);
    if (restartMatch) restarts.push({ raw: restartMatch[1], timestamp: parseInstant(restartMatch[1]) });
    const recoveryMatch = /^(\S+) INFO checkout\.recovered device=(\S+)(?:\s|$)/.exec(line);
    if (recoveryMatch) {
      recoveries.push({ raw: recoveryMatch[1], timestamp: parseInstant(recoveryMatch[1]), deviceId: recoveryMatch[2] });
    }
  }
  return { restarts, recoveries };
}

function recoveryProblems(device, truth) {
  const problems = [];
  if (!device.health.ok || !isRecord(device.health.value)) return [resultIssue(device.health) ?? "health state is invalid"];
  if (!device.checkoutLog.ok) return [resultIssue(device.checkoutLog)];

  const health = device.health.value;
  const restartAt = parseInstant(health.lastRestartAt);
  const checkedAt = parseInstant(health.checkedAt);
  const seededAtRaw = truth?.seededAt ?? truth?.generatedAt;
  const seededAt = parseInstant(seededAtRaw);
  if (seededAt === null) problems.push("ground truth has no valid seed timestamp");
  if (restartAt === null) problems.push("health has no valid restart timestamp");
  if (checkedAt === null) problems.push("health has no valid check timestamp");
  if (restartAt !== null && checkedAt !== null && checkedAt < restartAt) {
    problems.push("health check predates its reported restart");
  }

  const originalRestartRaw = device.expected?.originalLastRestartAt ?? device.expected?.originalHealth?.lastRestartAt;
  const originalRestartAt = parseInstant(originalRestartRaw);
  if (originalRestartRaw !== undefined && originalRestartAt === null) {
    problems.push("ground truth has an invalid original restart timestamp");
  }
  if (restartAt !== null && originalRestartAt !== null && restartAt <= originalRestartAt) {
    problems.push("restart timestamp did not advance from seeded health");
  }

  const cutoff = seededAt === null ? null : Math.floor(seededAt / 1000) * 1000;
  if (restartAt !== null && cutoff !== null && restartAt < cutoff) {
    problems.push("restart timestamp predates fleet seeding");
  }

  const events = parseRecoveryEvents(device.checkoutLog.value);
  const matchingRestart = restartAt === null
    ? null
    : events.restarts.find(
        (event) => event.timestamp !== null
          && event.timestamp <= restartAt
          && event.timestamp >= restartAt - 5_000
          && (cutoff === null || event.timestamp >= cutoff),
      );
  const matchingRecovery = restartAt === null
    ? null
    : events.recoveries.find(
        (event) => event.deviceId === device.deviceId && event.timestamp === restartAt && (cutoff === null || event.timestamp >= cutoff),
      );
  if (!matchingRestart) problems.push("no post-seed restart log matches health.lastRestartAt");
  if (!matchingRecovery) problems.push("no post-seed recovery log matches health.lastRestartAt and device ID");
  return [...new Set(problems.filter(Boolean))];
}

export function exactRepairedStateProblems(device, truth) {
  const problems = [];
  if (!device.health.ok || !isRecord(device.health.value)) return problems;
  const restartAt = device.health.value.lastRestartAt;
  const token = truth?.repairTimestampToken ?? "$RESTART_AT";

  if (isRecord(device.expected?.expectedRepairedHealth)) {
    const expectedHealth = materializeTimestampTemplate(device.expected.expectedRepairedHealth, token, restartAt);
    if (!semanticEqual(device.health.value, expectedHealth)) {
      problems.push("health state is not the exact recovered state");
    }
  }
  if (isRecord(device.expected?.expectedRepairedMetrics)) {
    if (!device.metrics.ok || !isRecord(device.metrics.value)) {
      problems.push(resultIssue(device.metrics) ?? "metrics state must be a JSON object");
    } else {
      const expectedMetrics = materializeTimestampTemplate(device.expected.expectedRepairedMetrics, token, restartAt);
      if (!semanticEqual(device.metrics.value, expectedMetrics)) {
        problems.push("metrics state is not the exact recovered state");
      }
    }
  }
  if (typeof device.expected?.expectedRepairedServiceStatus === "string") {
    if (!device.serviceStatus.ok || device.serviceStatus.value.trim() !== device.expected.expectedRepairedServiceStatus) {
      problems.push("service status is not the exact recovered state");
    }
  }
  return [...new Set(problems.filter(Boolean))];
}

export function assessDevice(device, truth) {
  const originalConfig = device.expected?.originalConfig;
  const repairedConfig = repairedConfigFor(device.expected);
  const configIsObject = device.config.ok && isRecord(device.config.value);
  const nodeIsObject = device.node.ok && isRecord(device.node.value);
  const healthIsObject = device.health.ok && isRecord(device.health.value);
  const configOriginal = configIsObject && isRecord(originalConfig) && semanticEqual(device.config.value, originalConfig);
  const configRepaired = configIsObject && repairedConfig !== null && semanticEqual(device.config.value, repairedConfig);
  const healthyProblems = strictHealthyProblems(device);
  const degradedProblems = strictDegradedProblems(device);
  const evidenceProblems = recoveryProblems(device, truth);
  const repairedStateProblems = exactRepairedStateProblems(device, truth);
  const serviceRunning = device.serviceStatus.ok && device.serviceStatus.value.trim() === "running";
  const nodeValid = nodeIsObject && (isRecord(device.expected?.originalNode)
    ? semanticEqual(device.node.value, device.expected.originalNode)
    : device.node.value.deviceId === device.deviceId
      && device.node.value.homeRegion === device.expected?.expectedHomeRegion);
  const healthy = healthyProblems.length === 0;
  const degraded = degradedProblems.length === 0;
  const recovered = configRepaired
    && !configOriginal
    && healthy
    && serviceRunning
    && evidenceProblems.length === 0
    && repairedStateProblems.length === 0;
  const drift = configIsObject && !configOriginal && !configRepaired;
  const unreadable = !configIsObject
    || !nodeIsObject
    || !healthIsObject
    || !device.metrics.ok
    || !isRecord(device.metrics.value)
    || !device.serviceStatus.ok;
  return {
    ...device,
    repairedConfig,
    configOriginal,
    configRepaired,
    drift,
    nodeValid,
    serviceRunning,
    healthy,
    degraded,
    recovered,
    unreadable,
    healthyProblems,
    degradedProblems,
    evidenceProblems,
    repairedStateProblems,
  };
}

export function assessSnapshot(snapshot) {
  return {
    ...snapshot,
    devices: snapshot.devices.map((device) => assessDevice(device, snapshot.truth)),
  };
}

export function formatIssue(entry) {
  return `${entry.scope}: ${entry.message}${entry.file ? ` (${entry.file})` : ""}`;
}
