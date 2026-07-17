import {
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  normalizeManagedProviderIds,
  validateManagedObjectDescriptor,
  type ManagedObjectDescriptor,
  type ManagedObjectDescriptorBatch,
} from "@humansandmachines/gsv/protocol";

export type GatewayManagedObjectKind = "kernel" | "process" | "app_runner";

type ManagedDescriptorStub = {
  managedDescriptor(): Promise<ManagedObjectDescriptor>;
};

type ManagedDescriptorNamespace = {
  idFromString(providerId: string): DurableObjectId;
  idFromName(logicalName: string): DurableObjectId;
  get(id: DurableObjectId): ManagedDescriptorStub;
};

export class ManagedProviderIdError extends Error {
  constructor() {
    super("Managed provider ID is not valid for this namespace");
    this.name = "ManagedProviderIdError";
  }
}

/**
 * Resolve a bounded provider-ID batch without relying on any in-tenant
 * registry. Unknown IDs remain present as `uninitialized` descriptors.
 */
export async function describeGatewayManagedObjects(
  env: Env,
  kind: GatewayManagedObjectKind,
  providerIds: unknown,
): Promise<ManagedObjectDescriptorBatch> {
  const normalized = normalizeManagedProviderIds(providerIds);
  const namespace = namespaceForKind(env, kind);
  const objects = await mapWithConcurrency(normalized, 8, async (providerId) => {
    let id: DurableObjectId;
    try {
      id = namespace.idFromString(providerId);
    } catch {
      throw new ManagedProviderIdError();
    }
    const descriptor = validateManagedObjectDescriptor(
      await namespace.get(id).managedDescriptor(),
      kind,
      providerId,
    );
    verifyLogicalIdentity(namespace, descriptor);
    return descriptor;
  });

  return {
    schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
    kind,
    objects,
  };
}

function namespaceForKind(
  env: Env,
  kind: GatewayManagedObjectKind,
): ManagedDescriptorNamespace {
  switch (kind) {
    case "kernel":
      return env.KERNEL as unknown as ManagedDescriptorNamespace;
    case "process":
      return env.PROCESS as unknown as ManagedDescriptorNamespace;
    case "app_runner":
      return env.APP_RUNNER as unknown as ManagedDescriptorNamespace;
  }
}

function verifyLogicalIdentity(
  namespace: ManagedDescriptorNamespace,
  descriptor: ManagedObjectDescriptor,
): void {
  if (
    descriptor.logicalName !== null
    && namespace.idFromName(descriptor.logicalName).toString() !== descriptor.providerId
  ) {
    throw new Error("Managed object logical identity does not match provider ID");
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length && !failed) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await operation(values[index]);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

export function isGatewayManagedObjectKind(
  value: unknown,
): value is GatewayManagedObjectKind {
  return value === "kernel" || value === "process" || value === "app_runner";
}
