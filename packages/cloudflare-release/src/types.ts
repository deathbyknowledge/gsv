export const GSV_CLOUDFLARE_RELEASE_FORMAT = "gsv-cloudflare-release" as const;
export const GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION = 1 as const;
export const GSV_CLOUDFLARE_RELEASE_SCHEMA_URL =
  "https://gsv.space/schemas/gsv-cloudflare-release-v1.schema.json" as const;
export const GSV_CLOUDFLARE_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type CloudflareReleaseArtifact = Readonly<{
  file: string;
  mediaType: "application/gzip";
  sha256: string;
  size: number;
}>;

export type CloudflareReleaseBundle = Readonly<{
  root: string;
  manifest: string;
  wranglerConfig: string;
}>;

export type CloudflareCompatibility = Readonly<{
  date: string;
  flags: readonly string[];
}>;

export type CloudflareDurableObjectRename = Readonly<{
  from: string;
  to: string;
}>;

export type CloudflareDurableObjectMigration = Readonly<{
  tag: string;
  newClasses?: readonly string[];
  newSqliteClasses?: readonly string[];
  deletedClasses?: readonly string[];
  renamedClasses?: readonly CloudflareDurableObjectRename[];
}>;

export type CloudflareDurableObjectMigrations = Readonly<{
  sha256: string;
  steps: readonly CloudflareDurableObjectMigration[];
}>;

export type CloudflareReleaseAssets = Readonly<{
  directory: string;
  binding: string;
  htmlHandling?: string;
  notFoundHandling?: string;
  runWorkerFirst?: boolean | readonly string[];
}>;

export type CloudflareDurableObjectBindingIntent = Readonly<{
  kind: "durable-object";
  name: string;
  resource: string;
}>;

export type CloudflareR2BindingIntent = Readonly<{
  kind: "r2-bucket";
  name: string;
  resource: string;
}>;

export type CloudflareKvBindingIntent = Readonly<{
  kind: "kv-namespace";
  name: string;
  resource: string;
}>;

export type CloudflareServiceBindingIntent = Readonly<{
  kind: "service";
  name: string;
  targetComponent: string;
  entrypoint?: string;
}>;

export type CloudflareWorkerLoaderBindingIntent = Readonly<{
  kind: "worker-loader";
  name: string;
}>;

export type CloudflareWorkersAiBindingIntent = Readonly<{
  kind: "workers-ai";
  name: string;
}>;

export type CloudflareReleaseBindingIntent =
  | CloudflareDurableObjectBindingIntent
  | CloudflareR2BindingIntent
  | CloudflareKvBindingIntent
  | CloudflareServiceBindingIntent
  | CloudflareWorkerLoaderBindingIntent
  | CloudflareWorkersAiBindingIntent;

export type CloudflareDurableObjectResourceIntent = Readonly<{
  id: string;
  kind: "durable-object-namespace";
  ownerComponent: string;
  className: string;
  lifecycle: "persistent";
}>;

export type CloudflareR2ResourceIntent = Readonly<{
  id: string;
  kind: "r2-bucket";
  ownerComponent: string;
  lifecycle: "persistent";
}>;

export type CloudflareKvResourceIntent = Readonly<{
  id: string;
  kind: "kv-namespace";
  ownerComponent: string;
  lifecycle: "persistent";
}>;

export type CloudflareReleaseResourceIntent =
  | CloudflareDurableObjectResourceIntent
  | CloudflareR2ResourceIntent
  | CloudflareKvResourceIntent;

export type CloudflareReleaseWorker = Readonly<{
  entrypoint: string;
  compatibility: CloudflareCompatibility;
  bindings: readonly CloudflareReleaseBindingIntent[];
  durableObjectMigrations: CloudflareDurableObjectMigrations;
  assets?: CloudflareReleaseAssets;
}>;

export type CloudflareReleaseComponent = Readonly<{
  id: string;
  kind: "worker";
  required: boolean;
  deployOrder: number;
  dependsOn: readonly string[];
  artifact: CloudflareReleaseArtifact;
  bundle: CloudflareReleaseBundle;
  worker: CloudflareReleaseWorker;
}>;

export type CloudflareReleaseRuntime = Readonly<{
  protocolVersion: number;
  managedObjectDescriptorSchemaVersion: number;
  dataFrameStreamVersion: number;
}>;

export type CloudflareReleasePortable = Readonly<{
  archiveFormat: "gsv-portable-archive";
  archiveFormatVersion: number;
  features: readonly string[];
}>;

export type GsvCloudflareRelease = Readonly<{
  $schema: typeof GSV_CLOUDFLARE_RELEASE_SCHEMA_URL;
  format: typeof GSV_CLOUDFLARE_RELEASE_FORMAT;
  schemaVersion: typeof GSV_CLOUDFLARE_RELEASE_SCHEMA_VERSION;
  releaseVersion: string;
  source: Readonly<{
    commitSha: string;
  }>;
  runtime: CloudflareReleaseRuntime;
  portable: CloudflareReleasePortable;
  resources: readonly CloudflareReleaseResourceIntent[];
  components: readonly CloudflareReleaseComponent[];
}>;
