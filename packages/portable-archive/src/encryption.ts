import {
  ByteReader,
  type ByteSource,
  asAsyncBytes,
  concatBytes,
  decodeBase64Url,
  decodeU32,
  encodeBase64Url,
  encodeU32,
  equalBytes,
} from "./bytes";
import { canonicalJsonBytes, parseCanonicalJson } from "./canonical-json";
import {
  AES_256_KEY_BYTES,
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_PLAINTEXT_CHUNK_BYTES,
  FINAL_CHUNK_FLAG,
  GCM_NONCE_PREFIX_BYTES,
  GCM_TAG_BYTES,
  KNOWN_CHUNK_FLAGS,
  MAX_PLAINTEXT_CHUNK_BYTES,
  OUTER_MAGIC,
  PASSPHRASE_SCRYPT_PARAMETERS,
  PORTABLE_ARCHIVE_VERSION,
} from "./constants";
import {
  type PortableCrypto,
  copyBuffer,
  randomBytes,
  resolveCrypto,
  sha256,
} from "./crypto";
import { fail } from "./error";
import { PORTABLE_ARCHIVE_FORMAT } from "./manifest";

export type RecoveryKeyEnvelopeV1 = Readonly<{
  mode: "recovery-key";
}>;

export type PassphraseEnvelopeV1 = Readonly<{
  mode: "passphrase";
  kdf: "scrypt";
  N: 131072;
  r: 8;
  p: 1;
  salt: string;
}>;

export type OuterEnvelopeV1 = Readonly<{
  format: typeof PORTABLE_ARCHIVE_FORMAT;
  version: typeof PORTABLE_ARCHIVE_VERSION;
  cipher: "AES-256-GCM";
  chunkPlaintextBytes: number;
  noncePrefix: string;
  key: RecoveryKeyEnvelopeV1 | PassphraseEnvelopeV1;
}>;

export type EnvelopeOptions = Readonly<{
  chunkPlaintextBytes?: number;
  noncePrefix?: Uint8Array;
  crypto?: PortableCrypto;
}>;

export type OuterArchiveOptions = Readonly<{
  crypto?: PortableCrypto;
  maxEnvelopeBytes?: number;
}>;

export function generateRecoveryKey(provider?: PortableCrypto): Uint8Array {
  return randomBytes(AES_256_KEY_BYTES, provider);
}

export function createRecoveryKeyEnvelope(
  options: EnvelopeOptions = {},
): OuterEnvelopeV1 {
  return createEnvelope({ mode: "recovery-key" }, options);
}

export function createPassphraseEnvelope(
  options: EnvelopeOptions & Readonly<{ salt?: Uint8Array }> = {},
): OuterEnvelopeV1 {
  const salt = options.salt ?? randomBytes(16, options.crypto);
  if (salt.byteLength !== 16) {
    fail("invalid_argument", "v1 passphrase salt must be exactly 16 bytes");
  }
  return createEnvelope(
    {
      mode: "passphrase",
      kdf: "scrypt",
      ...PASSPHRASE_SCRYPT_PARAMETERS,
      salt: encodeBase64Url(salt),
    },
    options,
  );
}

export async function* encryptOuterArchiveWithKey(
  plaintext: ByteSource,
  rawKey: Uint8Array,
  envelope: OuterEnvelopeV1,
  options: OuterArchiveOptions = {},
): AsyncGenerator<Uint8Array> {
  assertRawKey(rawKey);
  assertOuterEnvelope(envelope);
  const maxEnvelopeBytes = resolveMaxEnvelopeBytes(options.maxEnvelopeBytes);
  const envelopeBytes = canonicalJsonBytes(envelope, { maxBytes: maxEnvelopeBytes });
  const envelopeDigest = await sha256(envelopeBytes, options.crypto);
  const key = await importAesKey(rawKey, options.crypto);
  const noncePrefix = decodeBase64Url(envelope.noncePrefix);

  yield OUTER_MAGIC;
  yield encodeU32(envelopeBytes.byteLength);
  yield envelopeBytes;

  const chunks = plaintextChunks(plaintext, envelope.chunkPlaintextBytes);
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    let current = await iterator.next();
    let counter = 0;
    while (!current.done) {
      const next = await iterator.next();
      const final = next.done;
      const flags = final ? FINAL_CHUNK_FLAG : 0;
      const counterBytes = encodeU32(counter);
      const plainLengthBytes = encodeU32(current.value.byteLength);
      const nonce = concatBytes([noncePrefix, counterBytes]);
      const additionalData = concatBytes([
        OUTER_MAGIC,
        envelopeDigest,
        counterBytes,
        plainLengthBytes,
        new Uint8Array([flags]),
      ]);
      let encrypted: ArrayBuffer;
      try {
        encrypted = await resolveCrypto(options.crypto).subtle.encrypt(
          {
            name: "AES-GCM",
            iv: copyBuffer(nonce),
            additionalData: copyBuffer(additionalData),
            tagLength: 128,
          },
          key,
          copyBuffer(current.value),
        );
      } catch (error) {
        fail("invalid_argument", `AES-GCM encryption failed: ${String(error)}`);
      }
      const ciphertext = new Uint8Array(encrypted);
      if (ciphertext.byteLength !== current.value.byteLength + GCM_TAG_BYTES) {
        fail("integrity_error", "Web Crypto returned an unexpected GCM ciphertext length");
      }
      yield concatBytes([plainLengthBytes, new Uint8Array([flags]), ciphertext]);
      if (final) return;
      if (counter === 0xffff_ffff) {
        fail("limit_exceeded", "outer archive chunk counter overflowed");
      }
      counter += 1;
      current = next;
    }
    fail("integrity_error", "plaintext chunker did not produce a final chunk");
  } finally {
    await iterator.return?.(undefined).catch(() => undefined);
  }
}

export async function* decryptOuterArchiveWithKey(
  source: ByteSource,
  rawKey: Uint8Array,
  options: OuterArchiveOptions = {},
): AsyncGenerator<Uint8Array, OuterEnvelopeV1> {
  assertRawKey(rawKey);
  const reader = new ByteReader(source);
  try {
    return yield* decryptOuterArchiveFromReader(reader, rawKey, options);
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function* decryptOuterArchiveFromReader(
  reader: ByteReader,
  rawKey: Uint8Array,
  options: OuterArchiveOptions,
): AsyncGenerator<Uint8Array, OuterEnvelopeV1> {
  const magic = await reader.readExactly(OUTER_MAGIC.byteLength, "outer archive magic");
  if (!equalBytes(magic, OUTER_MAGIC)) {
    fail("invalid_magic", "outer archive magic or version is invalid");
  }
  const envelopeLength = decodeU32(
    await reader.readExactly(4, "outer archive envelope length"),
  );
  const maxEnvelopeBytes = resolveMaxEnvelopeBytes(options.maxEnvelopeBytes);
  if (envelopeLength === 0 || envelopeLength > maxEnvelopeBytes) {
    fail("limit_exceeded", "outer archive envelope exceeds its configured limit");
  }
  const envelopeBytes = await reader.readExactly(envelopeLength, "outer archive envelope");
  const envelopeValue = parseCanonicalJson(envelopeBytes, { maxBytes: maxEnvelopeBytes });
  assertOuterEnvelope(envelopeValue);
  const envelope = envelopeValue;
  const envelopeDigest = await sha256(envelopeBytes, options.crypto);
  const noncePrefix = decodeBase64Url(envelope.noncePrefix);
  const key = await importAesKey(rawKey, options.crypto);

  let counter = 0;
  while (true) {
    const plainLengthBytes = await reader.readExactly(4, "outer archive chunk length");
    const plainLength = decodeU32(plainLengthBytes);
    const flagsBytes = await reader.readExactly(1, "outer archive chunk flags");
    const flags = flagsBytes[0];
    if ((flags & ~KNOWN_CHUNK_FLAGS) !== 0) {
      fail("invalid_envelope", "outer archive chunk contains unknown flags");
    }
    const final = (flags & FINAL_CHUNK_FLAG) !== 0;
    if (plainLength > envelope.chunkPlaintextBytes) {
      fail("limit_exceeded", "outer archive chunk exceeds the envelope limit");
    }
    if (!final && plainLength !== envelope.chunkPlaintextBytes) {
      fail("invalid_envelope", "non-final outer archive chunks must be full-sized");
    }
    const ciphertext = await reader.readExactly(
      plainLength + GCM_TAG_BYTES,
      "outer archive ciphertext",
    );
    const counterBytes = encodeU32(counter);
    const nonce = concatBytes([noncePrefix, counterBytes]);
    const additionalData = concatBytes([
      OUTER_MAGIC,
      envelopeDigest,
      counterBytes,
      plainLengthBytes,
      flagsBytes,
    ]);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await resolveCrypto(options.crypto).subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copyBuffer(nonce),
          additionalData: copyBuffer(additionalData),
          tagLength: 128,
        },
        key,
        copyBuffer(ciphertext),
      );
    } catch (error) {
      fail("integrity_error", `outer archive authentication failed: ${String(error)}`);
    }
    const decoded = new Uint8Array(plaintext);
    if (decoded.byteLength !== plainLength) {
      fail("integrity_error", "decrypted outer archive chunk has the wrong length");
    }
    yield decoded;
    if (final) {
      await reader.requireEnd();
      return envelope;
    }
    if (counter === 0xffff_ffff) {
      fail("limit_exceeded", "outer archive chunk counter overflowed");
    }
    counter += 1;
  }
}

export function assertOuterEnvelope(value: unknown): asserts value is OuterEnvelopeV1 {
  const envelope = expectRecord(value, "outer envelope");
  expectExactKeys(
    envelope,
    ["format", "version", "cipher", "chunkPlaintextBytes", "noncePrefix", "key"],
    "outer envelope",
  );
  if (
    envelope.format !== PORTABLE_ARCHIVE_FORMAT ||
    envelope.version !== 1 ||
    envelope.cipher !== "AES-256-GCM"
  ) {
    fail("invalid_envelope", "outer envelope has an unsupported format or cipher");
  }
  validateChunkSize(envelope.chunkPlaintextBytes);
  if (typeof envelope.noncePrefix !== "string") {
    fail("invalid_envelope", "outer envelope noncePrefix must be a string");
  }
  let noncePrefix: Uint8Array;
  try {
    noncePrefix = decodeBase64Url(envelope.noncePrefix);
  } catch (error) {
    fail("invalid_envelope", `outer envelope noncePrefix is invalid: ${String(error)}`);
  }
  if (noncePrefix.byteLength !== GCM_NONCE_PREFIX_BYTES) {
    fail("invalid_envelope", "outer envelope noncePrefix must be eight bytes");
  }
  const key = expectRecord(envelope.key, "outer envelope key metadata");
  if (key.mode === "recovery-key") {
    expectExactKeys(key, ["mode"], "recovery key metadata");
  } else if (key.mode === "passphrase") {
    expectExactKeys(key, ["mode", "kdf", "N", "r", "p", "salt"], "passphrase metadata");
    if (
      key.kdf !== "scrypt" ||
      key.N !== PASSPHRASE_SCRYPT_PARAMETERS.N ||
      key.r !== PASSPHRASE_SCRYPT_PARAMETERS.r ||
      key.p !== PASSPHRASE_SCRYPT_PARAMETERS.p ||
      typeof key.salt !== "string"
    ) {
      fail("invalid_envelope", "v1 passphrase metadata must use the fixed scrypt profile");
    }
    let salt: Uint8Array;
    try {
      salt = decodeBase64Url(key.salt);
    } catch (error) {
      fail("invalid_envelope", `passphrase salt is invalid: ${String(error)}`);
    }
    if (salt.byteLength !== 16) {
      fail("invalid_envelope", "v1 passphrase salt must be exactly 16 bytes");
    }
  } else {
    fail("invalid_envelope", "outer envelope has an unknown key mode");
  }
}

function createEnvelope(
  key: RecoveryKeyEnvelopeV1 | PassphraseEnvelopeV1,
  options: EnvelopeOptions,
): OuterEnvelopeV1 {
  const chunkPlaintextBytes =
    options.chunkPlaintextBytes ?? DEFAULT_PLAINTEXT_CHUNK_BYTES;
  validateChunkSize(chunkPlaintextBytes);
  const noncePrefix =
    options.noncePrefix ?? randomBytes(GCM_NONCE_PREFIX_BYTES, options.crypto);
  if (noncePrefix.byteLength !== GCM_NONCE_PREFIX_BYTES) {
    fail("invalid_argument", "GCM nonce prefix must be exactly eight bytes");
  }
  const envelope: OuterEnvelopeV1 = {
    format: PORTABLE_ARCHIVE_FORMAT,
    version: 1,
    cipher: "AES-256-GCM",
    chunkPlaintextBytes,
    noncePrefix: encodeBase64Url(noncePrefix),
    key,
  };
  assertOuterEnvelope(envelope);
  return envelope;
}

async function importAesKey(
  rawKey: Uint8Array,
  provider?: PortableCrypto,
): Promise<CryptoKey> {
  try {
    return await resolveCrypto(provider).subtle.importKey(
      "raw",
      copyBuffer(rawKey),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    fail("invalid_argument", `AES-256 key import failed: ${String(error)}`);
  }
}

async function* plaintextChunks(
  source: ByteSource,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(chunkSize);
  let used = 0;
  let produced = false;
  for await (const input of asAsyncBytes(source)) {
    let offset = 0;
    while (offset < input.byteLength) {
      const count = Math.min(chunkSize - used, input.byteLength - offset);
      buffer.set(input.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === chunkSize) {
        yield buffer;
        produced = true;
        buffer = new Uint8Array(chunkSize);
        used = 0;
      }
    }
  }
  if (used > 0) {
    yield buffer.slice(0, used);
  } else if (!produced) {
    yield new Uint8Array(0);
  }
}

function validateChunkSize(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PLAINTEXT_CHUNK_BYTES
  ) {
    fail("invalid_envelope", "chunkPlaintextBytes must be between 1 and 4 MiB");
  }
}

function assertRawKey(rawKey: Uint8Array): void {
  if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== AES_256_KEY_BYTES) {
    fail("invalid_argument", "AES-256 recovery or derived key must be exactly 32 bytes");
  }
}

function resolveMaxEnvelopeBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_ENVELOPE_BYTES;
  if (!Number.isSafeInteger(result) || result < 1 || result > 1024 * 1024) {
    fail("invalid_argument", "maxEnvelopeBytes must be between 1 and 1 MiB");
  }
  return result;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_envelope", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid_envelope", `${label} has unexpected or missing fields`);
  }
}
