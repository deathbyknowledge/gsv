import type {
  AdapterInstallationContext,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ResolvedMailRecipient = {
  installation: AdapterInstallationContext;
  handle: string;
};

export function mailAddressForHandle(
  handleValue: string,
  mailDomainValue: string,
): string {
  const handle = handleValue.trim().toLowerCase();
  if (handle !== handleValue || !HANDLE_PATTERN.test(handle)) {
    throw new Error("Accounts returned an invalid mail handle");
  }
  return `${handle}@${parseDomain(mailDomainValue, "MAIL_DOMAIN")}`;
}

export async function resolveMailRecipient(
  accounts: InstallationDirectoryService,
  addressValue: string,
  mailDomainValue: string,
  webBaseDomainValue: string,
): Promise<ResolvedMailRecipient | null> {
  const mailDomain = parseDomain(mailDomainValue, "MAIL_DOMAIN");
  const webBaseDomain = parseDomain(webBaseDomainValue, "GSV_BASE_DOMAIN");
  const address = addressValue.trim().toLowerCase();
  const separator = address.indexOf("@");
  if (
    separator <= 0
    || separator !== address.lastIndexOf("@")
    || address.slice(separator + 1) !== mailDomain
  ) {
    return null;
  }
  const handle = address.slice(0, separator);
  if (!HANDLE_PATTERN.test(handle)) return null;

  const result = await accounts.resolveHostname(`${handle}.${webBaseDomain}`);
  if (!result.found || result.state !== "active") return null;
  if (result.handle !== handle) {
    throw new Error("Accounts returned a mismatched mail installation");
  }
  return {
    installation: Object.freeze({ installationId: result.installationId }),
    handle,
  };
}

function parseDomain(value: string, name: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || normalized.includes(":")) {
    throw new Error(`${name} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (parsed.hostname !== normalized || parsed.pathname !== "/") {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}
