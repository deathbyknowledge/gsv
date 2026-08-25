export type AppSessionState = "active" | "detached" | "closing" | "closed" | "expired";

export type AppSessionClientContext = {
  sessionId: string;
  clientId: string;
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  rpcBase: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null;
};

export type AppSessionContext = {
  sessionId: string;
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null;
  state: AppSessionState;
  clients: AppSessionClientContext[];
};

export type AppClientSessionContext = AppSessionClientContext;

export type IssuedAppClientSession = AppClientSessionContext & {
  secret: string;
};

const ROUTED_APP_SESSION_PREFIX = "gsv1b";
const APP_RUNNER_PREFIX = "app";
export const MAX_APP_SESSION_ID_LENGTH = 256;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type RoutedAppSessionId = {
  username: string;
  uid: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  signingInput: string;
};

export function buildRoutedAppSessionSigningInput(input: {
  username: string;
  uid: number;
  expiresAt: number;
  nonce: string;
}): string {
  assertRoutedAppSessionFields(input);
  return [
    ROUTED_APP_SESSION_PREFIX,
    input.username,
    String(input.uid),
    String(input.expiresAt),
    input.nonce.toLowerCase(),
  ].join("~");
}

export function buildRoutedAppSessionId(
  input: {
    username: string;
    uid: number;
    expiresAt: number;
    nonce: string;
  },
  signature: string,
): string {
  if (!isCanonicalBase64Url(signature, 32)) {
    throw new Error("Invalid routed app session signature");
  }
  const sessionId = `${buildRoutedAppSessionSigningInput(input)}~${signature}`;
  if (sessionId.length > MAX_APP_SESSION_ID_LENGTH) {
    throw new Error("Routed app session id is too large");
  }
  return sessionId;
}

export function parseRoutedAppSessionId(value: unknown): RoutedAppSessionId | null {
  if (typeof value !== "string" || value.length > MAX_APP_SESSION_ID_LENGTH) {
    return null;
  }
  const [
    prefix,
    username,
    rawUid,
    rawExpiresAt,
    nonce,
    signature,
    extra,
  ] = value.split("~");
  const uid = Number(rawUid);
  const expiresAt = Number(rawExpiresAt);
  if (
    prefix !== ROUTED_APP_SESSION_PREFIX
    || extra !== undefined
    || !isCanonicalBase64Url(signature, 32)
  ) {
    return null;
  }

  try {
    const signingInput = buildRoutedAppSessionSigningInput({
      username: username ?? "",
      uid,
      expiresAt,
      nonce: nonce ?? "",
    });
    if (`${signingInput}~${signature}` !== value) {
      return null;
    }
    return {
      username: username!,
      uid,
      expiresAt,
      nonce: nonce!,
      signature: signature!,
      signingInput,
    };
  } catch {
    return null;
  }
}

export function buildAppClientRouteBase(sessionId: string, clientId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/clients/${encodeURIComponent(clientId)}`;
}

export function buildAppClientRpcBase(sessionId: string, clientId: string): string {
  return `${buildAppClientRouteBase(sessionId, clientId)}/socket`;
}

export function buildAppRunnerName(
  uid: number,
  packageId: string,
): string {
  const normalizedPackageId = typeof packageId === "string" ? packageId.trim() : "";
  if (
    !Number.isSafeInteger(uid)
    || uid < 0
    || !normalizedPackageId
  ) {
    throw new Error("Invalid AppRunner identity");
  }
  // This is the pre-split object name. Keep it byte-for-byte stable so the
  // existing package SQLite and daemon schedules remain reachable.
  return `${APP_RUNNER_PREFIX}:${uid}:${normalizedPackageId}`;
}

function assertRoutedAppSessionFields(input: {
  username: string;
  uid: number;
  expiresAt: number;
  nonce: string;
}): void {
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.username)
    || !Number.isSafeInteger(input.uid)
    || input.uid < 0
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= 0
    || !UUID_RE.test(input.nonce)
  ) {
    throw new Error("Invalid routed app session fields");
  }
}

function isCanonicalBase64Url(
  value: unknown,
  expectedBytes: number,
): value is string {
  if (
    typeof value !== "string"
    || !Number.isSafeInteger(expectedBytes)
    || expectedBytes < 0
    || value.length !== Math.ceil(expectedBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    let canonical = "";
    for (let index = 0; index < binary.length; index += 1) {
      canonical += String.fromCharCode(binary.charCodeAt(index));
    }
    return binary.length === expectedBytes
      && btoa(canonical)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "") === value;
  } catch {
    return false;
  }
}
