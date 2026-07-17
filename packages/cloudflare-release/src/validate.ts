import { sha256Hex } from "./canonical.js";
import {
  GSV_CLOUDFLARE_RELEASE_FORMAT,
  GSV_CLOUDFLARE_RELEASE_SCHEMA_URL,
  GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION,
  type CloudflareDurableObjectMigration,
  type CloudflareReleaseBindingIntent,
  type CloudflareReleaseComponent,
  type CloudflareReleaseResourceIntent,
  type GsvCloudflareRelease,
} from "./types.js";

const RELEASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const COMPONENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LOGICAL_RESOURCE_ID = /^[a-z][a-z0-9._-]{0,191}$/;
const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const COMPATIBILITY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function assertGsvCloudflareRelease(
  value: unknown,
): asserts value is GsvCloudflareRelease {
  const release = expectRecord(value, "release descriptor");
  expectExactKeys(
    release,
    [
      "$schema",
      "format",
      "schemaVersion",
      "releaseVersion",
      "source",
      "runtime",
      "portable",
      "resources",
      "components",
    ],
    [],
    "release descriptor",
  );
  if (release.$schema !== GSV_CLOUDFLARE_RELEASE_SCHEMA_URL) {
    fail("release descriptor has an unknown JSON Schema URL");
  }
  if (
    release.format !== GSV_CLOUDFLARE_RELEASE_FORMAT
    || release.schemaVersion !== GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION
  ) {
    fail("release descriptor has an unsupported format version");
  }
  expectPattern(release.releaseVersion, RELEASE_VERSION, "releaseVersion");
  validateSource(release.source);
  validateRuntime(release.runtime);
  validatePortable(release.portable);

  const resources = expectArray(release.resources, "resources").map(validateResource);
  assertSortedUnique(resources.map((resource) => resource.id), "resources");
  const components = expectArray(release.components, "components").map(validateComponent);
  if (components.length === 0) fail("components must not be empty");
  for (let index = 1; index < components.length; index += 1) {
    if (components[index - 1]!.deployOrder >= components[index]!.deployOrder) {
      fail("components must be sorted by unique deployOrder");
    }
  }

  const componentById = uniqueMap(components, (component) => component.id, "component IDs");
  uniqueMap(components, (component) => component.artifact.file, "artifact files");
  uniqueMap(components, (component) => component.bundle.root, "bundle roots");
  const resourceById = uniqueMap(resources, (resource) => resource.id, "resource IDs");
  const referencedResources = new Set<string>();

  for (const resource of resources) {
    if (!componentById.has(resource.ownerComponent)) {
      fail(`resource ${resource.id} has an unknown owner component`);
    }
  }
  for (const component of components) {
    for (const dependency of component.dependsOn) {
      const target = componentById.get(dependency);
      if (!target) fail(`component ${component.id} has an unknown dependency`);
      if (target.deployOrder >= component.deployOrder) {
        fail(`component ${component.id} dependency must deploy first`);
      }
      if (component.required && !target.required) {
        fail(`required component ${component.id} cannot depend on an optional component`);
      }
    }
    for (const binding of component.worker.bindings) {
      validateBindingReference(binding, component, componentById, resourceById, referencedResources);
    }
  }
  for (const resource of resources) {
    if (!referencedResources.has(resource.id)) {
      fail(`resource ${resource.id} is not referenced by a binding`);
    }
  }
}

function validateSource(value: unknown): void {
  const source = expectRecord(value, "source");
  expectExactKeys(source, ["commitSha"], [], "source");
  expectPattern(source.commitSha, COMMIT_SHA, "source commitSha");
}

/** Validate structure and recompute every inline Durable Object migration digest. */
export async function verifyGsvCloudflareRelease(value: unknown): Promise<GsvCloudflareRelease> {
  assertGsvCloudflareRelease(value);
  for (const component of value.components) {
    const actual = await sha256Hex(component.worker.durableObjectMigrations.steps);
    if (actual !== component.worker.durableObjectMigrations.sha256) {
      fail(`component ${component.id} Durable Object migration digest does not match its steps`);
    }
  }
  return value;
}

function validateRuntime(value: unknown): void {
  const runtime = expectRecord(value, "runtime");
  expectExactKeys(
    runtime,
    ["protocolVersion", "managedObjectDescriptorSchemaVersion", "dataFrameStreamVersion"],
    [],
    "runtime",
  );
  expectPositiveInteger(runtime.protocolVersion, "runtime protocolVersion");
  expectPositiveInteger(
    runtime.managedObjectDescriptorSchemaVersion,
    "runtime managedObjectDescriptorSchemaVersion",
  );
  expectPositiveInteger(runtime.dataFrameStreamVersion, "runtime dataFrameStreamVersion");
}

function validatePortable(value: unknown): void {
  const portable = expectRecord(value, "portable");
  expectExactKeys(
    portable,
    ["archiveFormat", "archiveFormatVersion", "features"],
    [],
    "portable",
  );
  if (portable.archiveFormat !== "gsv-portable-archive") {
    fail("portable archiveFormat is invalid");
  }
  expectPositiveInteger(portable.archiveFormatVersion, "portable archiveFormatVersion");
  const features = expectStringArray(portable.features, "portable features");
  features.forEach((feature) => expectPattern(feature, FEATURE, "portable feature"));
  assertSortedUnique(features, "portable features");
}

function validateResource(value: unknown): CloudflareReleaseResourceIntent {
  const resource = expectRecord(value, "resource");
  if (resource.kind === "durable-object-namespace") {
    expectExactKeys(
      resource,
      ["id", "kind", "ownerComponent", "className", "lifecycle"],
      [],
      "Durable Object resource",
    );
    expectPattern(resource.className, CLASS_NAME, "Durable Object className");
  } else if (resource.kind === "r2-bucket" || resource.kind === "kv-namespace") {
    expectExactKeys(
      resource,
      ["id", "kind", "ownerComponent", "lifecycle"],
      [],
      `${resource.kind} resource`,
    );
  } else {
    fail("resource has an unknown kind");
  }
  expectPattern(resource.id, LOGICAL_RESOURCE_ID, "resource id");
  expectPattern(resource.ownerComponent, COMPONENT_ID, "resource ownerComponent");
  if (resource.lifecycle !== "persistent") fail("resource lifecycle must be persistent");
  return resource as CloudflareReleaseResourceIntent;
}

function validateComponent(value: unknown): CloudflareReleaseComponent {
  const component = expectRecord(value, "component");
  expectExactKeys(
    component,
    [
      "id",
      "kind",
      "required",
      "deployOrder",
      "dependsOn",
      "artifact",
      "bundle",
      "worker",
    ],
    [],
    "component",
  );
  expectPattern(component.id, COMPONENT_ID, "component id");
  if (component.kind !== "worker") fail("component kind must be worker");
  if (typeof component.required !== "boolean") fail("component required must be boolean");
  expectNonNegativeInteger(component.deployOrder, "component deployOrder");
  const dependencies = expectStringArray(component.dependsOn, "component dependsOn");
  dependencies.forEach((dependency) => expectPattern(dependency, COMPONENT_ID, "dependency"));
  assertSortedUnique(dependencies, "component dependencies");
  if (dependencies.includes(component.id as string)) fail("component cannot depend on itself");
  validateArtifact(component.artifact);
  validateBundle(component.bundle);
  validateWorker(component.worker);
  return component as unknown as CloudflareReleaseComponent;
}

function validateArtifact(value: unknown): void {
  const artifact = expectRecord(value, "artifact");
  expectExactKeys(artifact, ["file", "mediaType", "sha256", "size"], [], "artifact");
  expectFileName(artifact.file, "artifact file");
  if (artifact.mediaType !== "application/gzip") fail("artifact mediaType must be application/gzip");
  expectPattern(artifact.sha256, SHA256, "artifact sha256");
  expectPositiveInteger(artifact.size, "artifact size");
}

function validateBundle(value: unknown): void {
  const bundle = expectRecord(value, "bundle");
  expectExactKeys(bundle, ["root", "manifest", "wranglerConfig"], [], "bundle");
  expectPath(bundle.root, "bundle root");
  expectPath(bundle.manifest, "bundle manifest");
  expectPath(bundle.wranglerConfig, "bundle wranglerConfig");
}

function validateWorker(value: unknown): void {
  const worker = expectRecord(value, "worker");
  expectExactKeys(
    worker,
    ["entrypoint", "compatibility", "bindings", "durableObjectMigrations"],
    ["assets"],
    "worker",
  );
  expectPath(worker.entrypoint, "worker entrypoint");
  validateCompatibility(worker.compatibility);
  const bindings = expectArray(worker.bindings, "worker bindings").map(validateBinding);
  assertSortedUnique(bindings.map((binding) => binding.name), "worker binding names");
  validateMigrations(worker.durableObjectMigrations);
  if (worker.assets !== undefined) validateAssets(worker.assets);
}

function validateCompatibility(value: unknown): void {
  const compatibility = expectRecord(value, "compatibility");
  expectExactKeys(compatibility, ["date", "flags"], [], "compatibility");
  expectPattern(compatibility.date, COMPATIBILITY_DATE, "compatibility date");
  const date = new Date(`${compatibility.date as string}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== compatibility.date) {
    fail("compatibility date is not a calendar date");
  }
  const flags = expectStringArray(compatibility.flags, "compatibility flags");
  flags.forEach((flag) => expectIdentifier(flag, "compatibility flag", 128));
  assertSortedUnique(flags, "compatibility flags");
}

function validateBinding(value: unknown): CloudflareReleaseBindingIntent {
  const binding = expectRecord(value, "binding");
  if (
    binding.kind === "durable-object"
    || binding.kind === "r2-bucket"
    || binding.kind === "kv-namespace"
  ) {
    expectExactKeys(binding, ["kind", "name", "resource"], [], `${binding.kind} binding`);
    expectPattern(binding.resource, LOGICAL_RESOURCE_ID, "binding resource");
  } else if (binding.kind === "service") {
    expectExactKeys(
      binding,
      ["kind", "name", "targetComponent"],
      ["entrypoint"],
      "service binding",
    );
    expectPattern(binding.targetComponent, COMPONENT_ID, "service targetComponent");
    if (binding.entrypoint !== undefined) {
      expectIdentifier(binding.entrypoint, "service entrypoint", 128);
    }
  } else if (binding.kind === "worker-loader" || binding.kind === "workers-ai") {
    expectExactKeys(binding, ["kind", "name"], [], `${binding.kind} binding`);
  } else {
    fail("binding has an unknown kind");
  }
  expectPattern(binding.name, BINDING_NAME, "binding name");
  return binding as unknown as CloudflareReleaseBindingIntent;
}

function validateMigrations(value: unknown): void {
  const migrations = expectRecord(value, "Durable Object migrations");
  expectExactKeys(migrations, ["sha256", "steps"], [], "Durable Object migrations");
  expectPattern(migrations.sha256, SHA256, "Durable Object migration sha256");
  const steps = expectArray(migrations.steps, "Durable Object migration steps").map(
    validateMigration,
  );
  const tags = steps.map((step) => step.tag);
  if (new Set(tags).size !== tags.length) fail("Durable Object migration tags must be unique");
}

function validateMigration(value: unknown): CloudflareDurableObjectMigration {
  const migration = expectRecord(value, "Durable Object migration");
  expectExactKeys(
    migration,
    ["tag"],
    ["newClasses", "newSqliteClasses", "deletedClasses", "renamedClasses"],
    "Durable Object migration",
  );
  expectIdentifier(migration.tag, "Durable Object migration tag", 128);
  let operations = 0;
  for (const key of ["newClasses", "newSqliteClasses", "deletedClasses"] as const) {
    if (migration[key] === undefined) continue;
    const classes = expectStringArray(migration[key], `Durable Object migration ${key}`);
    if (classes.length === 0) fail(`Durable Object migration ${key} must not be empty`);
    classes.forEach((className) => expectPattern(className, CLASS_NAME, `${key} class`));
    assertSortedUnique(classes, `Durable Object migration ${key}`);
    operations += classes.length;
  }
  if (migration.renamedClasses !== undefined) {
    const renames = expectArray(migration.renamedClasses, "renamedClasses");
    if (renames.length === 0) fail("Durable Object migration renamedClasses must not be empty");
    const renameKeys: string[] = [];
    for (const value of renames) {
      const rename = expectRecord(value, "Durable Object class rename");
      expectExactKeys(rename, ["from", "to"], [], "Durable Object class rename");
      expectPattern(rename.from, CLASS_NAME, "renamed class from");
      expectPattern(rename.to, CLASS_NAME, "renamed class to");
      renameKeys.push(`${rename.from as string}\u0000${rename.to as string}`);
    }
    assertSortedUnique(renameKeys, "Durable Object class renames");
    operations += renames.length;
  }
  if (operations === 0) fail("Durable Object migration must contain an operation");
  return migration as CloudflareDurableObjectMigration;
}

function validateAssets(value: unknown): void {
  const assets = expectRecord(value, "assets");
  expectExactKeys(
    assets,
    ["directory", "binding"],
    ["htmlHandling", "notFoundHandling", "runWorkerFirst"],
    "assets",
  );
  expectPath(assets.directory, "assets directory");
  expectPattern(assets.binding, BINDING_NAME, "assets binding");
  if (assets.htmlHandling !== undefined) {
    expectIdentifier(assets.htmlHandling, "assets htmlHandling", 128);
  }
  if (assets.notFoundHandling !== undefined) {
    expectIdentifier(assets.notFoundHandling, "assets notFoundHandling", 128);
  }
  if (assets.runWorkerFirst !== undefined && typeof assets.runWorkerFirst !== "boolean") {
    const paths = expectStringArray(assets.runWorkerFirst, "assets runWorkerFirst");
    if (paths.length === 0) fail("assets runWorkerFirst paths must not be empty");
    for (const path of paths) {
      if (!path.startsWith("/") || CONTROL_CHARACTER.test(path) || path.length > 512) {
        fail("assets runWorkerFirst contains an invalid route");
      }
    }
    if (new Set(paths).size !== paths.length) fail("assets runWorkerFirst routes must be unique");
  }
}

function validateBindingReference(
  binding: CloudflareReleaseBindingIntent,
  component: CloudflareReleaseComponent,
  componentById: Map<string, CloudflareReleaseComponent>,
  resourceById: Map<string, CloudflareReleaseResourceIntent>,
  referencedResources: Set<string>,
): void {
  if (binding.kind === "service") {
    if (!componentById.has(binding.targetComponent)) {
      fail(`service binding ${component.id}.${binding.name} has an unknown target component`);
    }
    return;
  }
  if (binding.kind === "worker-loader" || binding.kind === "workers-ai") return;
  const resource = resourceById.get(binding.resource);
  if (!resource) fail(`binding ${component.id}.${binding.name} has an unknown resource`);
  const expectedKind = binding.kind === "durable-object"
    ? "durable-object-namespace"
    : binding.kind;
  if (resource.kind !== expectedKind) {
    fail(`binding ${component.id}.${binding.name} has a mismatched resource kind`);
  }
  referencedResources.add(resource.id);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  const array = expectArray(value, label);
  if (array.some((item) => typeof item !== "string")) fail(`${label} must contain strings`);
  return array as string[];
}

function expectExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const expected = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) fail(`${label} contains unknown field ${unknown[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing field ${missing[0]}`);
}

function expectPattern(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
}

function expectIdentifier(value: unknown, label: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
  ) {
    fail(`${label} is invalid`);
  }
}

function expectPath(value: unknown, label: string): asserts value is string {
  expectIdentifier(value, label, 512);
  if (
    value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a safe relative path`);
  }
}

function expectFileName(value: unknown, label: string): asserts value is string {
  expectPath(value, label);
  if (value.includes("/")) fail(`${label} must be a filename`);
}

function expectPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
}

function expectNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative integer`);
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) fail(`${label} must be sorted and unique`);
  }
}

function uniqueMap<T>(values: readonly T[], key: (value: T) => string, label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (map.has(id)) fail(`${label} must be unique`);
    map.set(id, value);
  }
  return map;
}

function fail(message: string): never {
  throw new TypeError(message);
}
