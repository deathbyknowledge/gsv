export const APP_PLACEMENT_VERIFICATION_KEY_OBJECT =
  "runtime/app-placement/verification-key-v1.json";

const APP_PLACEMENT_CERTIFICATE_DOMAIN = "gsv.app-placement-certificate.v1";
const APP_PLACEMENT_ALGORITHM = "ECDSA-P256-SHA256";
const P256_SIGNATURE_BYTES = 64;
const P256_SPKI_BYTES = 91;
const P256_PKCS8_BYTES = 138;
const TEXT_ENCODER = new TextEncoder();

export type AppPlacementTuple = {
  username: string;
  uid: number;
  generation: number;
};

export type AppPlacementVerificationKeyRecord = {
  version: 1;
  algorithm: typeof APP_PLACEMENT_ALGORITHM;
  publicKeySpki: string;
};

export type AppPlacementSigningKeyRecord = AppPlacementVerificationKeyRecord & {
  privateKeyPkcs8: string;
};

export function buildAppPlacementCertificatePayload(
  placement: AppPlacementTuple,
): Uint8Array {
  assertAppPlacementTuple(placement);
  return TEXT_ENCODER.encode([
    APP_PLACEMENT_CERTIFICATE_DOMAIN,
    placement.username,
    String(placement.uid),
    String(placement.generation),
  ].join("\n"));
}

export function isAppPlacementCertificate(value: unknown): value is string {
  return typeof value === "string"
    && decodeCanonicalBase64Url(value, P256_SIGNATURE_BYTES) !== null;
}

export function isCanonicalBase64Url(
  value: unknown,
  expectedBytes: number,
): value is string {
  return typeof value === "string"
    && decodeCanonicalBase64Url(value, expectedBytes) !== null;
}

export async function generateAppPlacementSigningKeyRecord(): Promise<
  AppPlacementSigningKeyRecord
> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const [privateKeyPkcs8, publicKeySpki] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("spki", pair.publicKey),
  ]) as [ArrayBuffer, ArrayBuffer];
  const record = {
    version: 1 as const,
    algorithm: APP_PLACEMENT_ALGORITHM,
    publicKeySpki: encodeBase64Url(new Uint8Array(publicKeySpki)),
    privateKeyPkcs8: encodeBase64Url(new Uint8Array(privateKeyPkcs8)),
  };
  const parsed = parseAppPlacementSigningKeyRecord(record);
  if (!parsed) {
    throw new Error("Generated app placement signing key is invalid");
  }
  return parsed;
}

export function appPlacementVerificationKeyRecord(
  record: AppPlacementSigningKeyRecord,
): AppPlacementVerificationKeyRecord {
  return {
    version: 1,
    algorithm: APP_PLACEMENT_ALGORITHM,
    publicKeySpki: record.publicKeySpki,
  };
}

export function parseAppPlacementSigningKeyRecord(
  value: unknown,
): AppPlacementSigningKeyRecord | null {
  if (!hasExactKeys(value, [
    "version",
    "algorithm",
    "publicKeySpki",
    "privateKeyPkcs8",
  ])) {
    return null;
  }
  const record = value as Partial<AppPlacementSigningKeyRecord>;
  if (
    record.version !== 1
    || record.algorithm !== APP_PLACEMENT_ALGORITHM
    || !isCanonicalBase64Url(record.publicKeySpki, P256_SPKI_BYTES)
    || !isCanonicalBase64Url(record.privateKeyPkcs8, P256_PKCS8_BYTES)
  ) {
    return null;
  }
  return record as AppPlacementSigningKeyRecord;
}

export function parseAppPlacementVerificationKeyRecord(
  value: unknown,
): AppPlacementVerificationKeyRecord | null {
  if (!hasExactKeys(value, ["version", "algorithm", "publicKeySpki"])) {
    return null;
  }
  const record = value as Partial<AppPlacementVerificationKeyRecord>;
  if (
    record.version !== 1
    || record.algorithm !== APP_PLACEMENT_ALGORITHM
    || !isCanonicalBase64Url(record.publicKeySpki, P256_SPKI_BYTES)
  ) {
    return null;
  }
  return record as AppPlacementVerificationKeyRecord;
}

export function serializeAppPlacementVerificationKeyRecord(
  record: AppPlacementVerificationKeyRecord,
): string {
  const parsed = parseAppPlacementVerificationKeyRecord(record);
  if (!parsed) {
    throw new Error("App placement verification key is invalid");
  }
  return JSON.stringify(parsed);
}

export function parseSerializedAppPlacementVerificationKeyRecord(
  value: string,
): AppPlacementVerificationKeyRecord | null {
  if (value.length > 512) return null;
  try {
    return parseAppPlacementVerificationKeyRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function importAppPlacementSigningKey(
  record: AppPlacementSigningKeyRecord,
): Promise<CryptoKey> {
  const parsed = parseAppPlacementSigningKeyRecord(record);
  if (!parsed) {
    throw new Error("App placement signing key is invalid");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    decodeCanonicalBase64Url(parsed.privateKeyPkcs8, P256_PKCS8_BYTES)!,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function importAppPlacementVerificationKey(
  record: AppPlacementVerificationKeyRecord,
): Promise<CryptoKey> {
  const parsed = parseAppPlacementVerificationKeyRecord(record);
  if (!parsed) {
    throw new Error("App placement verification key is invalid");
  }
  return crypto.subtle.importKey(
    "spki",
    decodeCanonicalBase64Url(parsed.publicKeySpki, P256_SPKI_BYTES)!,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export async function signAppPlacementCertificate(
  key: CryptoKey,
  placement: AppPlacementTuple,
): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    buildAppPlacementCertificatePayload(placement),
  ));
  if (signature.byteLength !== P256_SIGNATURE_BYTES) {
    throw new Error("App placement certificate signature is invalid");
  }
  return encodeBase64Url(signature);
}

export async function verifyAppPlacementCertificate(
  key: CryptoKey,
  placement: AppPlacementTuple,
  certificate: string,
): Promise<boolean> {
  const signature = decodeCanonicalBase64Url(
    certificate,
    P256_SIGNATURE_BYTES,
  );
  if (!signature) return false;
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      buildAppPlacementCertificatePayload(placement),
    );
  } catch {
    return false;
  }
}

function assertAppPlacementTuple(placement: AppPlacementTuple): void {
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(placement.username)
    || !Number.isSafeInteger(placement.uid)
    || placement.uid < 0
    || !Number.isSafeInteger(placement.generation)
    || placement.generation <= 0
  ) {
    throw new Error("Invalid app placement certificate tuple");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCanonicalBase64Url(
  value: string,
  expectedBytes: number,
): Uint8Array | null {
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes < 0
    || value.length !== Math.ceil(expectedBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === expectedBytes && encodeBase64Url(bytes) === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && expected.slice().sort().every((key, index) => key === keys[index]);
}
