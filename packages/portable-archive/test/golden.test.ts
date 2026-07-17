import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-v1.json";
import {
  canonicalizeJson,
  collectBytes,
  createRecoveryKeyEnvelope,
  decryptOuterArchiveWithKey,
  decodeBase64Url,
  encodeBase64Url,
  encodeInnerArchive,
  encryptOuterArchiveWithKey,
  validateInnerArchive,
} from "../src/index";
import { createFixture } from "./support";

describe("portable archive v1 golden vectors", () => {
  it("keeps canonical JSON, inner framing, and outer encryption byte-for-byte stable", async () => {
    expect(
      canonicalizeJson({ numbers: [0, 1.5, 1e30], nested: { z: null, a: true }, a: "GSV" }),
    ).toBe(golden.canonical);
    const { frames, manifest } = await createFixture();
    const inner = await encodeInnerArchive(frames, manifest);
    const envelope = createRecoveryKeyEnvelope({
      chunkPlaintextBytes: 256,
      noncePrefix: decodeBase64Url(golden.noncePrefix),
    });
    const outer = await collectBytes(
      encryptOuterArchiveWithKey(inner, decodeBase64Url(golden.recoveryKey), envelope),
    );
    expect(encodeBase64Url(inner)).toBe(golden.inner);
    expect(encodeBase64Url(outer)).toBe(golden.outer);
    await expect(
      collectBytes(
        decryptOuterArchiveWithKey(
          decodeBase64Url(golden.outer),
          decodeBase64Url(golden.recoveryKey),
        ),
      ),
    ).resolves.toEqual(decodeBase64Url(golden.inner));
    await expect(validateInnerArchive(decodeBase64Url(golden.inner))).resolves.toMatchObject({
      manifest,
    });
  });
});
