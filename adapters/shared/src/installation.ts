import {
  isAdapterInstallationContext,
  type AdapterInstallationContext,
} from "../../../packages/gsv/src/protocol/adapters.js";

export const LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID = "singleton";

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
  if (parsed.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID) {
    return normalizedAccountId;
  }
  return `account:${encodeURIComponent(parsed.installationId)}:${encodeURIComponent(normalizedAccountId)}`;
}

export function assertAdapterInstallationIdentity(
  storedInstallationId: string | null | undefined,
  installation: AdapterInstallationContext,
): string {
  const { installationId } = parseAdapterInstallationContext(installation);
  if (storedInstallationId && storedInstallationId !== installationId) {
    throw new Error("Adapter installation identity mismatch");
  }
  return installationId;
}
