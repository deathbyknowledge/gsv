import type { ManagedInstallationIdentity } from "@humansandmachines/gsv/protocol";

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

const RESERVED_HANDLES = new Set([
  "admin",
  "api",
  "app",
  "accounts",
  "assets",
  "auth",
  "billing",
  "bot",
  "cdn",
  "dashboard",
  "deploy",
  "docs",
  "inference",
  "install",
  "login",
  "mail",
  "oauth",
  "status",
  "support",
  "telegram",
  "webhooks",
  "www",
]);

export function parseOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("email is invalid");
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3
    || normalized.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("email is invalid");
  }
  return normalized;
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

export function installationIdentity(handle: string, baseDomain: string): ManagedInstallationIdentity {
  const parsedHandle = parseHandle(handle);
  const parsedDomain = parseBaseDomain(baseDomain);
  return {
    installationId: `inst_${crypto.randomUUID()}`,
    handle: parsedHandle,
    canonicalOrigin: `https://${parsedHandle}.${parsedDomain}`,
  };
}

export function hostnameForHandle(handle: string, baseDomain: string): string {
  return `${parseHandle(handle)}.${parseBaseDomain(baseDomain)}`;
}

export function nowMs(): number {
  return Date.now();
}
