import type { ManagedInstallationIdentity } from "@humansandmachines/gsv/protocol";

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

const RESERVED_HANDLES = new Set([
  "deploy",
  "docs",
  "install",
  "www",
]);

export function parseOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function parseHandle(value: unknown): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !HANDLE_PATTERN.test(value)) {
    throw new Error("handle is invalid");
  }
  if (RESERVED_HANDLES.has(value)) {
    throw new Error("handle is reserved");
  }
  return value;
}

export function parseBaseDomain(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GSV_BASE_DOMAIN is required");
  }
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || normalized.includes(":")) {
    throw new Error("GSV_BASE_DOMAIN is invalid");
  }
  let url: URL;
  try {
    url = new URL(`https://${normalized}`);
  } catch {
    throw new Error("GSV_BASE_DOMAIN is invalid");
  }
  if (url.hostname !== normalized || url.pathname !== "/") {
    throw new Error("GSV_BASE_DOMAIN is invalid");
  }
  return normalized;
}

export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || normalized.includes(":")) return null;

  let url: URL;
  try {
    url = new URL(`https://${normalized}`);
  } catch {
    return null;
  }
  if (url.hostname !== normalized || url.pathname !== "/") return null;
  return normalized;
}

export function installationIdentity(
  handle: string,
  baseDomain: string,
  originTemplate?: string,
): ManagedInstallationIdentity {
  const parsedHandle = parseHandle(handle);
  const parsedDomain = parseBaseDomain(baseDomain);
  return {
    installationId: `inst_${crypto.randomUUID()}`,
    handle: parsedHandle,
    canonicalOrigin: installationOrigin(
      parsedHandle,
      parsedDomain,
      originTemplate,
    ),
  };
}

export function hostnameForHandle(handle: string, baseDomain: string): string {
  return `${parseHandle(handle)}.${parseBaseDomain(baseDomain)}`;
}

function installationOrigin(
  handle: string,
  baseDomain: string,
  template?: string,
): string {
  if (template === undefined) return `https://${handle}.${baseDomain}`;
  if (template.split("{handle}").length !== 2) {
    throw new Error("GSV_INSTALLATION_ORIGIN_TEMPLATE is invalid");
  }

  let origin: URL;
  try {
    origin = new URL(template.replace("{handle}", handle));
  } catch {
    throw new Error("GSV_INSTALLATION_ORIGIN_TEMPLATE is invalid");
  }
  if (
    origin.origin !== origin.toString().replace(/\/$/, "")
    || origin.username
    || origin.password
    || origin.hostname !== `${handle}.${baseDomain}`
  ) {
    throw new Error("GSV_INSTALLATION_ORIGIN_TEMPLATE is invalid");
  }
  return origin.origin;
}
