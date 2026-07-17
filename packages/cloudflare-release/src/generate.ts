import { sha256Hex } from "./canonical.js";
import {
  GSV_CLOUDFLARE_RELEASE_FORMAT,
  GSV_CLOUDFLARE_RELEASE_SCHEMA_URL,
  GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION,
  GSV_CLOUDFLARE_RUNTIME_PROTOCOL_VERSION,
  type CloudflareDurableObjectMigration,
  type CloudflareReleaseAssets,
  type CloudflareReleaseBindingIntent,
  type CloudflareReleaseComponent,
  type CloudflareReleaseResourceIntent,
  type GsvCloudflareRelease,
} from "./types.js";
import { assertGsvCloudflareRelease } from "./validate.js";

export type WranglerReleaseMigration = Readonly<{
  tag: string;
  new_classes?: readonly string[];
  new_sqlite_classes?: readonly string[];
  deleted_classes?: readonly string[];
  renamed_classes?: readonly Readonly<{ from: string; to: string }>[];
}>;

export type WranglerReleaseConfig = Readonly<{
  name: string;
  compatibility_date: string;
  compatibility_flags?: readonly string[];
  migrations?: readonly WranglerReleaseMigration[];
  durable_objects?: Readonly<{
    bindings?: readonly Readonly<{
      name: string;
      class_name: string;
      script_name?: string;
      environment?: string;
    }>[];
  }>;
  kv_namespaces?: readonly Readonly<{
    binding: string;
    id?: string;
    preview_id?: string;
  }>[];
  r2_buckets?: readonly Readonly<{
    binding: string;
    bucket_name?: string;
    jurisdiction?: string;
  }>[];
  services?: readonly Readonly<{
    binding: string;
    service: string;
    entrypoint?: string;
    environment?: string;
  }>[];
  worker_loaders?: readonly Readonly<{ binding: string }>[];
  ai?: Readonly<{ binding: string; staging?: boolean }>;
  assets?: Readonly<{
    binding?: string;
    html_handling?: string;
    not_found_handling?: string;
    run_worker_first?: boolean | readonly string[];
  }>;
}>;

export type CloudflareReleaseBuildComponent = Readonly<{
  id: string;
  bundleRoot: string;
  bundleManifest: string;
  wranglerConfig: string;
  entrypoint: string;
  assetsDirectory?: string;
  required: boolean;
  deployOrder: number;
  dependsOn: readonly string[];
  artifact: Readonly<{
    file: string;
    sha256: string;
    size: number;
  }>;
  config: WranglerReleaseConfig;
}>;

export type CreateCloudflareReleaseInput = Readonly<{
  releaseVersion: string;
  sourceCommitSha: string;
  managedObjectDescriptorSchemaVersion: number;
  dataFrameStreamVersion: number;
  portableArchiveFormatVersion: number;
  portableFeatures: readonly string[];
  components: readonly CloudflareReleaseBuildComponent[];
}>;

/**
 * Build the public release contract from already-bundled artifacts. Concrete
 * provider resource names and IDs in Wrangler configs are deliberately reduced
 * to stable logical intents.
 */
export async function createGsvCloudflareRelease(
  input: CreateCloudflareReleaseInput,
): Promise<GsvCloudflareRelease> {
  const deploymentNameToComponent = new Map<string, string>();
  for (const component of input.components) {
    if (deploymentNameToComponent.has(component.config.name)) {
      throw new TypeError(`Duplicate Worker deployment name ${component.config.name}`);
    }
    deploymentNameToComponent.set(component.config.name, component.id);
  }

  const resources: CloudflareReleaseResourceIntent[] = [];
  const resourceByComponentAndClass = new Map<string, string>();
  for (const component of input.components) {
    for (const binding of component.config.durable_objects?.bindings ?? []) {
      if (binding.environment !== undefined) {
        throw new TypeError("Release contracts do not support environment-specific Durable Object bindings");
      }
      if (binding.script_name !== undefined) continue;
      const resource = resourceId(component.id, "do", binding.name);
      resources.push({
        id: resource,
        kind: "durable-object-namespace",
        ownerComponent: component.id,
        className: binding.class_name,
        lifecycle: "persistent",
      });
      const key = `${component.id}\u0000${binding.class_name}`;
      if (resourceByComponentAndClass.has(key)) {
        throw new TypeError(
          `Component ${component.id} binds Durable Object class ${binding.class_name} more than once`,
        );
      }
      resourceByComponentAndClass.set(key, resource);
    }
    for (const binding of component.config.r2_buckets ?? []) {
      resources.push({
        id: resourceId(component.id, "r2", binding.binding),
        kind: "r2-bucket",
        ownerComponent: component.id,
        lifecycle: "persistent",
      });
    }
    for (const binding of component.config.kv_namespaces ?? []) {
      resources.push({
        id: resourceId(component.id, "kv", binding.binding),
        kind: "kv-namespace",
        ownerComponent: component.id,
        lifecycle: "persistent",
      });
    }
  }
  resources.sort((left, right) => left.id.localeCompare(right.id));

  const components: CloudflareReleaseComponent[] = [];
  for (const component of input.components) {
    const migrations = normalizeMigrations(component.config.migrations ?? []);
    const bindings: CloudflareReleaseBindingIntent[] = [];

    for (const binding of component.config.durable_objects?.bindings ?? []) {
      let resource: string;
      if (binding.script_name === undefined) {
        resource = resourceId(component.id, "do", binding.name);
      } else {
        const targetComponent = deploymentNameToComponent.get(binding.script_name);
        if (!targetComponent) {
          throw new TypeError(
            `Durable Object binding ${component.id}.${binding.name} targets an unknown component`,
          );
        }
        const target = resourceByComponentAndClass.get(`${targetComponent}\u0000${binding.class_name}`);
        if (!target) {
          throw new TypeError(
            `Durable Object binding ${component.id}.${binding.name} targets an unknown class`,
          );
        }
        resource = target;
      }
      bindings.push({ kind: "durable-object", name: binding.name, resource });
    }
    for (const binding of component.config.r2_buckets ?? []) {
      bindings.push({
        kind: "r2-bucket",
        name: binding.binding,
        resource: resourceId(component.id, "r2", binding.binding),
      });
    }
    for (const binding of component.config.kv_namespaces ?? []) {
      bindings.push({
        kind: "kv-namespace",
        name: binding.binding,
        resource: resourceId(component.id, "kv", binding.binding),
      });
    }
    for (const binding of component.config.services ?? []) {
      if (binding.environment !== undefined) {
        throw new TypeError("Release contracts do not support environment-specific service bindings");
      }
      const targetComponent = deploymentNameToComponent.get(binding.service);
      if (!targetComponent) {
        throw new TypeError(`Service binding ${component.id}.${binding.binding} has an unknown target`);
      }
      bindings.push({
        kind: "service",
        name: binding.binding,
        targetComponent,
        ...(binding.entrypoint === undefined ? {} : { entrypoint: binding.entrypoint }),
      });
    }
    for (const binding of component.config.worker_loaders ?? []) {
      bindings.push({ kind: "worker-loader", name: binding.binding });
    }
    if (component.config.ai) {
      if (component.config.ai.staging !== undefined) {
        throw new TypeError("Release contracts do not support staging-specific Workers AI bindings");
      }
      bindings.push({ kind: "workers-ai", name: component.config.ai.binding });
    }
    bindings.sort((left, right) => left.name.localeCompare(right.name));

    components.push({
      id: component.id,
      kind: "worker",
      required: component.required,
      deployOrder: component.deployOrder,
      dependsOn: [...component.dependsOn].sort(),
      artifact: {
        file: component.artifact.file,
        mediaType: "application/gzip",
        sha256: component.artifact.sha256,
        size: component.artifact.size,
      },
      bundle: {
        root: component.bundleRoot,
        manifest: component.bundleManifest,
        wranglerConfig: component.wranglerConfig,
      },
      worker: {
        entrypoint: component.entrypoint,
        compatibility: {
          date: component.config.compatibility_date,
          flags: [...(component.config.compatibility_flags ?? [])].sort(),
        },
        bindings,
        durableObjectMigrations: {
          sha256: await sha256Hex(migrations),
          steps: migrations,
        },
        ...assets(component),
      },
    });
  }
  components.sort((left, right) => left.deployOrder - right.deployOrder || left.id.localeCompare(right.id));

  const descriptor: GsvCloudflareRelease = {
    $schema: GSV_CLOUDFLARE_RELEASE_SCHEMA_URL,
    format: GSV_CLOUDFLARE_RELEASE_FORMAT,
    schemaVersion: GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION,
    releaseVersion: input.releaseVersion,
    source: {
      commitSha: input.sourceCommitSha,
    },
    runtime: {
      protocolVersion: GSV_CLOUDFLARE_RUNTIME_PROTOCOL_VERSION,
      managedObjectDescriptorSchemaVersion: input.managedObjectDescriptorSchemaVersion,
      dataFrameStreamVersion: input.dataFrameStreamVersion,
    },
    portable: {
      archiveFormat: "gsv-portable-archive",
      archiveFormatVersion: input.portableArchiveFormatVersion,
      features: [...input.portableFeatures].sort(),
    },
    resources,
    components,
  };
  assertGsvCloudflareRelease(descriptor);
  return descriptor;
}

function normalizeMigrations(
  migrations: readonly WranglerReleaseMigration[],
): CloudflareDurableObjectMigration[] {
  return migrations.map((migration) => ({
    tag: migration.tag,
    ...(migration.new_classes === undefined
      ? {}
      : { newClasses: [...migration.new_classes].sort() }),
    ...(migration.new_sqlite_classes === undefined
      ? {}
      : { newSqliteClasses: [...migration.new_sqlite_classes].sort() }),
    ...(migration.deleted_classes === undefined
      ? {}
      : { deletedClasses: [...migration.deleted_classes].sort() }),
    ...(migration.renamed_classes === undefined
      ? {}
      : {
          renamedClasses: migration.renamed_classes
            .map(({ from, to }) => ({ from, to }))
            .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
        }),
  }));
}

function assets(component: CloudflareReleaseBuildComponent): { assets?: CloudflareReleaseAssets } {
  if (component.assetsDirectory === undefined) {
    if (component.config.assets !== undefined) {
      throw new TypeError(`Component ${component.id} configures assets without a bundled asset directory`);
    }
    return {};
  }
  const config = component.config.assets;
  if (!config?.binding) {
    throw new TypeError(`Component ${component.id} bundles assets without an assets binding`);
  }
  return {
    assets: {
      directory: component.assetsDirectory,
      binding: config.binding,
      ...(config.html_handling === undefined ? {} : { htmlHandling: config.html_handling }),
      ...(config.not_found_handling === undefined
        ? {}
        : { notFoundHandling: config.not_found_handling }),
      ...(config.run_worker_first === undefined
        ? {}
        : { runWorkerFirst: config.run_worker_first }),
    },
  };
}

function resourceId(component: string, kind: "do" | "r2" | "kv", binding: string): string {
  return `${component}.${kind}.${binding.toLowerCase()}`;
}
