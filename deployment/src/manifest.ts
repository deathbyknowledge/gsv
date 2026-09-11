import * as z from "zod/mini";
import { installationResourceKindSchema } from "@humansandmachines/gsv/services/lifecycle-discovery";

export const GSV_DEPLOYMENT_MANIFEST_VERSION = 2;

const durableObjectSchema = z.strictObject({
  binding: z.string().check(z.minLength(1), z.maxLength(128)),
  className: z.string().check(z.minLength(1), z.maxLength(128)),
});

export const adapterWorkerDeploymentSchema = z.strictObject({
  main: z.string().check(z.minLength(1)),
  bundle: z.boolean(),
  gatewayEntrypoint: z.string().check(z.minLength(1), z.maxLength(128)),
  adapterEntrypoint: z.string().check(z.minLength(1), z.maxLength(128)),
  durableObjects: z.array(durableObjectSchema),
  requiredSecrets: z.array(
    z.string().check(z.regex(/^[A-Z][A-Z0-9_]*$/)),
  ),
  requiredVariables: z.optional(z.array(z.string().check(z.regex(/^[A-Z][A-Z0-9_]*$/)))),
  lifecycle: z.optional(z.strictObject({
    entrypoint: z.string().check(z.minLength(1), z.maxLength(128)),
    namespaces: z.array(z.strictObject({
      binding: z.string().check(z.regex(/^[A-Z][A-Z0-9_]*$/)),
      kind: z.enum(installationResourceKindSchema.options),
    })),
  })),
  crons: z.optional(z.array(z.string().check(z.minLength(1)))),
  selfUrlBinding: z.optional(
    z.string().check(z.regex(/^[A-Z][A-Z0-9_]*$/)),
  ),
});

export const adapterDeploymentSchema = z.strictObject({
  id: z.string().check(
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[a-z][a-z0-9-]*$/),
  ),
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  gatewayBinding: z.string().check(z.regex(/^CHANNEL_[A-Z0-9_]+$/)),
  standalone: adapterWorkerDeploymentSchema,
  managed: z.optional(adapterWorkerDeploymentSchema),
});

export const adapterSourceManifestSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().check(
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[a-z][a-z0-9-]*$/),
  ),
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  description: z.string().check(z.minLength(1)),
  deployOrder: z.number().check(z.int(), z.positive()),
  wranglerConfig: z.string().check(z.minLength(1)),
  devStateDirectories: z.array(z.string().check(z.minLength(1))),
  standalone: adapterWorkerDeploymentSchema,
  managed: z.optional(adapterWorkerDeploymentSchema),
});

const runtimeDeploymentSchema = z.strictObject({
  gatewayBundle: z.string().check(z.minLength(1)),
  webAssets: z.string().check(z.minLength(1)),
  ripgitBundle: z.string().check(z.minLength(1)),
  installationsBundle: z.string().check(z.minLength(1)),
  installationsMigrations: z.string().check(z.minLength(1)),
  inferenceBundle: z.string().check(z.minLength(1)),
});

export const gsvDeploymentManifestSchema = z.strictObject({
  version: z.literal(GSV_DEPLOYMENT_MANIFEST_VERSION),
  runtime: runtimeDeploymentSchema,
  adapters: z.array(adapterDeploymentSchema),
});

export const gsvRuntimeManifestSchema = z.strictObject({
  version: z.literal(GSV_DEPLOYMENT_MANIFEST_VERSION),
  runtime: runtimeDeploymentSchema,
});

export type GsvDeploymentManifest = z.infer<
  typeof gsvDeploymentManifestSchema
>;

export type GsvRuntimeManifest = z.infer<typeof gsvRuntimeManifestSchema>;

export type AdapterDeploymentManifest = z.infer<
  typeof adapterDeploymentSchema
>;

export type AdapterWorkerDeploymentManifest = z.infer<
  typeof adapterWorkerDeploymentSchema
>;

export type AdapterSourceManifest = z.infer<
  typeof adapterSourceManifestSchema
>;

export const resolveAdapterDeploymentManifest = (
  adapter: AdapterSourceManifest,
): AdapterDeploymentManifest => {
  const deployment: AdapterDeploymentManifest = {
    id: adapter.id,
    displayName: adapter.displayName,
    gatewayBinding: `CHANNEL_${adapter.id.replaceAll("-", "_").toUpperCase()}`,
    standalone: adapter.standalone,
  };
  if (adapter.managed) deployment.managed = adapter.managed;
  return deployment;
};
