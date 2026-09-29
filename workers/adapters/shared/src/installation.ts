import {
  adapterInstallationContextSchema,
  type AdapterInstallationContext,
} from "../../../../packages/gsv/src/protocol/adapters.js";

const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;
const ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX = "account:";

export type AdapterAccountDurableObjectIdentity = AdapterInstallationContext & {
  accountId: string;
};

export function parseAdapterInstallationContext(
  value: AdapterInstallationContext,
): AdapterInstallationContext {
  const parsed = adapterInstallationContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter installation context is invalid");
  }
  return Object.freeze(parsed.data);
}

export function adapterAccountDurableObjectName(
  installation: AdapterInstallationContext,
  accountId: string,
): string {
  const parsed = parseAdapterInstallationContext(installation);
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    throw new Error("Adapter account ID is required");
  }
  const name = `${ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsed.installationId)}:${encodeURIComponent(normalizedAccountId)}`;
  assertAdapterAccountDurableObjectNameLength(name);
  return name;
}

export function parseAdapterAccountDurableObjectName(
  name: string | undefined,
): AdapterAccountDurableObjectIdentity {
  if (!name) {
    throw new Error("Adapter account Durable Object must be accessed by name");
  }

  assertAdapterAccountDurableObjectNameLength(name);
  const hasManagedPrefix = name.startsWith(ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX);
  const separator = name.indexOf(":", ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX.length);
  if (hasManagedPrefix && separator !== -1) {
    try {
      const installation = parseAdapterInstallationContext({
        installationId: decodeURIComponent(
          name.slice(ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX.length, separator),
        ),
      });
      const accountId = decodeURIComponent(name.slice(separator + 1)).trim();
      if (
        accountId
        && adapterAccountDurableObjectName(installation, accountId) === name
      ) {
        return Object.freeze({ ...installation, accountId });
      }
    } catch {
      // Invalid or noncanonical scoped names fail closed below.
    }
  }
  throw new Error("Adapter account Durable Object name is invalid");
}

function assertAdapterAccountDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Adapter account Durable Object name is too long");
  }
}
