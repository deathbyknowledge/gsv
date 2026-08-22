import {
  adapterInstallationContextSchema,
  type AdapterInstallationContext,
} from "../../../packages/gsv/src/protocol/adapters.js";
import * as z from "zod/mini";

export const LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID = "singleton";
const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;
const ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX = "account:";

export type AdapterAccountDurableObjectIdentity = AdapterInstallationContext & {
  accountId: string;
};

export type AdapterAccountStoredIdentity = {
  installationId?: string | null;
  accountId?: string | null;
};

const adapterAccountStoredIdentitySchema = z.object({
  installationId: z.optional(z.nullable(z.string())),
  accountId: z.optional(z.nullable(z.string())),
});

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
  const name = parsed.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
    ? normalizedAccountId
    : `${ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsed.installationId)}:${encodeURIComponent(normalizedAccountId)}`;
  assertAdapterAccountDurableObjectNameLength(name);
  return name;
}

export function parseAdapterAccountDurableObjectName(
  name: string | undefined,
): AdapterAccountDurableObjectIdentity {
  if (!name) {
    throw new Error("Adapter account Durable Object must be accessed by name");
  }

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
      // Fall through to the standalone compatibility name.
    }
  }
  if (hasManagedPrefix) {
    throw new Error("Adapter account Durable Object name is invalid");
  }

  assertAdapterAccountDurableObjectNameLength(name);
  return Object.freeze({
    installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
    accountId: name,
  });
}

export function assertAdapterAccountDurableObjectIdentity(
  name: string | undefined,
  accountId: string,
  stored?: AdapterAccountStoredIdentity,
): AdapterAccountDurableObjectIdentity {
  const identity = stored
    ? resolveAdapterAccountDurableObjectIdentity(name, stored)
    : parseAdapterAccountDurableObjectName(name);
  if (identity.accountId !== accountId.trim()) {
    throw new Error("Adapter account identity mismatch");
  }
  return identity;
}

export function resolveAdapterAccountDurableObjectIdentity(
  name: string | undefined,
  storedInput: AdapterAccountStoredIdentity,
): AdapterAccountDurableObjectIdentity {
  const parsedStored = adapterAccountStoredIdentitySchema.safeParse(storedInput);
  if (!parsedStored.success) {
    throw new Error("Persisted adapter account identity is invalid");
  }
  const stored = parsedStored.data;
  if (name) {
    if (
      name.startsWith(ADAPTER_ACCOUNT_DURABLE_OBJECT_PREFIX)
      && stored.accountId === name
    ) {
      const storedInstallationId = stored.installationId;
      const storedInstallation = storedInstallationId === undefined
        || storedInstallationId === null
        ? LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
        : parseAdapterInstallationContext({
            installationId: storedInstallationId,
          }).installationId;
      if (storedInstallation === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID) {
        const accountId = adapterAccountDurableObjectName(
          { installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID },
          name,
        );
        return Object.freeze({
          installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
          accountId,
        });
      }
    }
    const identity = parseAdapterAccountDurableObjectName(name);
    if (
      stored.accountId !== undefined
      && stored.accountId !== null
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

  const parsedInstallation = adapterInstallationContextSchema.safeParse({
    installationId: stored.installationId,
  });
  if (!parsedInstallation.success) {
    throw new Error("Persisted adapter installation identity is invalid");
  }
  const installation = parsedInstallation.data;
  const accountId = stored.accountId?.trim() ?? "";
  if (!accountId) {
    throw new Error("Adapter account identity is unavailable");
  }
  return Object.freeze({ ...installation, accountId });
}

function assertAdapterAccountDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Adapter account Durable Object name is too long");
  }
}
