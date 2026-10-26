import { verifySig } from "@atcute/crypto";
import { isAtprotoWebDid, isPlcDid } from "@atcute/identity";
import { fromBase64Url } from "@atcute/multibase";
import * as z from "zod/mini";
import type { KernelContext } from "../context";
import {
  DidDirectoryUnavailableError,
  DidNotResolvedError,
  isDidCached,
  resolveDid,
  signingKeyOf,
  type ResolvedDid,
} from "./did-directory";
import { ShipXrpcError } from "./errors";

/** Ship-to-Ship calls name the receiving Ship's `#ship` service as their audience. */
export const SHIP_SERVICE_FRAGMENT = "#ship";
const MAX_TOKEN_BYTES = 4_096;
/** Ships mint tokens that live a minute; one that claims to live longer than this is refused. */
const MAX_TOKEN_LIFETIME_S = 5 * 60;
/** How far apart two Ships' clocks may be. */
const CLOCK_LEEWAY_S = 30;
/** Each unknown caller, and each refresh after a failed signature, costs a directory lookup. */
const MAX_LOOKUPS_PER_MINUTE = 60;
/** Bearer tokens of other kinds, which must never pass as service auth. */
const OTHER_TOKEN_TYPES = new Set(["at+jwt", "refresh+jwt", "dpop+jwt"]);

const headerSchema = z.object({ alg: z.enum(["ES256K", "ES256"]), typ: z.optional(z.string()) });
const claimsSchema = z.object({
  iss: z.string().check(z.maxLength(2_048)),
  aud: z.string().check(z.maxLength(2_048)),
  lxm: z.string().check(z.maxLength(317)),
  iat: z.int(),
  exp: z.int(),
  jti: z.string().check(z.minLength(1), z.maxLength(128)),
});

/** The nonces of tokens this Ship accepted, kept until the tokens expire. */
export class ShipCallNonces {
  constructor(private readonly sql: SqlStorage) {}

  /** Spends a token's nonce; false when its issuer already spent it. */
  spend(issuer: string, jti: string, expiresAtMs: number, now: number): boolean {
    this.sql.exec("DELETE FROM service_auth_nonces WHERE expires_at <= ?", now);
    return this.sql.exec(
      "INSERT INTO service_auth_nonces (issuer, jti, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      issuer,
      jti,
      expiresAtMs,
    ).rowsWritten > 0;
  }
}

/**
 * Checks an incoming call's service-auth token and returns the DID that signed
 * it: addressed to this Ship, for this method, unexpired, signed by the
 * issuer's `#atproto` key, and never seen before. The nonce is spent only once
 * the signature verifies, so nobody but the issuer can spend it.
 */
export async function authenticateShipCall(request: Request, lxm: string, ctx: KernelContext): Promise<string> {
  const token = bearerToken(request);
  const [encodedHeader, encodedClaims, encodedSignature, ...rest] = token.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature || rest.length > 0) throw refused("BadJwt", "The token isn't a JWT");
  const header = segment(headerSchema, encodedHeader);
  if (header.typ !== undefined && OTHER_TOKEN_TYPES.has(header.typ.toLowerCase())) {
    throw refused("BadJwt", "That token isn't service auth");
  }
  const claims = segment(claimsSchema, encodedClaims);
  const own = ctx.shipIdentity.current();
  if (!own || claims.aud !== `${own}${SHIP_SERVICE_FRAGMENT}`) throw refused("BadJwtAudience", "The token is addressed to another service");
  if (claims.lxm !== lxm) throw refused("BadJwtLexiconMethod", `The token is for ${claims.lxm}, not ${lxm}`);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp + CLOCK_LEEWAY_S < now) throw refused("JwtExpired", "The token has expired");
  if (claims.iat > now + CLOCK_LEEWAY_S || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_S) {
    throw refused("BadJwt", "The token's lifetime is invalid");
  }
  if (!isPlcDid(claims.iss) && !isAtprotoWebDid(claims.iss)) throw refused("BadJwt", "The token's issuer isn't an account");
  const signed = new Uint8Array(new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
  if (!await verifiedBy(claims.iss, header.alg, bytes(encodedSignature), signed, ctx)) {
    throw refused("BadJwtSignature", "The token's signature doesn't verify");
  }
  if (!ctx.shipCallNonces.spend(claims.iss, claims.jti, (claims.exp + CLOCK_LEEWAY_S) * 1_000, Date.now())) {
    throw refused("BadJwt", "The token was already used");
  }
  return claims.iss;
}

async function verifiedBy(
  did: string,
  alg: "ES256K" | "ES256",
  signature: Uint8Array<ArrayBuffer>,
  signed: Uint8Array<ArrayBuffer>,
  ctx: KernelContext,
): Promise<boolean> {
  if (!isDidCached(did, ctx)) admitLookup(ctx);
  const cached = await caller(did, ctx);
  if (await signs(cached, alg, signature, signed)) return true;
  // The caller may have rotated its key since the document was cached.
  admitLookup(ctx);
  const current = await caller(did, ctx, true);
  const rotated = current.signingKey.publicKeyMultibase !== cached.signingKey.publicKeyMultibase;
  return rotated && await signs(current, alg, signature, signed);
}

async function caller(did: string, ctx: KernelContext, refresh = false): Promise<ResolvedDid> {
  try {
    return await resolveDid(did, ctx, { refresh });
  } catch (error) {
    if (error instanceof DidNotResolvedError) throw refused("BadJwt", "The token's issuer doesn't resolve");
    if (error instanceof DidDirectoryUnavailableError) {
      throw new ShipXrpcError(503, "UpstreamFailure", "The caller's identity can't be checked right now", 30_000);
    }
    throw error;
  }
}

async function signs(
  resolved: ResolvedDid,
  alg: "ES256K" | "ES256",
  signature: Uint8Array<ArrayBuffer>,
  signed: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const key = signingKeyOf(resolved);
  // A signature that isn't a 64-byte compact one fails rather than throws.
  return key.jwtAlg === alg && await verifySig(key, signature, signed).catch(() => false);
}

function admitLookup(ctx: KernelContext): void {
  const now = Date.now();
  const retryAt = ctx.federation.consumeRateLimits([{
    scope: "installation",
    operation: "ship.caller.lookup",
    maximum: MAX_LOOKUPS_PER_MINUTE,
    windowMs: 60_000,
  }], now);
  if (retryAt !== null) throw new ShipXrpcError(429, "RateLimitExceeded", "Too many unknown callers; try again shortly", retryAt - now);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match?.[1]) throw refused("AuthMissing", "This method needs service auth");
  if (match[1].length > MAX_TOKEN_BYTES) throw refused("BadJwt", "The token is too long");
  return match[1];
}

function segment<T>(schema: z.ZodMiniType<T>, encoded: string): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes(encoded)));
  } catch {
    throw refused("BadJwt", "The token isn't a JWT");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw refused("BadJwt", "The token's header or claims are invalid");
  return parsed.data;
}

function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  try {
    return fromBase64Url(encoded);
  } catch {
    throw refused("BadJwt", "The token isn't a JWT");
  }
}

function refused(error: string, message: string): ShipXrpcError {
  return new ShipXrpcError(401, error, message);
}
