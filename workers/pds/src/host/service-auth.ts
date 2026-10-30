import { Secp256k1PrivateKey } from "@atcute/crypto";
import { isDid, isNsid } from "@atcute/lexicons/syntax";
import { fromBase16, toBase64Url } from "@atcute/multibase";

/** How long a token lives; ATProto recommends about a minute. */
export const SERVICE_AUTH_TTL_SECONDS = 60;

/** One call the account signs for: the receiving service's DID, with its service fragment, and the method. */
export type ServiceAuthRequest = { aud: string; lxm: string };

const encoder = new TextEncoder();

/**
 * Signs an ATProto service-auth token with the account's signing key. Each
 * token carries a fresh `jti`, so a receiver that remembers them accepts it once.
 */
export async function signServiceAuth(
  iss: string,
  signingKey: string,
  { aud, lxm }: ServiceAuthRequest,
  now = Date.now(),
): Promise<string> {
  const [audienceDid, ...fragment] = aud.split("#");
  if (!isDid(audienceDid) || fragment.length > 1) throw new Error(`InvalidRequest: ${aud} is not a service DID`);
  if (!isNsid(lxm)) throw new Error(`InvalidRequest: ${lxm} is not a method`);
  const iat = Math.floor(now / 1000);
  const jti = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const signingInput = `${segment({ typ: "JWT", alg: "ES256K" })}.${segment({ iss, aud, lxm, iat, exp: iat + SERVICE_AUTH_TTL_SECONDS, jti })}`;
  const key = await Secp256k1PrivateKey.importRaw(fromBase16(signingKey));
  return `${signingInput}.${toBase64Url(await key.sign(encoder.encode(signingInput)))}`;
}

function segment(value: Record<string, string | number>): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}
