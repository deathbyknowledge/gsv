import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { PasskeyAuthenticationOptions, PasskeyAuthenticationResponse, PasskeyRegistrationOptions, PasskeyRegistrationResponse } from "@humansandmachines/gsv/protocol";

function join(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

async function authenticatorData(rpId: string, flags: number, counter: number) {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const suffix = new Uint8Array(5);
  suffix[0] = flags;
  new DataView(suffix.buffer).setUint32(1, counter);
  return join(rpHash, suffix);
}

/** Test authenticator with a real ES256 key and WebAuthn attestation/assertion encoding. */
export async function virtualPasskey(options: PasskeyRegistrationOptions, origin: string) {
  // SAFETY: ECDSA generates an asymmetric pair; Workers exposes a broad algorithm-independent overload.
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  // SAFETY: the explicit jwk format returns a JSON key rather than binary key bytes.
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error("ES256 public key coordinates missing");
  const coseKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)],
  ]));
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const id = isoBase64URL.fromBuffer(credentialId);
  const attestationData = join(await authenticatorData(options.rp.id!, 0x45, 0), new Uint8Array(16), new Uint8Array([0, credentialId.length]), credentialId, coseKey);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([
    ["fmt", "none"], ["attStmt", new Map()], ["authData", attestationData],
  ]));
  const registration: PasskeyRegistrationResponse = {
    id, rawId: id, type: "public-key", clientExtensionResults: {},
    response: { attestationObject: isoBase64URL.fromBuffer(attestation), transports: ["internal"],
      clientDataJSON: isoBase64URL.fromUTF8String(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false })) },
  };

  async function authenticate(request: PasskeyAuthenticationOptions, counter = 1, overrides: { origin?: string; rpId?: string; flags?: number; userHandle?: string } = {}): Promise<PasskeyAuthenticationResponse> {
    const clientDataJSON = isoBase64URL.fromUTF8String(JSON.stringify({ type: "webauthn.get", challenge: request.challenge, origin: overrides.origin ?? origin, crossOrigin: false }));
    const authData = await authenticatorData(overrides.rpId ?? request.rpId!, overrides.flags ?? 0x05, counter);
    const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", isoBase64URL.toBuffer(clientDataJSON)));
    const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, join(authData, clientHash)));
    const integer = (bytes: Uint8Array) => {
      let offset = 0;
      while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
      const value = bytes.slice(offset);
      const encoded = value[0] & 0x80 ? join(new Uint8Array([0]), value) : value;
      return join(new Uint8Array([0x02, encoded.length]), encoded);
    };
    const scalars = join(integer(rawSignature.slice(0, 32)), integer(rawSignature.slice(32)));
    const signature = join(new Uint8Array([0x30, scalars.length]), scalars);
    return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(signature), userHandle: overrides.userHandle ?? options.user.id } };
  }
  return { id, registration, authenticate };
}
