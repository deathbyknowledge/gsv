export const MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

export const MAX_MANAGED_PROVIDER_IDS_PER_CALL = 500;
export const MAX_MANAGED_PROVIDER_ID_LENGTH = 128;

const PROVIDER_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type ManagedObjectKind =
  | "kernel"
  | "process"
  | "app_runner"
  | "adapter_account"
  | "adapter_admission"
  | "repository"
  | "repository_registry";

export type ManagedObjectClassification =
  | "initialized"
  | "uninitialized"
  | "erased";

export type ManagedObjectLifecycleStatus =
  | "active"
  | "paused"
  | "updating"
  | "erasing"
  | "erased"
  | "uninitialized";

/**
 * Provider-independent identity returned by every managed Durable Object.
 *
 * `logicalName` is the input to `idFromName` when an object has been
 * initialized. Unknown provider IDs are represented explicitly instead of
 * being omitted, and erased objects remain distinguishable from never-used
 * IDs.
 */
export type ManagedObjectDescriptor = {
  schemaVersion: typeof MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION;
  kind: ManagedObjectKind;
  providerId: string;
  logicalName: string | null;
  classification: ManagedObjectClassification;
  lifecycle: {
    status: ManagedObjectLifecycleStatus;
    epoch: number;
  };
};

export type ManagedObjectDescriptorBatch = {
  schemaVersion: typeof MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION;
  kind: ManagedObjectKind;
  objects: ManagedObjectDescriptor[];
};

/** Validate, preserve, and bound provider IDs at private managed RPC edges. */
export function normalizeManagedProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Managed providerIds must be an array");
  }
  if (value.length > MAX_MANAGED_PROVIDER_IDS_PER_CALL) {
    throw new RangeError(
      `Managed object lookup supports at most ${MAX_MANAGED_PROVIDER_IDS_PER_CALL} IDs per call`,
    );
  }

  const seen = new Set<string>();
  return value.map((candidate) => {
    if (
      typeof candidate !== "string"
      || candidate.length === 0
      || candidate.length > MAX_MANAGED_PROVIDER_ID_LENGTH
      || candidate.trim() !== candidate
      || PROVIDER_ID_CONTROL_CHARACTERS.test(candidate)
    ) {
      throw new TypeError("Managed provider ID is invalid");
    }
    if (seen.has(candidate)) {
      throw new TypeError("Managed provider IDs must be unique");
    }
    seen.add(candidate);
    return candidate;
  });
}

export function validateManagedObjectDescriptor(
  value: unknown,
  expectedKind: ManagedObjectKind,
  expectedProviderId: string,
): ManagedObjectDescriptor {
  if (!value || typeof value !== "object") {
    throw new TypeError("Managed object returned an invalid descriptor");
  }
  const descriptor = value as Partial<ManagedObjectDescriptor>;
  const lifecycle = descriptor.lifecycle;
  if (
    descriptor.schemaVersion !== MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION
    || descriptor.kind !== expectedKind
    || descriptor.providerId !== expectedProviderId
    || (descriptor.logicalName !== null && typeof descriptor.logicalName !== "string")
    || (descriptor.classification !== "initialized"
      && descriptor.classification !== "uninitialized"
      && descriptor.classification !== "erased")
    || !lifecycle
    || typeof lifecycle !== "object"
    || (lifecycle.status !== "active"
      && lifecycle.status !== "paused"
      && lifecycle.status !== "updating"
      && lifecycle.status !== "erasing"
      && lifecycle.status !== "erased"
      && lifecycle.status !== "uninitialized")
    || !Number.isSafeInteger(lifecycle.epoch)
    || lifecycle.epoch < 0
  ) {
    throw new TypeError("Managed object returned an invalid descriptor");
  }

  if (
    (descriptor.classification === "initialized"
      && (!descriptor.logicalName
        || lifecycle.status === "uninitialized"
        || lifecycle.status === "erased"))
    || (descriptor.classification === "uninitialized"
      && (descriptor.logicalName !== null || lifecycle.status !== "uninitialized"))
    || (descriptor.classification === "erased" && lifecycle.status !== "erased")
  ) {
    throw new TypeError("Managed object returned an inconsistent descriptor");
  }

  return descriptor as ManagedObjectDescriptor;
}
