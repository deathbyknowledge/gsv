import {
  parseSetupTokenPolicy,
  type SetupTokenPolicy,
} from "./setup-token-policy";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MANAGED_SETUP_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type SetupTokenEnv = Env & {
  // This optional deployment secret is intentionally absent from the
  // self-hosted Wrangler config and its generated Env declaration.
  GSV_SETUP_TOKEN_HASH?: unknown;
  GSV_SETUP_TOKEN_EXPIRES_AT?: unknown;
};

export class SetupTokenError extends Error {
  constructor(readonly status: 403 | 500, message: string) {
    super(message);
    this.name = "SetupTokenError";
  }
}

function decodeSha256Hex(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function configuredSetupTokenPolicy(
  env: Env,
): { hash: string; expiresAt: number } | undefined {
  const setupEnv = env as SetupTokenEnv;
  const hash = setupEnv.GSV_SETUP_TOKEN_HASH;
  const rawExpiresAt = setupEnv.GSV_SETUP_TOKEN_EXPIRES_AT;
  if (hash === undefined && rawExpiresAt === undefined) {
    return undefined;
  }
  if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) {
    throw new SetupTokenError(
      500,
      "GSV_SETUP_TOKEN_HASH must be a lowercase 64-character SHA-256 hex digest",
    );
  }
  if (typeof rawExpiresAt !== "string" || !/^[1-9][0-9]*$/.test(rawExpiresAt)) {
    throw new SetupTokenError(
      500,
      "GSV_SETUP_TOKEN_EXPIRES_AT must be a positive canonical millisecond timestamp",
    );
  }
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== rawExpiresAt) {
    throw new SetupTokenError(
      500,
      "GSV_SETUP_TOKEN_EXPIRES_AT must be a positive canonical millisecond timestamp",
    );
  }
  return { hash, expiresAt };
}

export async function authorizeSetupToken(
  env: Env,
  providedToken: unknown,
  now = Date.now(),
  managedPolicy?: SetupTokenPolicy,
): Promise<void> {
  // A runtime-owned policy is authoritative once installed. Environment
  // secrets remain a fallback for self-hosting and managed upgrades whose
  // Kernel has not received its first policy yet.
  const policy = managedPolicy === undefined
    ? configuredSetupTokenPolicy(env)
    : parseSetupTokenPolicy(managedPolicy);
  if (policy === undefined) {
    return;
  }

  const token = typeof providedToken === "string" ? providedToken : "";
  const managedTokenShapeValid = managedPolicy === undefined
    || MANAGED_SETUP_TOKEN_RE.test(token);
  const candidateHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(managedTokenShapeValid ? token : ""),
    ),
  );
  const matches = crypto.subtle.timingSafeEqual(
    candidateHash,
    decodeSha256Hex(policy.hash),
  );

  if (
    typeof providedToken !== "string"
    || providedToken.length === 0
    || !managedTokenShapeValid
    || !matches
    || now >= policy.expiresAt
  ) {
    throw new SetupTokenError(403, "Setup authorization failed");
  }
}
