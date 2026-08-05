declare const installationIdBrand: unique symbol;

export type InstallationId = string & {
  readonly [installationIdBrand]: true;
};

export type InstallationIdentity = {
  readonly installationId: InstallationId;
  readonly handle: string;
  readonly canonicalOrigin: string;
};

export type InstallationIdentityInput = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
};

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Existing standalone deployments have always used this Durable Object name.
 * Keep the compatibility projection explicit so upgrades retain their state.
 */
export const LEGACY_STANDALONE_INSTALLATION_ID = parseInstallationId("singleton");

export function parseInstallationId(value: unknown): InstallationId {
  if (typeof value !== "string") {
    throw new Error("installationId must be a string");
  }
  if (!INSTALLATION_ID_PATTERN.test(value)) {
    throw new Error("installationId is invalid");
  }
  return value as InstallationId;
}

export function createInstallationId(): InstallationId {
  return parseInstallationId(`inst_${crypto.randomUUID()}`);
}

export function parseInstallationIdentity(input: InstallationIdentityInput): InstallationIdentity {
  if (!input || typeof input !== "object") {
    throw new Error("installation identity is required");
  }

  return Object.freeze({
    installationId: parseInstallationId(input.installationId),
    handle: parseInstallationHandle(input.handle),
    canonicalOrigin: parseCanonicalOrigin(input.canonicalOrigin),
  });
}

export function parseInstallationHandle(value: unknown): string {
  if (typeof value !== "string" || !HANDLE_PATTERN.test(value)) {
    throw new Error("installation handle is invalid");
  }
  return value;
}

export function parseCanonicalOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("canonicalOrigin must be a string");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("canonicalOrigin must be an absolute URL origin");
  }

  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("canonicalOrigin must be a URL origin");
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("canonicalOrigin must use https, except for loopback development URLs");
  }

  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}
