import type { ProvisionInstallationInput } from "@humansandmachines/gsv/protocol";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationIdentity,
} from "../installation/identity";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function parseProvisionInstallationInput(value: unknown): ProvisionInstallationInput {
  if (!value || typeof value !== "object") {
    throw new Error("Provisioning input is required");
  }
  const input = value as Partial<ProvisionInstallationInput>;
  const operationId = parseOpaqueId(input.operationId, "operationId");
  const installation = parseInstallationIdentity(input.installation!);
  if (installation.installationId === LEGACY_STANDALONE_INSTALLATION_ID) {
    throw new Error("Managed provisioning cannot address singleton");
  }
  if (!input.owner || typeof input.owner !== "object") {
    throw new Error("owner is required");
  }
  const principalId = parseOpaqueId(input.owner.principalId, "owner.principalId");
  const username = parseUsername(input.owner.username, "owner.username");
  const agentName = input.owner.agentName === undefined
    ? undefined
    : parseUsername(input.owner.agentName, "owner.agentName");
  if (agentName === username) {
    throw new Error("owner.agentName must be different from owner.username");
  }
  const timezone = input.owner.timezone === undefined
    ? undefined
    : parseTimezone(input.owner.timezone);
  if (!Number.isSafeInteger(input.provisionVersion) || input.provisionVersion! < 1) {
    throw new Error("provisionVersion is invalid");
  }
  return {
    operationId,
    installation: {
      installationId: installation.installationId,
      handle: installation.handle,
      canonicalOrigin: installation.canonicalOrigin,
    },
    owner: {
      principalId,
      username,
      ...(agentName ? { agentName } : {}),
      ...(timezone ? { timezone } : {}),
    },
    provisionVersion: input.provisionVersion!,
  };
}

function parseOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseUsername(value: unknown, field: string): string {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("owner.timezone is invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error("owner.timezone is invalid");
  }
  return value;
}
