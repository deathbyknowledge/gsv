import type { JsonValue } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const installationIdSchema = z.string();

export type InstallationIdentity = {
  installationId: string;
  canonicalOrigin: string;
  handle?: string;
};

export type ShipAddress = { handle: string; origin: string; domain: string };

/**
 * The Ship's public address: its handle, origin, and the domain its deployment's Ships share.
 * The operator's primary domain names every Ship's handle address; Accounts aliases it to the
 * canonical origin. Without one, the domain comes from the canonical origin.
 */
export function shipAddress(identity: InstallationIdentity | null | undefined, primaryDomain?: string): ShipAddress | null {
  if (!identity?.handle) return null;
  const handle = identity.handle.toLowerCase();
  if (primaryDomain) return { handle, origin: `https://${handle}.${primaryDomain}`, domain: primaryDomain };
  const hostname = new URL(identity.canonicalOrigin).hostname.toLowerCase();
  const prefix = `${handle}.`;
  if (!hostname.startsWith(prefix) || hostname.length === prefix.length) return null;
  return { handle, origin: identity.canonicalOrigin, domain: hostname.slice(prefix.length) };
}

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
