import {
  isAdapterInstallationContext,
  type AdapterInstallationContext,
} from "../../../packages/gsv/src/protocol/adapters.js";

export const LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID = "singleton";
const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;

export type AdapterAccountDurableObjectIdentity = AdapterInstallationContext & {
  accountId: string;
};

export function parseAdapterInstallationContext(
  value: unknown,
): AdapterInstallationContext {
  if (!isAdapterInstallationContext(value)) {
    throw new Error("Adapter installation context is invalid");
  }
  return Object.freeze({ installationId: value.installationId });
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
  const name = parsed.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
    ? normalizedAccountId
    : `account:${encodeURIComponent(parsed.installationId)}:${encodeURIComponent(normalizedAccountId)}`;
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Adapter account Durable Object name is too long");
  }
  return name;
}

export function parseAdapterAccountDurableObjectName(
  name: string | undefined,
): AdapterAccountDurableObjectIdentity {
  if (!name) {
    throw new Error("Adapter account Durable Object must be accessed by name");
  }

  const prefix = "account:";
  const separator = name.indexOf(":", prefix.length);
  if (name.startsWith(prefix) && separator !== -1) {
    try {
      const installation = parseAdapterInstallationContext({
        installationId: decodeURIComponent(name.slice(prefix.length, separator)),
      });
      const accountId = decodeURIComponent(name.slice(separator + 1)).trim();
      if (
        accountId
        && adapterAccountDurableObjectName(installation, accountId) === name
      ) {
        return Object.freeze({ ...installation, accountId });
      }
    } catch {
      // Fall through to the standalone compatibility name.
    }
  }

  return Object.freeze({
    installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
    accountId: name,
  });
}

export function assertAdapterAccountDurableObjectIdentity(
  name: string | undefined,
  accountId: string,
): AdapterAccountDurableObjectIdentity {
  const identity = parseAdapterAccountDurableObjectName(name);
  if (identity.accountId !== accountId.trim()) {
    throw new Error("Adapter account identity mismatch");
  }
  return identity;
}

export function resolveAdapterAccountDurableObjectIdentity(
  name: string | undefined,
  stored: {
    installationId?: unknown;
    accountId?: unknown;
  },
): AdapterAccountDurableObjectIdentity {
  if (name) {
    const identity = parseAdapterAccountDurableObjectName(name);
    if (
      typeof stored.accountId === "string"
      && stored.accountId
      && stored.accountId.trim() !== identity.accountId
    ) {
      throw new Error("Adapter account identity mismatch");
    }
    if (stored.installationId !== undefined && stored.installationId !== null) {
      const installation = parseAdapterInstallationContext({
        installationId: stored.installationId,
      });
      if (installation.installationId !== identity.installationId) {
        throw new Error("Adapter installation identity mismatch");
      }
    }
    return identity;
  }

  const installation = parseAdapterInstallationContext({
    installationId: stored.installationId,
  });
  const accountId = typeof stored.accountId === "string"
    ? stored.accountId.trim()
    : "";
  if (!accountId) {
    throw new Error("Adapter account identity is unavailable");
  }
  return Object.freeze({ ...installation, accountId });
}
