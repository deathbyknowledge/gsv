import { createHash, randomBytes } from "node:crypto";

const SETUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A one-time setup code for a deployment's first space. The deployment holds only its hash and expiry
 * as `GSV_SETUP`; the code itself is printed once, in the link.
 */
export function issueSetup(now = Date.now()): { code: string; binding: string; expiresAt: number } {
  const code = randomBytes(24).toString("base64url");
  const expiresAt = now + SETUP_TTL_MS;
  return { code, expiresAt, binding: `${expiresAt}.${createHash("sha256").update(code).digest("hex")}` };
}

/** The deployment's one secret; space keys derive from it, so it is created once and kept. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}
