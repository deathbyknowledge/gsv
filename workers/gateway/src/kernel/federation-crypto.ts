import type {
  FederationPublicKey,
  FederationShipDocument,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonPrimitiveSchema,
} from "@humansandmachines/gsv/protocol";

const FEDERATION_IDENTITY_KEY = "federation_identity_v1";
const encoder = new TextEncoder();

type FederationPrivateKey = FederationPublicKey & { d: string };

type StoredFederationIdentity = {
  privateKey: FederationPrivateKey;
  document: FederationShipDocument;
};

export class FederationIdentity {
  constructor(private readonly storage: DurableObjectStorage) {}

  async ensure(originValue: string): Promise<FederationShipDocument> {
    const origin = normalizeFederationOrigin(originValue);
    const existing = this.storage.kv.get<StoredFederationIdentity>(FEDERATION_IDENTITY_KEY);
    if (existing) {
      if (existing.document.origin !== origin) {
        throw new Error("Federation identity origin conflicts with the installation origin");
      }
      await verifyShipDocument(existing.document);
      return existing.document;
    }

    // SAFETY: ECDSA key generation with both sign and verify usages returns a CryptoKeyPair.
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    // SAFETY: exporting a WebCrypto key with the jwk format returns a JsonWebKey.
    const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
    // SAFETY: exporting a WebCrypto key with the jwk format returns a JsonWebKey.
    const exportedPrivate = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
    const publicKey = normalizePublicKey(exportedPublic);
    const privateKey: FederationPrivateKey = {
      ...publicKey,
      d: requireJwkString(exportedPrivate.d, "d"),
    };
    const shipId = `ship:${await sha256Base64Url(canonicalBytes(publicKey))}`;
    const issuedAtMs = Date.now();
    const unsigned: JsonValue = {
      version: 1,
      shipId,
      origin,
      publicKey: publicKeyJson(publicKey),
      protocols: ["gsv-federation/1"],
      issuedAtMs,
    };
    const document: FederationShipDocument = {
      version: 1,
      shipId,
      origin,
      publicKey,
      protocols: ["gsv-federation/1"],
      issuedAtMs,
      signature: await signEcdsa(privateKey, unsigned),
    };
    this.storage.kv.put(FEDERATION_IDENTITY_KEY, { privateKey, document });
    return document;
  }

  async sign(value: JsonValue): Promise<string> {
    const identity = this.storage.kv.get<StoredFederationIdentity>(FEDERATION_IDENTITY_KEY);
    if (!identity) throw new Error("Federation identity is not initialized");
    return signEcdsa(identity.privateKey, value);
  }
}

export async function verifyShipDocument(
  document: FederationShipDocument,
): Promise<void> {
  const origin = normalizeFederationOrigin(document.origin);
  if (origin !== document.origin) throw new Error("Ship document origin is not canonical");
  const expectedShipId = `ship:${await sha256Base64Url(canonicalBytes(document.publicKey))}`;
  if (document.shipId !== expectedShipId) {
    throw new Error("Ship document identity does not match its public key");
  }
  const unsigned = shipDocumentJson(document);
  if (!await verifyEcdsa(document.publicKey, unsigned, document.signature)) {
    throw new Error("Ship document signature is invalid");
  }
}

export async function verifySignedValue(
  publicKey: FederationPublicKey,
  value: JsonValue,
  signature: string,
): Promise<boolean> {
  return verifyEcdsa(publicKey, value, signature);
}

export async function deriveContactSecret(
  token: string,
  firstShipId: string,
  secondShipId: string,
): Promise<string> {
  const tokenBytes = base64UrlDecode(token);
  if (tokenBytes.byteLength !== 32) throw new Error("Federation invite token is invalid");
  const ships = [firstShipId, secondShipId].sort().join("\n");
  const material = await crypto.subtle.importKey("raw", tokenBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: await crypto.subtle.digest("SHA-256", encoder.encode(ships)),
    info: encoder.encode("gsv-federation-v1-contact"),
  }, material, 256);
  return base64UrlEncode(new Uint8Array(bits));
}

export async function signContactEnvelope(
  sharedSecret: string,
  value: JsonValue,
): Promise<string> {
  const key = await importHmacKey(sharedSecret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, canonicalBytes(value));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyContactEnvelope(
  sharedSecret: string,
  value: JsonValue,
  signature: string,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(signature);
  } catch {
    return false;
  }
  const key = await importHmacKey(sharedSecret, ["verify"]);
  return crypto.subtle.verify("HMAC", key, bytes, canonicalBytes(value));
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function canonicalJson(value: JsonValue): string {
  const primitive = jsonPrimitiveSchema.safeParse(value);
  if (primitive.success) {
    return JSON.stringify(primitive.data);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = jsonObjectSchema.parse(value);
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

export function normalizeFederationOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Federation origin must contain only scheme and authority");
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Federation origin must use HTTPS");
  }
  return url.origin;
}

function canonicalBytes(value: JsonValue): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

async function signEcdsa(
  privateKey: FederationPrivateKey,
  value: JsonValue,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...privateKey, key_ops: ["sign"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    canonicalBytes(value),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyEcdsa(
  publicKey: FederationPublicKey,
  value: JsonValue,
  signature: string,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...publicKey, key_ops: ["verify"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    bytes,
    canonicalBytes(value),
  );
}

async function importHmacKey(
  sharedSecret: string,
  usages: Array<"sign" | "verify">,
): Promise<CryptoKey> {
  const raw = base64UrlDecode(sharedSecret);
  if (raw.byteLength !== 32) throw new Error("Federation contact secret is invalid");
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function shipDocumentJson(document: FederationShipDocument): JsonValue {
  return {
    version: document.version,
    shipId: document.shipId,
    origin: document.origin,
    publicKey: publicKeyJson(document.publicKey),
    protocols: [...document.protocols],
    issuedAtMs: document.issuedAtMs,
  };
}

function publicKeyJson(publicKey: FederationPublicKey): JsonValue {
  return {
    kty: publicKey.kty,
    crv: publicKey.crv,
    x: publicKey.x,
    y: publicKey.y,
  };
}

function normalizePublicKey(value: JsonWebKey): FederationPublicKey {
  if (value.kty !== "EC" || value.crv !== "P-256") {
    throw new Error("Federation identity generated an unsupported public key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: requireJwkString(value.x, "x"),
    y: requireJwkString(value.y, "y"),
  };
}

function requireJwkString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Federation identity key is missing ${field}`);
  return value;
}
