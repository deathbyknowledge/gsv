import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_COMPONENTS = Object.freeze(["ripgit", "assembler", "gateway"]);
export const ALL_COMPONENTS = Object.freeze([
  "ripgit",
  "assembler",
  "channel-whatsapp",
  "channel-discord",
  "channel-telegram",
  "gateway",
]);

const SECRET_FIELD = /(authorization|credential|password|secret|token|api[_-]?key)/i;
const INSTANCE_PATTERN = /^gsv-e2e-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function requireExactStrings(actual, expected, field) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) {
    fail(`${field} must be a string array`);
  }
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    fail(`${field} must contain exactly: ${expected.join(", ")}`);
  }
}

function rejectCredentialFields(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentialFields(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      fail(`${path}.${key} is a credential-bearing field`);
    }
    rejectCredentialFields(item, `${path}.${key}`);
  }
}

function requireSafeHttpsUrl(raw, field) {
  const value = requireString(raw, field);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:") {
    fail(`${field} must use https`);
  }
  if (url.username || url.password) {
    fail(`${field} must not contain credentials`);
  }
  if (url.search || url.hash) {
    fail(`${field} must not contain a query or fragment`);
  }
  return url;
}

export function validateInstance(raw) {
  const instance = requireString(raw, "instance");
  if (instance.length > 40 || !INSTANCE_PATTERN.test(instance)) {
    fail("instance must start with gsv-e2e-, contain lowercase letters, digits, or hyphens, and be at most 40 characters");
  }
  return instance;
}

export function normalizeBootstrapSource(raw) {
  const source = requireString(raw, "bootstrap source").trim();
  let normalized = source;
  const scpMatch = /^git@github\.com:([^/]+\/.+)$/.exec(source);
  if (scpMatch) {
    normalized = `https://github.com/${scpMatch[1]}`;
  } else if (source.startsWith("ssh://git@github.com/")) {
    normalized = `https://github.com/${source.slice("ssh://git@github.com/".length)}`;
  }
  const url = requireSafeHttpsUrl(normalized, "bootstrap source");
  return url.toString().replace(/\/$/, "");
}

export function readJson(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) {
    fail(`${path} must contain a JSON object`);
  }
  return value;
}

export function validateLeaseManifest(value, expected) {
  rejectCredentialFields(value);
  requireExactStrings(
    Object.keys(value),
    ["schema_version", "instance", "release", "components", "workers", "r2_bucket", "gateway_url"],
    "lease fields",
  );
  if (value.schema_version !== 1) {
    fail("lease schema_version must be 1");
  }
  const instance = validateInstance(value.instance);
  if (instance !== expected.instance) {
    fail(`lease instance ${instance} does not match owned instance ${expected.instance}`);
  }
  if (requireString(value.release, "lease release") !== expected.release) {
    fail(`lease release does not match ${expected.release}`);
  }
  requireExactStrings(value.components, CORE_COMPONENTS, "lease components");
  if (!isRecord(value.workers)) {
    fail("lease workers must be an object keyed by component");
  }
  requireExactStrings(Object.keys(value.workers), CORE_COMPONENTS, "lease worker keys");
  const expectedWorkers = {
    gateway: instance,
    ripgit: `${instance}-ripgit`,
    assembler: `${instance}-assembler`,
  };
  for (const [component, expectedName] of Object.entries(expectedWorkers)) {
    if (value.workers[component] !== expectedName) {
      fail(`lease worker ${component} must be ${expectedName}`);
    }
  }
  if (value.r2_bucket !== `${instance}-storage`) {
    fail(`lease r2_bucket must be ${instance}-storage`);
  }
  const gatewayUrl = requireSafeHttpsUrl(value.gateway_url, "lease gateway_url");
  return {
    instance,
    gatewayUrl: gatewayUrl.toString().replace(/\/$/, ""),
  };
}

export function validateStatus(value, expectedInstance) {
  rejectCredentialFields(value, "status");
  if (value.schema_version !== 1) {
    fail("status schema_version must be 1");
  }
  if (validateInstance(value.instance) !== expectedInstance) {
    fail(`status instance does not match owned instance ${expectedInstance}`);
  }
  if (!["absent", "partial", "deployed"].includes(value.state)) {
    fail("status state must be absent, partial, or deployed");
  }
  if (!Array.isArray(value.workers)) {
    fail("status workers must be an array");
  }
  const workersByComponent = new Map();
  for (const [index, worker] of value.workers.entries()) {
    if (!isRecord(worker)) {
      fail(`status workers[${index}] must be an object`);
    }
    requireString(worker.component, `status workers[${index}].component`);
    requireString(worker.name, `status workers[${index}].name`);
    if (typeof worker.deployed !== "boolean") {
      fail(`status workers[${index}].deployed must be boolean`);
    }
    if (worker.migration_tag !== undefined && typeof worker.migration_tag !== "string") {
      fail(`status workers[${index}].migration_tag must be a string when present`);
    }
    if (workersByComponent.has(worker.component)) {
      fail(`status contains duplicate worker component ${worker.component}`);
    }
    workersByComponent.set(worker.component, worker);
  }
  requireExactStrings([...workersByComponent.keys()], ALL_COMPONENTS, "status worker components");
  for (const component of ALL_COMPONENTS) {
    const expectedName = component === "gateway"
      ? expectedInstance
      : `${expectedInstance}-${component}`;
    if (workersByComponent.get(component).name !== expectedName) {
      fail(`status worker ${component} must be ${expectedName}`);
    }
  }
  if (!isRecord(value.r2_bucket)) {
    fail("status r2_bucket must be an object");
  }
  if (requireString(value.r2_bucket.name, "status r2_bucket.name") !== `${expectedInstance}-storage`) {
    fail(`status r2_bucket.name must be ${expectedInstance}-storage`);
  }
  if (typeof value.r2_bucket.exists !== "boolean") {
    fail("status r2_bucket.exists must be boolean");
  }

  const existence = [
    ...ALL_COMPONENTS.map((component) => workersByComponent.get(component).deployed),
    value.r2_bucket.exists,
  ];
  const derivedState = existence.every(Boolean)
    ? "deployed"
    : existence.some(Boolean)
      ? "partial"
      : "absent";
  if (value.state !== derivedState) {
    fail(`status state ${value.state} is inconsistent with resource inventory ${derivedState}`);
  }
  return value;
}

export function assertStatusAbsent(value, expectedInstance) {
  const status = validateStatus(value, expectedInstance);
  if (status.state !== "absent") {
    fail(`instance collision: ${expectedInstance} is ${status.state}, not absent`);
  }
}

export function toWebSocketUrl(raw) {
  const url = requireSafeHttpsUrl(raw, "gateway URL");
  url.protocol = "wss:";
  url.pathname = "/ws";
  return url.toString();
}

function usage() {
  return [
    "usage:",
    "  node config.mjs validate-instance INSTANCE",
    "  node config.mjs normalize-bootstrap-source SOURCE",
    "  node config.mjs validate-lease FILE INSTANCE RELEASE",
    "  node config.mjs gateway-url FILE INSTANCE RELEASE",
    "  node config.mjs websocket-url FILE INSTANCE RELEASE",
    "  node config.mjs assert-status-absent FILE INSTANCE",
  ].join("\n");
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "validate-instance":
      console.log(validateInstance(args[0]));
      return;
    case "normalize-bootstrap-source":
      console.log(normalizeBootstrapSource(args[0]));
      return;
    case "validate-lease":
      validateLeaseManifest(readJson(args[0]), { instance: args[1], release: args[2] });
      return;
    case "gateway-url":
      console.log(validateLeaseManifest(readJson(args[0]), { instance: args[1], release: args[2] }).gatewayUrl);
      return;
    case "websocket-url":
      console.log(toWebSocketUrl(validateLeaseManifest(readJson(args[0]), { instance: args[1], release: args[2] }).gatewayUrl));
      return;
    case "assert-status-absent":
      assertStatusAbsent(readJson(args[0]), args[1]);
      return;
    default:
      fail(usage());
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
