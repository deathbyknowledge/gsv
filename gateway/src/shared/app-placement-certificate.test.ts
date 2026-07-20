import { describe, expect, it } from "vitest";
import {
  appPlacementVerificationKeyRecord,
  generateAppPlacementSigningKeyRecord,
  importAppPlacementSigningKey,
  importAppPlacementVerificationKey,
  isAppPlacementCertificate,
  parseAppPlacementSigningKeyRecord,
  parseSerializedAppPlacementVerificationKeyRecord,
  serializeAppPlacementVerificationKeyRecord,
  signAppPlacementCertificate,
  verifyAppPlacementCertificate,
} from "./app-placement-certificate";

const PLACEMENT = {
  username: "alice",
  uid: 1000,
  generation: 7,
};

describe("app placement certificates", () => {
  it("signs one canonical username, uid, and generation tuple", async () => {
    const record = await generateAppPlacementSigningKeyRecord();
    const certificate = await signAppPlacementCertificate(
      await importAppPlacementSigningKey(record),
      PLACEMENT,
    );
    const verifier = await importAppPlacementVerificationKey(
      appPlacementVerificationKeyRecord(record),
    );

    expect(isAppPlacementCertificate(certificate)).toBe(true);
    await expect(verifyAppPlacementCertificate(
      verifier,
      PLACEMENT,
      certificate,
    )).resolves.toBe(true);
    for (const forged of [
      { ...PLACEMENT, username: "bob" },
      { ...PLACEMENT, uid: 1001 },
      { ...PLACEMENT, generation: 8 },
    ]) {
      await expect(verifyAppPlacementCertificate(
        verifier,
        forged,
        certificate,
      )).resolves.toBe(false);
    }
  });

  it("rejects non-canonical encodings and malformed key records", async () => {
    const record = await generateAppPlacementSigningKeyRecord();
    const certificate = await signAppPlacementCertificate(
      await importAppPlacementSigningKey(record),
      PLACEMENT,
    );
    const nonCanonicalLastCharacter: Record<string, string> = {
      A: "B",
      Q: "R",
      g: "h",
      w: "x",
    };
    const last = certificate.at(-1)!;
    const nonCanonical = `${certificate.slice(0, -1)}${nonCanonicalLastCharacter[last]}`;

    expect(isAppPlacementCertificate(nonCanonical)).toBe(false);
    expect(parseAppPlacementSigningKeyRecord({ ...record, extra: true })).toBeNull();
    expect(parseAppPlacementSigningKeyRecord({
      ...record,
      privateKeyPkcs8: `${record.privateKeyPkcs8}=`,
    })).toBeNull();

    const publicRecord = appPlacementVerificationKeyRecord(record);
    const serialized = serializeAppPlacementVerificationKeyRecord(publicRecord);
    expect(parseSerializedAppPlacementVerificationKeyRecord(serialized))
      .toEqual(publicRecord);
    expect(parseSerializedAppPlacementVerificationKeyRecord(
      JSON.stringify({ ...publicRecord, privateKeyPkcs8: record.privateKeyPkcs8 }),
    )).toBeNull();
  });
});
