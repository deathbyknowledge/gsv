import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultCatalogPath = path.join(scriptRoot, "adapters", "catalog.json");
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const validateAdapterCatalogDocument = new Ajv({ allErrors: true }).compile({
  type: "object",
  additionalProperties: false,
  required: ["version", "adapters"],
  properties: {
    version: { const: 1 },
    adapters: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "displayName",
          "description",
          "component",
          "sourceDir",
          "defaultScript",
          "instanceSuffix",
          "gatewayBinding",
          "entrypoint",
          "wranglerConfig",
          "devStateDirectories",
          "deployOrder",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          displayName: { type: "string", minLength: 1, pattern: "^[^\\t\\r\\n]+$" },
          description: { type: "string", minLength: 1, pattern: "^[^\\t\\r\\n]+$" },
          component: { type: "string", minLength: 1 },
          sourceDir: { type: "string", minLength: 1 },
          defaultScript: { type: "string", minLength: 1 },
          instanceSuffix: { type: "string", minLength: 1 },
          gatewayBinding: { type: "string", minLength: 1 },
          entrypoint: { type: "string", minLength: 1 },
          wranglerConfig: { type: "string", minLength: 1 },
          devStateDirectories: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          deployOrder: { type: "integer", minimum: 1 },
        },
      },
    },
  },
});

export async function loadAdapterCatalog(catalogPath = defaultCatalogPath) {
  const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!validateAdapterCatalogDocument(parsed)) {
    throw new Error(`Adapter catalog is invalid: ${JSON.stringify(validateAdapterCatalogDocument.errors)}`);
  }

  const ids = new Set();
  const components = new Set();
  const bindings = new Set();
  for (const adapter of parsed.adapters) {
    validateAdapter(adapter);
    claimUnique(ids, adapter.id, "adapter id");
    claimUnique(components, adapter.component, "adapter component");
    claimUnique(bindings, adapter.gatewayBinding, "adapter binding");
  }
  return parsed;
}

function validateAdapter(adapter) {
  if (!SAFE_ID.test(adapter.id)) throw new Error(`Invalid adapter id: ${adapter.id}`);
  if (!SAFE_PATH.test(adapter.sourceDir) || !SAFE_PATH.test(adapter.wranglerConfig)) {
    throw new Error(`Invalid adapter source path: ${adapter.id}`);
  }
  if (!SAFE_NAME.test(adapter.entrypoint)) {
    throw new Error(`Invalid adapter entrypoint: ${adapter.id}`);
  }
  if (adapter.component !== `channel-${adapter.id}` || adapter.instanceSuffix !== adapter.component) {
    throw new Error(`Adapter component identity does not match id: ${adapter.id}`);
  }
  const binding = `CHANNEL_${adapter.id.replaceAll("-", "_").toUpperCase()}`;
  if (adapter.gatewayBinding !== binding) {
    throw new Error(`Adapter binding identity does not match id: ${adapter.id}`);
  }
  if (!Number.isSafeInteger(adapter.deployOrder)) {
    throw new Error(`Invalid adapter deployment order: ${adapter.id}`);
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
