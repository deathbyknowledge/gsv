import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultAdaptersRoot = path.join(scriptRoot, "adapters");
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const bindingName = { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" };
const workerDeployment = {
  type: "object",
  additionalProperties: false,
  required: [
    "main",
    "bundle",
    "gatewayEntrypoint",
    "adapterEntrypoint",
    "durableObjects",
    "requiredSecrets",
  ],
  properties: {
    main: { type: "string", minLength: 1 },
    bundle: { type: "boolean" },
    gatewayEntrypoint: { type: "string", minLength: 1 },
    adapterEntrypoint: { type: "string", minLength: 1 },
    durableObjects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["binding", "className"],
        properties: {
          binding: bindingName,
          className: { type: "string", minLength: 1 },
        },
      },
    },
    requiredSecrets: { type: "array", items: bindingName },
    selfUrlBinding: bindingName,
  },
};
const validateAdapterManifest = new Ajv({ allErrors: true }).compile({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "id",
    "displayName",
    "description",
    "deployOrder",
    "wranglerConfig",
    "devStateDirectories",
    "standalone",
  ],
  properties: {
    version: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 64 },
    displayName: { type: "string", minLength: 1, pattern: "^[^\\t\\r\\n]+$" },
    description: { type: "string", minLength: 1, pattern: "^[^\\t\\r\\n]+$" },
    deployOrder: { type: "integer", minimum: 1 },
    wranglerConfig: { type: "string", minLength: 1 },
    devStateDirectories: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    standalone: workerDeployment,
    managed: workerDeployment,
  },
});

export async function loadAdapterCatalog(adaptersRoot = defaultAdaptersRoot) {
  const entries = await readdir(adaptersRoot, { withFileTypes: true });
  const adapters = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join("adapters", entry.name);
    const manifestPath = path.join(adaptersRoot, entry.name, "adapter.json");
    let source;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const parsed = JSON.parse(source);
    if (!validateAdapterManifest(parsed)) {
      throw new Error(
        `Adapter manifest ${manifestPath} is invalid: ${JSON.stringify(validateAdapterManifest.errors)}`,
      );
    }
    const adapter = {
      ...parsed,
      sourceDir,
      component: `channel-${parsed.id}`,
      defaultScript: `gsv-channel-${parsed.id}`,
      instanceSuffix: `channel-${parsed.id}`,
      gatewayBinding: `CHANNEL_${parsed.id.replaceAll("-", "_").toUpperCase()}`,
      entrypoint: parsed.standalone.gatewayEntrypoint,
    };
    validateAdapter(adapter, entry.name);
    adapters.push(adapter);
  }
  adapters.sort((left, right) =>
    left.deployOrder - right.deployOrder || left.id.localeCompare(right.id)
  );
  if (adapters.length === 0) {
    throw new Error("No deployable adapter manifests were found");
  }
  const ids = new Set();
  const orders = new Set();
  for (const adapter of adapters) {
    claimUnique(ids, adapter.id, "adapter id");
    claimUnique(orders, adapter.deployOrder, "adapter deployment order");
  }
  return { version: 1, adapters };
}

function validateAdapter(adapter, directoryName) {
  if (!SAFE_ID.test(adapter.id) || adapter.id !== directoryName) {
    throw new Error(`Adapter directory identity does not match id: ${adapter.id}`);
  }
  if (!SAFE_PATH.test(adapter.wranglerConfig)) {
    throw new Error(`Invalid adapter Wrangler path: ${adapter.id}`);
  }
  for (const deployment of [adapter.standalone, adapter.managed].filter(Boolean)) {
    if (!SAFE_PATH.test(deployment.main)) {
      throw new Error(`Invalid adapter Worker path: ${adapter.id}`);
    }
    if (
      !SAFE_NAME.test(deployment.gatewayEntrypoint) ||
      !SAFE_NAME.test(deployment.adapterEntrypoint)
    ) {
      throw new Error(`Invalid adapter entrypoint: ${adapter.id}`);
    }
  }
  if (adapter.devStateDirectories.some((value) => !SAFE_NAME.test(value))) {
    throw new Error(`Invalid adapter development state directories: ${adapter.id}`);
  }
}

function claimUnique(values, value, label) {
  if (values.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
  values.add(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await loadAdapterCatalog(process.argv[2]);
  for (const adapter of catalog.adapters) {
    console.log([
      adapter.id,
      adapter.displayName,
      adapter.component,
      adapter.sourceDir,
      adapter.wranglerConfig,
      adapter.devStateDirectories.join(","),
    ].join("\t"));
  }
}
