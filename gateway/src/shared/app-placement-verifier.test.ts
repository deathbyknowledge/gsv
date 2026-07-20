import { describe, expect, it, vi } from "vitest";
import {
  appPlacementVerificationKeyRecord,
  generateAppPlacementSigningKeyRecord,
  importAppPlacementSigningKey,
  serializeAppPlacementVerificationKeyRecord,
  signAppPlacementCertificate,
} from "./app-placement-certificate";
import { verifyAppPlacementAtEdge } from "./app-placement-verifier";

const PLACEMENT = {
  username: "alice",
  uid: 1000,
  generation: 7,
};

function storedPublicKey(serialized: string): R2ObjectBody {
  return {
    size: serialized.length,
    text: async () => serialized,
  } as unknown as R2ObjectBody;
}

describe("edge app placement verification", () => {
  it("reloads a replaced trust anchor without selecting through Master", async () => {
    const first = await generateAppPlacementSigningKeyRecord();
    const second = await generateAppPlacementSigningKeyRecord();
    const firstCertificate = await signAppPlacementCertificate(
      await importAppPlacementSigningKey(first),
      PLACEMENT,
    );
    const secondCertificate = await signAppPlacementCertificate(
      await importAppPlacementSigningKey(second),
      PLACEMENT,
    );
    let serialized = serializeAppPlacementVerificationKeyRecord(
      appPlacementVerificationKeyRecord(first),
    );
    const get = vi.fn(async () => storedPublicKey(serialized));
    const storage = { get } as unknown as R2Bucket;

    await expect(verifyAppPlacementAtEdge(
      storage,
      PLACEMENT,
      firstCertificate,
    )).resolves.toBe(true);
    serialized = serializeAppPlacementVerificationKeyRecord(
      appPlacementVerificationKeyRecord(second),
    );
    await expect(verifyAppPlacementAtEdge(
      storage,
      PLACEMENT,
      secondCertificate,
    )).resolves.toBe(true);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the internal trust anchor is absent", async () => {
    const storage = {
      get: vi.fn(async () => null),
    } as unknown as R2Bucket;

    await expect(verifyAppPlacementAtEdge(
      storage,
      PLACEMENT,
      "A".repeat(86),
    )).resolves.toBe(false);
  });

  it("bounds trust-anchor reloads under repeated forged ingress", async () => {
    const record = await generateAppPlacementSigningKeyRecord();
    const serialized = serializeAppPlacementVerificationKeyRecord(
      appPlacementVerificationKeyRecord(record),
    );
    const get = vi.fn(async () => storedPublicKey(serialized));
    const storage = { get } as unknown as R2Bucket;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(verifyAppPlacementAtEdge(
        storage,
        PLACEMENT,
        "A".repeat(86),
      )).resolves.toBe(false);
    }

    // Initial load plus one bounded failure refresh, not one R2 read per
    // attacker-controlled locator.
    expect(get).toHaveBeenCalledTimes(2);
  });
});
