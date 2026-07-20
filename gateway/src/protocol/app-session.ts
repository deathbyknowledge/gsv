import {
  isAppPlacementCertificate,
  isCanonicalBase64Url,
} from "../shared/app-placement-certificate";

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
const APP_RUNNER_CONTROL_PREFIX = "app-control-v3";
const APP_RUNNER_DATA_PREFIX = "app-data-v2";
export const MAX_APP_SESSION_ID_LENGTH = 256;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type RoutedAppSessionId = {
  username: string;
  uid: number;
  generation: number;
  expiresAt: number;
  nonce: string;
  placementCertificate: string;
  signature: string;
  signingInput: string;
};

export function buildRoutedAppSessionSigningInput(input: {
  username: string;
  uid: number;
  generation: number;
  expiresAt: number;
  nonce: string;
  placementCertificate: string;
}): string {
  assertRoutedAppSessionFields(input);
  return [
    ROUTED_APP_SESSION_PREFIX,
    input.username,
    String(input.uid),
    String(input.generation),
    String(input.expiresAt),
    input.nonce.toLowerCase(),
    input.placementCertificate,
  ].join("~");
}

export function buildRoutedAppSessionId(
  input: {
    username: string;
    uid: number;
    generation: number;
    expiresAt: number;
    nonce: string;
    placementCertificate: string;
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
    rawGeneration,
    rawExpiresAt,
    nonce,
    placementCertificate,
    signature,
    extra,
  ] = value.split("~");
  const uid = Number(rawUid);
  const generation = Number(rawGeneration);
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
      generation,
      expiresAt,
      nonce: nonce ?? "",
      placementCertificate: placementCertificate ?? "",
    });
    if (`${signingInput}~${signature}` !== value) {
      return null;
    }
    return {
      username: username!,
      uid,
      generation,
      expiresAt,
      nonce: nonce!,
      placementCertificate: placementCertificate!,
      signature: signature!,
      signingInput,
    };
  } catch {
    return null;
  }
}

export function isLegacyAppSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_APP_SESSION_ID_LENGTH
    && UUID_RE.test(value);
}

export function buildAppClientRouteBase(sessionId: string, clientId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/clients/${encodeURIComponent(clientId)}`;
}

export function buildAppClientRpcBase(sessionId: string, clientId: string): string {
  return `${buildAppClientRouteBase(sessionId, clientId)}/socket`;
}

export function buildAppRunnerName(
  kernelOwnerUid: number,
  actorUid: number,
  packageId: string,
): string {
  const normalizedPackageId = typeof packageId === "string" ? packageId.trim() : "";
  if (
    !Number.isSafeInteger(kernelOwnerUid)
    || kernelOwnerUid < 0
    || !Number.isSafeInteger(actorUid)
    || actorUid < 0
    || !normalizedPackageId
  ) {
    throw new Error("Invalid AppRunner control authority");
  }
  return `${APP_RUNNER_CONTROL_PREFIX}:${kernelOwnerUid}:${actorUid}:${encodeURIComponent(normalizedPackageId)}`;
}

export function buildAppDataRunnerName(
  kernelOwnerUid: number,
  actorUid: number,
  packageId: string,
): string {
  const normalizedPackageId = typeof packageId === "string" ? packageId.trim() : "";
  if (
    !Number.isSafeInteger(kernelOwnerUid)
    || kernelOwnerUid < 0
    || !Number.isSafeInteger(actorUid)
    || actorUid < 0
    || !normalizedPackageId
  ) {
    throw new Error("Invalid AppRunner data authority");
  }
  return `${APP_RUNNER_DATA_PREFIX}:${kernelOwnerUid}:${actorUid}:${encodeURIComponent(normalizedPackageId)}`;
}

export function isAppRunnerControlName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^app-control-v3:([0-9]+):([0-9]+):(.+)$/.exec(value);
  if (!match) {
    return false;
  }
  try {
    const kernelOwnerUid = Number(match[1]);
    const actorUid = Number(match[2]);
    const packageId = decodeURIComponent(match[3] ?? "");
    return buildAppRunnerName(kernelOwnerUid, actorUid, packageId) === value;
  } catch {
    return false;
  }
}

export function isAppRunnerDataName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^app-data-v2:([0-9]+):([0-9]+):(.+)$/.exec(value);
  if (!match) {
    return false;
  }
  try {
    const kernelOwnerUid = Number(match[1]);
    const actorUid = Number(match[2]);
    const packageId = decodeURIComponent(match[3] ?? "");
    return buildAppDataRunnerName(kernelOwnerUid, actorUid, packageId) === value;
  } catch {
    return false;
  }
}

function assertRoutedAppSessionFields(input: {
  username: string;
  uid: number;
  generation: number;
  expiresAt: number;
  nonce: string;
  placementCertificate: string;
}): void {
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.username)
    || !Number.isSafeInteger(input.uid)
    || input.uid < 0
    || !Number.isSafeInteger(input.generation)
    || input.generation <= 0
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= 0
    || !UUID_RE.test(input.nonce)
    || !isAppPlacementCertificate(input.placementCertificate)
  ) {
    throw new Error("Invalid routed app session fields");
  }
}
