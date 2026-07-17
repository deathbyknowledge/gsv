import { describe, expect, it } from "vitest";
import {
  ObjectSemanticDigestV1,
  computeObjectSemanticDigestV1,
  encodeBase64Url,
} from "../src/index";

describe("normalization policy v1 object digest", () => {
  it("pins the exact logical-frame transcript algorithm", async () => {
    const frame = {
      kind: "tenant",
      part: 0,
      bodyMediaType: "application/json",
      body: new TextEncoder().encode('{"handle":"ada"}'),
    } as const;
    expect(
      encodeBase64Url(await computeObjectSemanticDigestV1("tenant", [frame])),
    ).toBe("z2-sjt89odY3EW74mlW0tl9_9QQQxmBwNSwyIlqzoL0");
  });

  it("requires deterministic contiguous parts independently for each kind", async () => {
    const digest = await ObjectSemanticDigestV1.create("process:init:1");
    await digest.append({
      kind: "do.descriptor",
      part: 0,
      bodyMediaType: "application/json",
      body: new Uint8Array(0),
    });
    await expect(
      digest.append({
        kind: "do.descriptor",
        part: 2,
        bodyMediaType: "application/json",
        body: new Uint8Array(0),
      }),
    ).rejects.toThrow(/contiguous/);
  });
});
