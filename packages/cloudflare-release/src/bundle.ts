import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import {
  assertCloudflareWorkerBundleLimits,
  gunzipCloudflareBundle,
  parseCloudflareBundleTar,
  readCloudflareBundleSource,
  type CloudflareBundleArchiveStatistics,
  type CloudflareBundleByteSource,
  type CloudflareWorkerBundleLimits,
  type TarFile,
} from "./archive.js";
import { canonicalJson } from "./canonical.js";
import type {
  CloudflareDurableObjectMigration,
  CloudflareReleaseBindingIntent,
  CloudflareReleaseComponent,
  CloudflareReleaseResourceIntent,
  GsvCloudflareRelease,
} from "./types.js";
import { verifyGsvCloudflareRelease } from "./validate.js";

export type {
  CloudflareBundleArchiveStatistics,
  CloudflareBundleByteSource,
  CloudflareWorkerBundleLimits,
} from "./archive.js";

export type CloudflareWorkerBundleManifest = Readonly<{
  component: string;
  worker: Readonly<{
    entrypoint: string;
    wranglerConfig: string;
  }>;
  assetsDir?: string;
}>;

export type CloudflareWorkerModule = Readonly<{
  name: string;
  contentType: string;
  bytes: Uint8Array;
}>;

export type CloudflareWorkerAsset = Readonly<{
  path: string;
  contentType: string;
  bytes: Uint8Array;
}>;

export type CloudflareWorkerAssetConfig = Readonly<{
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: boolean | readonly string[];
  _headers?: string;
  _redirects?: string;
}>;

export type CloudflarePreparedDurableObjectBinding = Readonly<{
  kind: "durable-object";
  name: string;
  resource: string;
  ownerComponent: string;
  className: string;
}>;

export type CloudflarePreparedR2Binding = Readonly<{
  kind: "r2-bucket";
  name: string;
  resource: string;
  ownerComponent: string;
  jurisdiction?: string;
}>;

export type CloudflarePreparedKvBinding = Readonly<{
  kind: "kv-namespace";
  name: string;
  resource: string;
  ownerComponent: string;
}>;

export type CloudflarePreparedServiceBinding = Readonly<{
  kind: "service";
  name: string;
  targetComponent: string;
  entrypoint?: string;
}>;

export type CloudflarePreparedWorkerLoaderBinding = Readonly<{
  kind: "worker-loader";
  name: string;
}>;

export type CloudflarePreparedWorkersAiBinding = Readonly<{
  kind: "workers-ai";
  name: string;
}>;

export type CloudflarePreparedWorkerBinding =
  | CloudflarePreparedDurableObjectBinding
  | CloudflarePreparedR2Binding
  | CloudflarePreparedKvBinding
  | CloudflarePreparedServiceBinding
  | CloudflarePreparedWorkerLoaderBinding
  | CloudflarePreparedWorkersAiBinding;

export type CloudflareWorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CloudflareWorkerJsonValue[]
  | Readonly<{ [key: string]: CloudflareWorkerJsonValue }>;

export type CloudflareWorkerDeploymentSettings = Readonly<
  Record<string, CloudflareWorkerJsonValue>
>;

export type PreparedCloudflareWorkerBundle = Readonly<{
  componentId: string;
  artifact: Readonly<{
    file: string;
    sha256: string;
    size: number;
  }>;
  manifest: CloudflareWorkerBundleManifest;
  mainModule: string;
  modules: readonly CloudflareWorkerModule[];
  bindings: readonly CloudflarePreparedWorkerBinding[];
  compatibility: Readonly<{
    date: string;
    flags: readonly string[];
  }>;
  durableObjectMigrations: readonly CloudflareDurableObjectMigration[];
  deploymentSettings: CloudflareWorkerDeploymentSettings;
  assets: readonly CloudflareWorkerAsset[];
  assetConfig?: CloudflareWorkerAssetConfig;
  statistics: Readonly<CloudflareBundleArchiveStatistics & {
    retainedBytes: number;
  }>;
}>;

export type PrepareCloudflareWorkerBundleInput = Readonly<{
  release: GsvCloudflareRelease;
  componentId: string;
  artifact: CloudflareBundleByteSource;
  limits: CloudflareWorkerBundleLimits;
  signal?: AbortSignal;
}>;

type BundleConfig = Readonly<{
  name: string;
  compatibility_date: string;
  compatibility_flags?: readonly string[];
  migrations?: readonly WranglerMigration[];
  durable_objects?: Readonly<{
    bindings?: readonly DurableObjectConfigBinding[];
  }>;
  kv_namespaces?: readonly KvConfigBinding[];
  r2_buckets?: readonly R2ConfigBinding[];
  services?: readonly ServiceConfigBinding[];
  worker_loaders?: readonly WorkerLoaderConfigBinding[];
  ai?: AiConfigBinding;
  assets?: AssetsConfig;
} & Record<string, unknown>>;

type WranglerMigration = Readonly<{
  tag: string;
  new_classes?: readonly string[];
  new_sqlite_classes?: readonly string[];
  deleted_classes?: readonly string[];
  renamed_classes?: readonly Readonly<{ from: string; to: string }>[];
}>;

type DurableObjectConfigBinding = Readonly<{
  name: string;
  class_name: string;
  script_name?: string;
  environment?: string;
}>;

type KvConfigBinding = Readonly<{
  binding: string;
  id?: string;
  preview_id?: string;
}>;

type R2ConfigBinding = Readonly<{
  binding: string;
  bucket_name?: string;
  jurisdiction?: string;
}>;

type ServiceConfigBinding = Readonly<{
  binding: string;
  service: string;
  environment?: string;
  entrypoint?: string;
}>;

type WorkerLoaderConfigBinding = Readonly<{
  binding: string;
}>;

type AiConfigBinding = Readonly<{
  binding: string;
  staging?: boolean;
}>;

type AssetsConfig = Readonly<{
  directory?: string;
  binding?: string;
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: boolean | readonly string[];
}>;

const CONFIG_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "build",
  "define",
  "rules",
  "alias",
  "migrations",
  "durable_objects",
  "kv_namespaces",
  "r2_buckets",
  "services",
  "worker_loaders",
  "ai",
  "assets",
  "observability",
  "logpush",
  "tail_consumers",
  "streaming_tail_consumers",
  "limits",
]);

const DEPLOYMENT_SETTING_KEYS = [
  "observability",
  "logpush",
  "tail_consumers",
  "streaming_tail_consumers",
  "limits",
] as const;

const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * Verify and prepare one immutable GSV Worker release artifact. This function
 * owns the supplied stream until it is consumed, cancelled, or fails.
 *
 * The returned binding inventory uses release-level logical resources. Source
 * account IDs, concrete storage names, and concrete service script names are
 * validated as config syntax but deliberately omitted from the result.
 */
export async function prepareCloudflareWorkerBundle(
  input: PrepareCloudflareWorkerBundleInput,
): Promise<PreparedCloudflareWorkerBundle> {
  const limits = Object.freeze({
    maxCompressedBytes: input.limits.maxCompressedBytes,
    maxUncompressedBytes: input.limits.maxUncompressedBytes,
    maxFiles: input.limits.maxFiles,
    maxFileBytes: input.limits.maxFileBytes,
    maxTotalFileBytes: input.limits.maxTotalFileBytes,
  });
  assertCloudflareWorkerBundleLimits(limits);
  const componentId = input.componentId;
  const releaseSnapshot = JSON.parse(canonicalJson(input.release)) as unknown;
  const release = await verifyGsvCloudflareRelease(releaseSnapshot);
  const component = release.components.find(({ id }) => id === componentId);
  if (!component) {
    throw new Error(`Cloudflare release does not contain component ${componentId}`);
  }
  if (component.artifact.size > limits.maxCompressedBytes) {
    throw new Error(`Cloudflare bundle ${component.artifact.file} exceeds the compressed-byte limit`);
  }

  const compressed = await readCloudflareBundleSource(
    input.artifact,
    component.artifact.size,
    limits.maxCompressedBytes,
    input.signal,
  );
  const actualSha256 = await sha256Bytes(compressed);
  if (!constantTimeHexEqual(actualSha256, component.artifact.sha256)) {
    throw new Error(`Cloudflare bundle ${component.artifact.file} digest does not match its release descriptor`);
  }

  const uncompressed = await gunzipCloudflareBundle(
    compressed,
    limits.maxUncompressedBytes,
    input.signal,
  );
  const archive = parseCloudflareBundleTar(uncompressed, limits);
  const files = stripBundleRoot(archive.files, component.bundle.root);
  const manifest = parseBundleManifest(
    readRequiredText(files, component.bundle.manifest),
    component.bundle.manifest,
  );
  assertManifestMatchesComponent(manifest, component);
  const config = parseBundleConfig(
    component.bundle.wranglerConfig,
    readRequiredText(files, component.bundle.wranglerConfig),
  );
  const preparedConfig = prepareConfig(release, component, config);

  const entrypoint = normalizeRelativePath(component.worker.entrypoint, "Worker entrypoint");
  const assetsDirectory = component.worker.assets?.directory;
  assertDistinctBundlePaths(
    component.bundle.manifest,
    component.bundle.wranglerConfig,
    entrypoint,
    assetsDirectory,
  );
  const classified = classifyBundleFiles({
    files,
    manifestPath: component.bundle.manifest,
    configPath: component.bundle.wranglerConfig,
    entrypoint,
    assetsDirectory,
    assetDescriptor: component.worker.assets,
  });
  const retainedBytes = sumBytes(classified.modules) + sumBytes(classified.assets);

  return Object.freeze({
    componentId: component.id,
    artifact: Object.freeze({
      file: component.artifact.file,
      sha256: component.artifact.sha256,
      size: component.artifact.size,
    }),
    manifest,
    mainModule: basename(entrypoint),
    modules: Object.freeze(classified.modules),
    bindings: Object.freeze(preparedConfig.bindings),
    compatibility: Object.freeze({
      date: component.worker.compatibility.date,
      flags: Object.freeze([...component.worker.compatibility.flags]),
    }),
    durableObjectMigrations: Object.freeze(
      component.worker.durableObjectMigrations.steps.map(freezeMigration),
    ),
    deploymentSettings: preparedConfig.deploymentSettings,
    assets: Object.freeze(classified.assets),
    ...(classified.assetConfig === undefined
      ? {}
      : { assetConfig: classified.assetConfig }),
    statistics: Object.freeze({
      compressedBytes: compressed.byteLength,
      uncompressedBytes: uncompressed.byteLength,
      fileCount: archive.statistics.fileCount,
      totalFileBytes: archive.statistics.totalFileBytes,
      retainedBytes,
    }),
  });
}

function prepareConfig(
  release: GsvCloudflareRelease,
  component: CloudflareReleaseComponent,
  config: BundleConfig,
): Readonly<{
  bindings: CloudflarePreparedWorkerBinding[];
  deploymentSettings: CloudflareWorkerDeploymentSettings;
}> {
  if (config.compatibility_date !== component.worker.compatibility.date) {
    throw new Error(`Cloudflare bundle ${component.id} compatibility date does not match its descriptor`);
  }
  const flags = expectStringArray(config.compatibility_flags ?? [], "compatibility_flags");
  if (new Set(flags).size !== flags.length) {
    throw new Error(`Cloudflare bundle ${component.id} contains duplicate compatibility flags`);
  }
  if (canonicalJson([...flags].sort()) !== canonicalJson(component.worker.compatibility.flags)) {
    throw new Error(`Cloudflare bundle ${component.id} compatibility flags do not match its descriptor`);
  }

  const migrations = normalizeMigrations(config.migrations ?? []);
  if (canonicalJson(migrations) !== canonicalJson(component.worker.durableObjectMigrations.steps)) {
    throw new Error(`Cloudflare bundle ${component.id} migrations do not match its descriptor`);
  }

  const bindings = prepareBindings(release, component, config);
  assertAssetsConfig(component, config.assets);
  const deploymentSettings: Record<string, CloudflareWorkerJsonValue> = {};
  for (const key of DEPLOYMENT_SETTING_KEYS) {
    const value = config[key];
    if (value !== undefined) deploymentSettings[key] = canonicalData(value, `Wrangler ${key}`);
  }
  return Object.freeze({
    bindings,
    deploymentSettings: Object.freeze(deploymentSettings),
  });
}

function prepareBindings(
  release: GsvCloudflareRelease,
  component: CloudflareReleaseComponent,
  config: BundleConfig,
): CloudflarePreparedWorkerBinding[] {
  const expected = new Map(component.worker.bindings.map((binding) => [binding.name, binding]));
  const resources = new Map(release.resources.map((resource) => [resource.id, resource]));
  const actual = new Map<string, Readonly<{ kind: string; value: unknown }>>();
  const add = (name: string, kind: string, value: unknown): void => {
    requireBindingName(name, `${kind} binding`);
    if (actual.has(name)) throw new Error(`Cloudflare bundle ${component.id} repeats binding ${name}`);
    actual.set(name, Object.freeze({ kind, value }));
  };

  for (const binding of config.durable_objects?.bindings ?? []) {
    validateDurableObjectBinding(binding);
    add(binding.name, "durable-object", binding);
  }
  for (const binding of config.kv_namespaces ?? []) {
    validateKvBinding(binding);
    add(binding.binding, "kv-namespace", binding);
  }
  for (const binding of config.r2_buckets ?? []) {
    validateR2Binding(binding);
    add(binding.binding, "r2-bucket", binding);
  }
  for (const binding of config.services ?? []) {
    validateServiceBinding(binding);
    add(binding.binding, "service", binding);
  }
  for (const binding of config.worker_loaders ?? []) {
    expectExactKeys(binding, ["binding"], [], "Worker Loader binding");
    add(binding.binding, "worker-loader", binding);
  }
  if (config.ai !== undefined) {
    expectExactKeys(config.ai, ["binding"], ["staging"], "Workers AI binding");
    if (config.ai.staging !== undefined) {
      throw new Error("Cloudflare release descriptors do not support Workers AI staging policy");
    }
    add(config.ai.binding, "workers-ai", config.ai);
  }
  if (config.assets?.binding !== undefined) {
    requireBindingName(config.assets.binding, "assets binding");
    if (actual.has(config.assets.binding)) {
      throw new Error(`Cloudflare bundle ${component.id} repeats binding ${config.assets.binding}`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error(`Cloudflare bundle ${component.id} binding inventory does not match its descriptor`);
  }

  const output: CloudflarePreparedWorkerBinding[] = [];
  for (const descriptor of component.worker.bindings) {
    const found = actual.get(descriptor.name);
    if (!found || found.kind !== descriptor.kind) {
      throw new Error(`Cloudflare bundle ${component.id} binding ${descriptor.name} does not match its descriptor`);
    }
    output.push(prepareBinding(component, descriptor, found.value, resources));
  }
  return output;
}

function prepareBinding(
  component: CloudflareReleaseComponent,
  descriptor: CloudflareReleaseBindingIntent,
  value: unknown,
  resources: ReadonlyMap<string, CloudflareReleaseResourceIntent>,
): CloudflarePreparedWorkerBinding {
  switch (descriptor.kind) {
    case "durable-object": {
      const binding = value as DurableObjectConfigBinding;
      const resource = resources.get(descriptor.resource);
      if (resource?.kind !== "durable-object-namespace" || binding.class_name !== resource.className) {
        throw new Error(`Cloudflare bundle ${component.id} Durable Object ${descriptor.name} has the wrong resource`);
      }
      if (binding.environment !== undefined) {
        throw new Error("Cloudflare release descriptors do not support environment-specific Durable Objects");
      }
      if (
        (resource.ownerComponent === component.id && binding.script_name !== undefined)
        || (resource.ownerComponent !== component.id && binding.script_name === undefined)
      ) {
        throw new Error(`Cloudflare bundle ${component.id} Durable Object ${descriptor.name} has the wrong owner`);
      }
      return Object.freeze({
        kind: descriptor.kind,
        name: descriptor.name,
        resource: descriptor.resource,
        ownerComponent: resource.ownerComponent,
        className: resource.className,
      });
    }
    case "r2-bucket": {
      const binding = value as R2ConfigBinding;
      const resource = resources.get(descriptor.resource);
      if (resource?.kind !== "r2-bucket" || resource.ownerComponent !== component.id) {
        throw new Error(`Cloudflare bundle ${component.id} R2 binding ${descriptor.name} has the wrong resource`);
      }
      return Object.freeze({
        kind: descriptor.kind,
        name: descriptor.name,
        resource: descriptor.resource,
        ownerComponent: resource.ownerComponent,
        ...(binding.jurisdiction === undefined ? {} : { jurisdiction: binding.jurisdiction }),
      });
    }
    case "kv-namespace": {
      const resource = resources.get(descriptor.resource);
      if (resource?.kind !== "kv-namespace" || resource.ownerComponent !== component.id) {
        throw new Error(`Cloudflare bundle ${component.id} KV binding ${descriptor.name} has the wrong resource`);
      }
      return Object.freeze({
        kind: descriptor.kind,
        name: descriptor.name,
        resource: descriptor.resource,
        ownerComponent: resource.ownerComponent,
      });
    }
    case "service": {
      const binding = value as ServiceConfigBinding;
      if (binding.environment !== undefined) {
        throw new Error("Cloudflare release descriptors do not support environment-specific services");
      }
      if (binding.entrypoint !== descriptor.entrypoint) {
        throw new Error(`Cloudflare bundle ${component.id} service ${descriptor.name} has the wrong entrypoint`);
      }
      return Object.freeze({
        kind: descriptor.kind,
        name: descriptor.name,
        targetComponent: descriptor.targetComponent,
        ...(descriptor.entrypoint === undefined ? {} : { entrypoint: descriptor.entrypoint }),
      });
    }
    case "worker-loader":
    case "workers-ai":
      return Object.freeze({ kind: descriptor.kind, name: descriptor.name });
  }
}

function classifyBundleFiles(input: Readonly<{
  files: ReadonlyMap<string, Uint8Array>;
  manifestPath: string;
  configPath: string;
  entrypoint: string;
  assetsDirectory?: string;
  assetDescriptor?: CloudflareReleaseComponent["worker"]["assets"];
}>): Readonly<{
  modules: CloudflareWorkerModule[];
  assets: CloudflareWorkerAsset[];
  assetConfig?: CloudflareWorkerAssetConfig;
}> {
  const claimed = new Set([input.manifestPath, input.configPath]);
  const workerRoot = dirname(input.entrypoint);
  const entrypointBytes = input.files.get(input.entrypoint);
  if (!entrypointBytes || entrypointBytes.byteLength === 0) {
    throw new Error(`Cloudflare bundle is missing non-empty Worker entrypoint ${input.entrypoint}`);
  }
  const mainModule = basename(input.entrypoint);
  const modules: CloudflareWorkerModule[] = [];
  const assets: CloudflareWorkerAsset[] = [];

  for (const [path, bytes] of input.files) {
    if (path === input.manifestPath || path === input.configPath) continue;
    // The manifest's explicit asset inventory owns its subtree. This order is
    // significant when the Worker entrypoint is at the bundle root, where the
    // module root would otherwise contain every file in the bundle.
    if (input.assetsDirectory !== undefined && pathWithin(path, input.assetsDirectory)) {
      claimed.add(path);
      const relative = path.slice(input.assetsDirectory.length + 1);
      if (relative === "_headers" || relative === "_redirects") continue;
      assets.push(Object.freeze({
        path: `/${relative}`,
        contentType: assetContentType(relative),
        bytes,
      }));
      continue;
    }
    if (path === input.entrypoint || pathWithin(path, workerRoot)) {
      const name = path === input.entrypoint
        ? mainModule
        : workerRoot.length === 0
          ? path
          : path.slice(workerRoot.length + 1);
      modules.push(Object.freeze({
        name,
        contentType: path === input.entrypoint
          ? "application/javascript+module"
          : moduleContentType(name),
        bytes,
      }));
      claimed.add(path);
    }
  }
  for (const path of input.files.keys()) {
    if (!claimed.has(path)) {
      throw new Error(`Cloudflare bundle contains unreferenced file ${path}`);
    }
  }
  modules.sort((left, right) => {
    if (left.name === mainModule) return -1;
    if (right.name === mainModule) return 1;
    return left.name.localeCompare(right.name);
  });
  assets.sort((left, right) => left.path.localeCompare(right.path));
  if (modules[0]?.name !== mainModule) {
    throw new Error(`Cloudflare bundle is missing Worker entrypoint ${input.entrypoint}`);
  }

  if (input.assetsDirectory === undefined) {
    if (assets.length !== 0) throw new Error("Cloudflare bundle contains undeclared static assets");
    return Object.freeze({ modules, assets });
  }
  if (assets.length === 0) {
    throw new Error("Cloudflare bundle declares static assets but contains no asset files");
  }
  const assetConfig: CloudflareWorkerAssetConfig = Object.freeze({
    ...(input.assetDescriptor?.htmlHandling === undefined
      ? {}
      : { html_handling: input.assetDescriptor.htmlHandling }),
    ...(input.assetDescriptor?.notFoundHandling === undefined
      ? {}
      : { not_found_handling: input.assetDescriptor.notFoundHandling }),
    ...(input.assetDescriptor?.runWorkerFirst === undefined
      ? {}
      : {
          run_worker_first: Array.isArray(input.assetDescriptor.runWorkerFirst)
            ? Object.freeze([...input.assetDescriptor.runWorkerFirst])
            : input.assetDescriptor.runWorkerFirst,
        }),
    ...readOptionalAssetControls(input.files, input.assetsDirectory),
  });
  return Object.freeze({ modules, assets, assetConfig });
}

function readOptionalAssetControls(
  files: ReadonlyMap<string, Uint8Array>,
  directory: string,
): Readonly<{ _headers?: string; _redirects?: string }> {
  const headers = files.get(`${directory}/_headers`);
  const redirects = files.get(`${directory}/_redirects`);
  return Object.freeze({
    ...(headers === undefined ? {} : { _headers: decodeUtf8(headers, "assets _headers") }),
    ...(redirects === undefined ? {} : { _redirects: decodeUtf8(redirects, "assets _redirects") }),
  });
}

function stripBundleRoot(
  entries: readonly TarFile[],
  rootValue: string,
): Map<string, Uint8Array> {
  const root = normalizeRelativePath(rootValue, "bundle root");
  const prefix = `${root}/`;
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) {
      throw new Error(`Cloudflare bundle contains file outside its ${root} root`);
    }
    const relative = entry.path.slice(prefix.length);
    const path = normalizeRelativePath(relative, "bundle file");
    if (files.has(path)) throw new Error(`Cloudflare bundle repeats file ${path}`);
    files.set(path, entry.bytes);
  }
  if (files.size === 0) throw new Error(`Cloudflare bundle ${root} root contains no files`);
  return files;
}

function parseBundleManifest(text: string, path: string): CloudflareWorkerBundleManifest {
  const value = parseJsonDocument(text, path, false);
  const manifest = expectRecord(value, `bundle manifest ${path}`);
  expectExactKeys(manifest, ["component", "worker"], ["assetsDir"], `bundle manifest ${path}`);
  if (typeof manifest.component !== "string" || manifest.component.length === 0) {
    throw new Error(`Bundle manifest ${path} has no component`);
  }
  const worker = expectRecord(manifest.worker, `bundle manifest ${path} Worker`);
  expectExactKeys(
    worker,
    ["entrypoint", "wranglerConfig"],
    [],
    `bundle manifest ${path} Worker`,
  );
  const entrypoint = normalizeRelativePath(worker.entrypoint, "bundle manifest entrypoint");
  const wranglerConfig = normalizeRelativePath(
    worker.wranglerConfig,
    "bundle manifest Wrangler config",
  );
  const assetsDir = manifest.assetsDir === undefined
    ? undefined
    : normalizeRelativePath(manifest.assetsDir, "bundle manifest assetsDir");
  return Object.freeze({
    component: manifest.component,
    worker: Object.freeze({ entrypoint, wranglerConfig }),
    ...(assetsDir === undefined ? {} : { assetsDir }),
  });
}

function assertManifestMatchesComponent(
  manifest: CloudflareWorkerBundleManifest,
  component: CloudflareReleaseComponent,
): void {
  if (manifest.component !== component.id) {
    throw new Error(`Cloudflare bundle declares component ${manifest.component}, expected ${component.id}`);
  }
  if (manifest.worker.entrypoint !== component.worker.entrypoint) {
    throw new Error(`Cloudflare bundle ${component.id} entrypoint does not match its descriptor`);
  }
  if (manifest.worker.wranglerConfig !== component.bundle.wranglerConfig) {
    throw new Error(`Cloudflare bundle ${component.id} Wrangler config does not match its descriptor`);
  }
  if (manifest.assetsDir !== component.worker.assets?.directory) {
    throw new Error(`Cloudflare bundle ${component.id} assets directory does not match its descriptor`);
  }
}

function parseBundleConfig(path: string, text: string): BundleConfig {
  let parsed: unknown;
  if (path.endsWith(".toml")) {
    try {
      parsed = parseToml(text);
    } catch (error) {
      throw new Error(`Wrangler config ${path} is invalid`, { cause: error });
    }
  } else {
    parsed = parseJsonDocument(text, path, true);
  }
  const config = expectRecord(parsed, `Wrangler config ${path}`);
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Wrangler config ${path} contains unsupported field ${unknown[0]}`);
  }
  requireNonEmptyString(config.name, `Wrangler config ${path} name`);
  requireNonEmptyString(
    config.compatibility_date,
    `Wrangler config ${path} compatibility_date`,
  );
  if (config.compatibility_flags !== undefined) {
    expectStringArray(config.compatibility_flags, "compatibility_flags");
  }
  expectOptionalArray(config.migrations, "Wrangler migrations");
  const durableObjects = config.durable_objects === undefined
    ? undefined
    : expectRecord(config.durable_objects, "Wrangler durable_objects");
  if (durableObjects !== undefined) {
    expectExactKeys(durableObjects, [], ["bindings"], "Wrangler durable_objects");
    expectOptionalArray(durableObjects.bindings, "Durable Object bindings");
  }
  for (const [key, label] of [
    ["kv_namespaces", "KV bindings"],
    ["r2_buckets", "R2 bindings"],
    ["services", "service bindings"],
    ["worker_loaders", "Worker Loader bindings"],
  ] as const) {
    expectOptionalArray(config[key], label);
  }
  if (config.ai !== undefined) expectRecord(config.ai, "Workers AI binding");
  if (config.assets !== undefined) validateAssetsShape(config.assets);
  return config as BundleConfig;
}

function parseJsonDocument(text: string, path: string, jsonc: boolean): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: jsonc,
    disallowComments: !jsonc,
  });
  if (errors.length > 0 || root === undefined) {
    const details = errors.map(({ error }) => printParseErrorCode(error)).join(", ");
    const label = jsonc ? "Wrangler config" : "Bundle manifest";
    throw new Error(`${label} ${path} is invalid${details ? `: ${details}` : ""}`);
  }
  assertUniqueJsonProperties(root, path);
  return getNodeValue(root);
}

function assertUniqueJsonProperties(node: Node, path: string): void {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") throw new Error(`JSON document ${path} has an invalid property`);
      if (names.has(key)) throw new Error(`JSON document ${path} repeats property ${key}`);
      names.add(key);
    }
  }
  for (const child of node.children ?? []) assertUniqueJsonProperties(child, path);
}

function validateDurableObjectBinding(value: DurableObjectConfigBinding): void {
  const binding = expectRecord(value, "Durable Object binding");
  expectExactKeys(
    binding,
    ["name", "class_name"],
    ["script_name", "environment"],
    "Durable Object binding",
  );
  requireBindingName(binding.name, "Durable Object binding");
  if (typeof binding.class_name !== "string" || !CLASS_NAME.test(binding.class_name)) {
    throw new Error("Durable Object binding class_name is invalid");
  }
  requireOptionalNonEmptyString(binding.script_name, "Durable Object script_name");
  requireOptionalNonEmptyString(binding.environment, "Durable Object environment");
}

function validateKvBinding(value: KvConfigBinding): void {
  const binding = expectRecord(value, "KV binding");
  expectExactKeys(binding, ["binding"], ["id", "preview_id"], "KV binding");
  requireBindingName(binding.binding, "KV binding");
  requireOptionalNonEmptyString(binding.id, "KV namespace id");
  requireOptionalNonEmptyString(binding.preview_id, "KV namespace preview_id");
}

function validateR2Binding(value: R2ConfigBinding): void {
  const binding = expectRecord(value, "R2 binding");
  expectExactKeys(binding, ["binding"], ["bucket_name", "jurisdiction"], "R2 binding");
  requireBindingName(binding.binding, "R2 binding");
  requireOptionalNonEmptyString(binding.bucket_name, "R2 bucket_name");
  requireOptionalNonEmptyString(binding.jurisdiction, "R2 jurisdiction");
}

function validateServiceBinding(value: ServiceConfigBinding): void {
  const binding = expectRecord(value, "service binding");
  expectExactKeys(
    binding,
    ["binding", "service"],
    ["environment", "entrypoint"],
    "service binding",
  );
  requireBindingName(binding.binding, "service binding");
  requireNonEmptyString(binding.service, "service target");
  requireOptionalNonEmptyString(binding.environment, "service environment");
  requireOptionalNonEmptyString(binding.entrypoint, "service entrypoint");
}

function validateAssetsShape(value: unknown): void {
  const assets = expectRecord(value, "assets config");
  expectExactKeys(
    assets,
    [],
    ["directory", "binding", "html_handling", "not_found_handling", "run_worker_first"],
    "assets config",
  );
  requireOptionalNonEmptyString(assets.directory, "assets directory");
  if (assets.binding !== undefined) requireBindingName(assets.binding, "assets binding");
  requireOptionalNonEmptyString(assets.html_handling, "assets html_handling");
  requireOptionalNonEmptyString(assets.not_found_handling, "assets not_found_handling");
  if (
    assets.run_worker_first !== undefined
    && typeof assets.run_worker_first !== "boolean"
  ) {
    expectStringArray(assets.run_worker_first, "assets run_worker_first");
  }
}

function assertAssetsConfig(
  component: CloudflareReleaseComponent,
  config: AssetsConfig | undefined,
): void {
  const descriptor = component.worker.assets;
  if (descriptor === undefined) {
    if (config !== undefined) {
      throw new Error(`Cloudflare bundle ${component.id} contains undeclared static asset config`);
    }
    return;
  }
  if (config?.binding !== descriptor.binding) {
    throw new Error(`Cloudflare bundle ${component.id} asset binding does not match its descriptor`);
  }
  const actual = {
    ...(config.html_handling === undefined ? {} : { htmlHandling: config.html_handling }),
    ...(config.not_found_handling === undefined
      ? {}
      : { notFoundHandling: config.not_found_handling }),
    ...(config.run_worker_first === undefined
      ? {}
      : { runWorkerFirst: config.run_worker_first }),
  };
  const expected = {
    ...(descriptor.htmlHandling === undefined ? {} : { htmlHandling: descriptor.htmlHandling }),
    ...(descriptor.notFoundHandling === undefined
      ? {}
      : { notFoundHandling: descriptor.notFoundHandling }),
    ...(descriptor.runWorkerFirst === undefined
      ? {}
      : { runWorkerFirst: descriptor.runWorkerFirst }),
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`Cloudflare bundle ${component.id} asset config does not match its descriptor`);
  }
}

function normalizeMigrations(
  migrations: readonly WranglerMigration[],
): CloudflareDurableObjectMigration[] {
  return migrations.map((raw, index) => {
    const migration = expectRecord(raw, `Wrangler migration ${index}`);
    expectExactKeys(
      migration,
      ["tag"],
      ["new_classes", "new_sqlite_classes", "deleted_classes", "renamed_classes"],
      `Wrangler migration ${index}`,
    );
    requireNonEmptyString(migration.tag, `Wrangler migration ${index} tag`);
    const newClasses = normalizeClassList(migration.new_classes, "new_classes");
    const newSqliteClasses = normalizeClassList(
      migration.new_sqlite_classes,
      "new_sqlite_classes",
    );
    const deletedClasses = normalizeClassList(migration.deleted_classes, "deleted_classes");
    const renamedClasses = normalizeRenames(migration.renamed_classes);
    return Object.freeze({
      tag: migration.tag,
      ...(newClasses === undefined ? {} : { newClasses }),
      ...(newSqliteClasses === undefined ? {} : { newSqliteClasses }),
      ...(deletedClasses === undefined ? {} : { deletedClasses }),
      ...(renamedClasses === undefined ? {} : { renamedClasses }),
    });
  });
}

function normalizeClassList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const classes = expectStringArray(value, `Wrangler migration ${label}`);
  if (classes.length === 0) throw new Error(`Wrangler migration ${label} must not be empty`);
  for (const className of classes) {
    if (!CLASS_NAME.test(className)) throw new Error(`Wrangler migration ${label} class is invalid`);
  }
  if (new Set(classes).size !== classes.length) {
    throw new Error(`Wrangler migration ${label} repeats a class`);
  }
  return Object.freeze([...classes].sort());
}

function normalizeRenames(
  value: unknown,
): readonly Readonly<{ from: string; to: string }>[] | undefined {
  if (value === undefined) return undefined;
  const values = expectArray(value, "Wrangler migration renamed_classes");
  if (values.length === 0) throw new Error("Wrangler migration renamed_classes must not be empty");
  const renames = values.map((raw) => {
    const rename = expectRecord(raw, "Wrangler migration class rename");
    expectExactKeys(rename, ["from", "to"], [], "Wrangler migration class rename");
    if (
      typeof rename.from !== "string"
      || !CLASS_NAME.test(rename.from)
      || typeof rename.to !== "string"
      || !CLASS_NAME.test(rename.to)
    ) {
      throw new Error("Wrangler migration class rename is invalid");
    }
    return Object.freeze({ from: rename.from, to: rename.to });
  });
  renames.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  if (new Set(renames.map(({ from, to }) => `${from}\u0000${to}`)).size !== renames.length) {
    throw new Error("Wrangler migration renamed_classes repeats a rename");
  }
  return Object.freeze(renames);
}

function assertDistinctBundlePaths(
  manifestPath: string,
  configPath: string,
  entrypoint: string,
  assetsDirectory: string | undefined,
): void {
  const paths = [manifestPath, configPath, entrypoint];
  if (new Set(paths).size !== paths.length) {
    throw new Error("Cloudflare bundle control files and Worker entrypoint must be distinct");
  }
  if (assetsDirectory === undefined) return;
  const workerRoot = dirname(entrypoint);
  if (
    pathWithin(manifestPath, assetsDirectory)
    || pathWithin(configPath, assetsDirectory)
    || pathWithin(entrypoint, assetsDirectory)
    || (workerRoot.length > 0 && pathWithin(assetsDirectory, workerRoot))
  ) {
    throw new Error("Cloudflare bundle Worker, control, and static asset paths overlap");
  }
}

function freezeMigration(
  migration: CloudflareDurableObjectMigration,
): CloudflareDurableObjectMigration {
  return Object.freeze({
    tag: migration.tag,
    ...(migration.newClasses === undefined
      ? {}
      : { newClasses: Object.freeze([...migration.newClasses]) }),
    ...(migration.newSqliteClasses === undefined
      ? {}
      : { newSqliteClasses: Object.freeze([...migration.newSqliteClasses]) }),
    ...(migration.deletedClasses === undefined
      ? {}
      : { deletedClasses: Object.freeze([...migration.deletedClasses]) }),
    ...(migration.renamedClasses === undefined
      ? {}
      : {
          renamedClasses: Object.freeze(
            migration.renamedClasses.map(({ from, to }) => Object.freeze({ from, to })),
          ),
        }),
  });
}

function canonicalData(value: unknown, label: string): CloudflareWorkerJsonValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => canonicalData(item, label)));
  }
  if (isRecord(value)) {
    const output: Record<string, CloudflareWorkerJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: canonicalData(value[key], label),
        writable: false,
      });
    }
    return Object.freeze(output);
  }
  throw new Error(`${label} contains unsupported ${typeof value} data`);
}

function sumBytes(
  files: readonly Readonly<{ bytes: Uint8Array }>[],
): number {
  return files.reduce((total, file) => total + file.bytes.byteLength, 0);
}

function readRequiredText(files: ReadonlyMap<string, Uint8Array>, pathValue: string): string {
  const path = normalizeRelativePath(pathValue, "bundle file path");
  const bytes = files.get(path);
  if (!bytes) throw new Error(`Cloudflare bundle is missing ${path}`);
  return decodeUtf8(bytes, path);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    throw new Error(`Cloudflare bundle file ${label} is not valid UTF-8`, { cause: error });
  }
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || value.includes("\\")
    || CONTROL_CHARACTER.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function pathWithin(path: string, directory: string): boolean {
  if (directory.length === 0) return true;
  return path.startsWith(`${directory}/`);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function moduleContentType(path: string): string {
  const extension = fileExtension(path);
  if (extension === "wasm") return "application/wasm";
  if (extension === "js" || extension === "mjs") return "application/javascript+module";
  if (extension === "cjs") return "application/javascript";
  if (extension === "map") return "application/source-map";
  if (["txt", "html", "sql", "md"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

function assetContentType(path: string): string {
  const extension = fileExtension(path);
  return ({
    css: "text/css; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
  } as Readonly<Record<string, string>>)[extension] ?? "application/octet-stream";
}

function fileExtension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectOptionalArray(value: unknown, label: string): void {
  if (value !== undefined && !Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function expectStringArray(value: unknown, label: string): string[] {
  const values = expectArray(value, label);
  if (values.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must contain only strings`);
  }
  return values as string[];
}

function expectExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported field ${unknown[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} is missing field ${missing[0]}`);
}

function requireBindingName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !BINDING_NAME.test(value)) {
    throw new Error(`${label} name is invalid`);
  }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) requireNonEmptyString(value, label);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
