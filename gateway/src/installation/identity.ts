const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

/**
 * Existing standalone deployments have always used this Durable Object name.
 * Keep the compatibility projection explicit so upgrades retain their state.
 */
export const SINGLETON_INSTALLATION_ID = "singleton";

export type InstallationIdentity = {
  installationId: string;
  canonicalOrigin: string;
  handle?: string;
};

export function parseInstallationId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("installationId must be a string");
  }
  if (!INSTALLATION_ID_PATTERN.test(value)) {
    throw new Error("installationId is invalid");
  }
  return value;
}

export function parseManagedInstallationId(value: unknown): string {
  const installationId = parseInstallationId(value);
  if (installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("managed installationId cannot use the standalone identity");
  }
  return installationId;
}
