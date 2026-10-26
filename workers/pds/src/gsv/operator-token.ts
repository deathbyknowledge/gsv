import { Secp256k1PrivateKey } from "@atcute/crypto";
import { fromBase16, fromBase64Url, toBase64Url } from "@atcute/multibase";
import * as z from "zod/mini";

/**
 * Tokens that authorize an operator's request to the host, signed with the
 * host's PLC rotation key: whoever holds that key already controls every DID
 * the host registers. This module imports only packages, so the operator's
 * command runs it under Node too.
 */

/** How long a token lasts. */
export const OPERATOR_TOKEN_TTL_SECONDS = 60;

const actionSchema = z.enum(["status", "create", "publish"]);
const headerSchema = z.object({ alg: z.literal("ES256K"), typ: z.literal("JWT") });
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  act: actionSchema,
  /** The handle the operator expects the account to have; creating the account requires it. */
  handle: z.optional(z.string()),
  iat: z.int(),
  exp: z.int(),
});

/** What an operator asks of the host's lexicon account. */
export type LexiconAction = z.infer<typeof actionSchema>;

export type OperatorClaims = z.infer<typeof claimsSchema>;

/** One operator request: the host's origin, what to do and, to create the account, its handle. */
export type OperatorRequest = { aud: string; act: LexiconAction; handle?: string };

/** A token the host refuses. */
export class OperatorTokenError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Signs a token for one request with the host's rotation key, given as hex. */
export async function signOperatorToken(rotationKey: string, { aud, act, handle }: OperatorRequest, now = Date.now()): Promise<string> {
  const key = await Secp256k1PrivateKey.importRaw(fromBase16(rotationKey));
  const iat = Math.floor(now / 1000);
  const claims: OperatorClaims = { iss: await key.exportPublicKey("did"), aud, act, handle, iat, exp: iat + OPERATOR_TOKEN_TTL_SECONDS };
  const signingInput = `${segment(JSON.stringify({ alg: "ES256K", typ: "JWT" }))}.${segment(JSON.stringify(claims))}`;
  return `${signingInput}.${toBase64Url(await key.sign(encoder.encode(signingInput)))}`;
}

/**
 * The claims of a token the host's rotation key signed for the host at
 * `audience`, while it lasts. A token that lasts longer than the host would
 * sign one for is refused too.
 */
export async function verifyOperatorToken(rotationKey: string, token: string, audience: string, now = Date.now()): Promise<OperatorClaims> {
  const [header, payload, signature, ...rest] = token.split(".");
  if (!header || !payload || !signature || rest.length > 0) throw new OperatorTokenError("The token is not a JWT");
  let claims: OperatorClaims;
  let signed: Uint8Array;
  try {
    headerSchema.parse(JSON.parse(decoder.decode(fromBase64Url(header))));
    claims = claimsSchema.parse(JSON.parse(decoder.decode(fromBase64Url(payload))));
    signed = fromBase64Url(signature);
  } catch {
    throw new OperatorTokenError("The token is malformed");
  }
  const key = await Secp256k1PrivateKey.importRaw(fromBase16(rotationKey));
  if (claims.iss !== await key.exportPublicKey("did") || claims.aud !== audience) {
    throw new OperatorTokenError("The token is not for this host");
  }
  const at = Math.floor(now / 1000);
  if (claims.exp <= at || claims.exp > at + 2 * OPERATOR_TOKEN_TTL_SECONDS) {
    throw new OperatorTokenError("The token has expired, or lasts longer than the host allows");
  }
  if (!await key.verify(signed, encoder.encode(`${header}.${payload}`))) {
    throw new OperatorTokenError("The token's signature does not verify");
  }
  return claims;
}

function segment(json: string): string {
  return toBase64Url(encoder.encode(json));
}
