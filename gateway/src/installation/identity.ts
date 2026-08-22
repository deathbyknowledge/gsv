import type { JsonValue } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const installationIdSchema = z.string();

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

export function parseInstallationId(value: JsonValue | undefined): string {
  const parsed = installationIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("installationId must be a string");
  }
  if (!INSTALLATION_ID_PATTERN.test(parsed.data)) {
    throw new Error("installationId is invalid");
  }
  return parsed.data;
}

export function parseManagedInstallationId(value: JsonValue | undefined): string {
  const installationId = parseInstallationId(value);
  if (installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("managed installationId cannot use the standalone identity");
  }
  return installationId;
}
