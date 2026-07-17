import { describe, expect, it } from "vitest";
import {
  OUTER_MAGIC,
  collectBytes,
  createPassphraseEnvelope,
  createRecoveryKeyEnvelope,
  decodeU32,
  decryptOuterArchiveWithKey,
  encodeBase64Url,
  encryptOuterArchiveWithKey,
} from "../src/index";
import { fragment } from "./support";

const key = new Uint8Array(32).map((_, index) => index);
const noncePrefix = new Uint8Array(8).map((_, index) => index + 8);

describe("outer AES-256-GCM container", () => {
  it("round trips fragmented plaintext and ciphertext with authenticated chunk metadata", async () => {
    const plaintext = new Uint8Array(777).map((_, index) => index % 251);
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 128,
      noncePrefix,
    });
    const encrypted = await collectBytes(
      encryptOuterArchiveWithKey(fragment(plaintext, 17), key, envelope),
    );
    expect(encrypted.subarray(0, OUTER_MAGIC.byteLength)).toEqual(OUTER_MAGIC);
    const decrypted = await collectBytes(
      decryptOuterArchiveWithKey(fragment(encrypted, 3), key),
    );
    expect(decrypted).toEqual(plaintext);
  });

  it("supports the fixed v1 passphrase metadata without pretending Web Crypto supplies scrypt", () => {
    const envelope = createPassphraseEnvelope({
      chunkPlaintextBytes: 1024,
      noncePrefix,
      salt: new Uint8Array(16).fill(7),
    });
    expect(envelope.key).toEqual({
      mode: "passphrase",
      kdf: "scrypt",
      N: 131072,
      r: 8,
      p: 1,
      salt: encodeBase64Url(new Uint8Array(16).fill(7)),
    });
  });

  it("rejects wrong keys, modified ciphertext, truncation, and trailing bytes", async () => {
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 64,
      noncePrefix,
    });
    const encrypted = await collectBytes(
      encryptOuterArchiveWithKey(new Uint8Array([1, 2, 3]), key, envelope),
    );
    const wrongKey = key.slice();
    wrongKey[0] ^= 1;
    await expect(collectBytes(decryptOuterArchiveWithKey(encrypted, wrongKey))).rejects.toMatchObject({
      code: "integrity_error",
    });
    const modified = encrypted.slice();
    modified[modified.byteLength - 1] ^= 1;
    await expect(collectBytes(decryptOuterArchiveWithKey(modified, key))).rejects.toMatchObject({
      code: "integrity_error",
    });
    await expect(
      collectBytes(decryptOuterArchiveWithKey(encrypted.subarray(0, encrypted.byteLength - 1), key)),
    ).rejects.toMatchObject({ code: "truncated_archive" });
    const trailing = new Uint8Array(encrypted.byteLength + 1);
    trailing.set(encrypted);
    await expect(collectBytes(decryptOuterArchiveWithKey(trailing, key))).rejects.toMatchObject({
      code: "trailing_data",
    });
  });

  it("emits one authenticated final chunk for an empty plaintext", async () => {
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 64,
      noncePrefix,
    });
    const encrypted = await collectBytes(
      encryptOuterArchiveWithKey(new Uint8Array(0), key, envelope),
    );
    expect(await collectBytes(decryptOuterArchiveWithKey(encrypted, key))).toEqual(
      new Uint8Array(0),
    );
  });

  it("rejects noncanonical envelopes and invalid chunk flags before decryption", async () => {
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 64,
      noncePrefix,
    });
    const encrypted = await collectBytes(
      encryptOuterArchiveWithKey(new Uint8Array([1, 2, 3]), key, envelope),
    );
    const envelopeLength = decodeU32(
      encrypted.subarray(OUTER_MAGIC.byteLength, OUTER_MAGIC.byteLength + 4),
    );
    const chunkOffset = OUTER_MAGIC.byteLength + 4 + envelopeLength;
    const badFlags = encrypted.slice();
    badFlags[chunkOffset + 4] |= 0x80;
    await expect(collectBytes(decryptOuterArchiveWithKey(badFlags, key))).rejects.toMatchObject({
      code: "invalid_envelope",
    });

    const noncanonical = new Uint8Array(encrypted.byteLength + 1);
    noncanonical.set(encrypted.subarray(0, OUTER_MAGIC.byteLength));
    const longerLength = new Uint8Array(4);
    new DataView(longerLength.buffer).setUint32(0, envelopeLength + 1, false);
    noncanonical.set(longerLength, OUTER_MAGIC.byteLength);
    const envelopeOffset = OUTER_MAGIC.byteLength + 4;
    noncanonical[envelopeOffset] = 0x20;
    noncanonical.set(
      encrypted.subarray(envelopeOffset, envelopeOffset + envelopeLength),
      envelopeOffset + 1,
    );
    noncanonical.set(encrypted.subarray(chunkOffset), chunkOffset + 1);
    await expect(
      collectBytes(decryptOuterArchiveWithKey(noncanonical, key)),
    ).rejects.toMatchObject({ code: "noncanonical_json" });
  });

  it("closes owned byte sources on authentication failure and early consumer exit", async () => {
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 16,
      noncePrefix,
    });
    const encrypted = await collectBytes(
      encryptOuterArchiveWithKey(new Uint8Array(48).fill(7), key, envelope),
    );
    const modified = encrypted.slice();
    modified[modified.byteLength - 1] ^= 1;
    const rejected = trackedSource([modified]);
    await expect(
      collectBytes(decryptOuterArchiveWithKey(rejected.source, key)),
    ).rejects.toMatchObject({ code: "integrity_error" });
    expect(rejected.closed()).toBe(true);

    const decryptSource = trackedSource([encrypted]);
    const decrypt = decryptOuterArchiveWithKey(decryptSource.source, key);
    await expect(decrypt.next()).resolves.toMatchObject({ done: false });
    await decrypt.return(envelope);
    expect(decryptSource.closed()).toBe(true);

    const encryptSource = trackedSource([
      new Uint8Array(64).fill(1),
      new Uint8Array(64).fill(2),
    ]);
    const encrypt = encryptOuterArchiveWithKey(encryptSource.source, key, envelope);
    await encrypt.next();
    await encrypt.next();
    await encrypt.next();
    await expect(encrypt.next()).resolves.toMatchObject({ done: false });
    await encrypt.return(undefined);
    expect(encryptSource.closed()).toBe(true);
  });
});

function trackedSource(chunks: readonly Uint8Array[]): Readonly<{
  source: AsyncGenerator<Uint8Array>;
  closed(): boolean;
}> {
  let closed = false;
  const source = (async function* () {
    try {
      for (const chunk of chunks) yield chunk;
    } finally {
      closed = true;
    }
  })();
  return { source, closed: () => closed };
}
