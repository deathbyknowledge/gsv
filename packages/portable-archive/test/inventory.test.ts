import { describe, expect, it } from "vitest";
import {
  ArchiveInventoryAccumulator,
  computeObjectSemanticDigestV1,
  encodeBase64Url,
  type ArchiveDataFrameInput,
  type ArchiveInventoryRegistrationV1,
} from "../src/index";
import { createFixture } from "./support";

describe("streaming archive inventory accumulator", () => {
  it("builds sorted per-object digests and exact totals in one pass", async () => {
    const registrations: ArchiveInventoryRegistrationV1[] = [
      registration("r2:b", "r2-object", "tenant-storage", {
        r2: { objectCount: "1", totalBytes: "2" },
      }),
      registration("r2:a", "r2-object", "tenant-storage", {
        r2: { objectCount: "1", totalBytes: "3" },
      }),
    ];
    const frames: ArchiveDataFrameInput[] = [
      frame("r2:a", "r2.descriptor", 0, [10]),
      frame("r2:a", "r2.body", 0, [1, 2, 3]),
      frame("r2:b", "r2.descriptor", 0, [20]),
      frame("r2:b", "r2.body", 0, [4, 5]),
    ];
    const accumulator = new ArchiveInventoryAccumulator(registrations);

    const observed = await collect(accumulator.observeFrames(frames));
    expect(observed).toEqual(frames);
    const summary = accumulator.finish();
    expect(summary.totals).toEqual({
      dataFrames: "4",
      dataBodyBytes: "7",
      r2Objects: "2",
      r2Bytes: "5",
    });
    expect(summary.inventory.map((item) => [
      item.objectId,
      item.logicalName,
      item.frameCount,
      item.bodyBytes,
    ])).toEqual([
      ["r2:a", "tenant-storage", "2", "4"],
      ["r2:b", "tenant-storage", "2", "3"],
    ]);
    expect(summary.inventory[0]!.semanticSha256).toBe(encodeBase64Url(
      await computeObjectSemanticDigestV1("r2:a", [frames[0]!, frames[1]!]),
    ));
    expect(accumulator.finish()).toBe(summary);
  });

  it("creates the validated deferred manifest from observed frames", async () => {
    const fixture = await createFixture();
    const {
      frameCount: _frameCount,
      bodyBytes: _bodyBytes,
      semanticSha256: _digest,
      ...item
    } = fixture.manifest.inventory[0]!;
    const accumulator = new ArchiveInventoryAccumulator([item]);
    await collect(accumulator.observeFrames(fixture.frames));
    const {
      inventory: _inventory,
      totals: _totals,
      ...base
    } = fixture.manifest;

    expect(accumulator.createManifest(base)).toEqual(fixture.manifest);
  });

  it("fails closed on duplicate, unknown, missing, and post-finalization frames", async () => {
    const item = registration("tenant", "tenant", "ada.gsv.space", {});
    expect(() => new ArchiveInventoryAccumulator([item, item])).toThrow("duplicated");

    const unknown = new ArchiveInventoryAccumulator([item]);
    await expect(unknown.observe(frame("other", "tenant", 0, [1])))
      .rejects.toThrow("not registered");
    expect(() => unknown.finish()).toThrow("not registered");

    const interleaved = new ArchiveInventoryAccumulator([
      item,
      registration("other", "tenant", "other.gsv.space", {}),
    ]);
    await interleaved.observe(frame("tenant", "tenant", 0, [1]));
    await interleaved.observe(frame("other", "tenant", 0, [2]));
    await expect(interleaved.observe(frame("tenant", "do.kv", 0, [3])))
      .rejects.toThrow("one contiguous run");

    const missing = new ArchiveInventoryAccumulator([item]);
    expect(() => missing.finish()).toThrow("must emit a data frame");

    const finalized = new ArchiveInventoryAccumulator([item]);
    await finalized.observe(frame("tenant", "tenant", 0, [1]));
    finalized.finish();
    await expect(finalized.observe(frame("tenant", "tenant", 1, [2])))
      .rejects.toThrow("already finalized");
  });
});

function registration(
  objectId: string,
  kind: ArchiveInventoryRegistrationV1["kind"],
  logicalName: string,
  storage: ArchiveInventoryRegistrationV1["storage"],
): ArchiveInventoryRegistrationV1 {
  return {
    objectId,
    kind,
    component: "gateway",
    logicalName,
    storage,
  };
}

function frame(
  objectId: string,
  kind: ArchiveDataFrameInput["kind"],
  part: number,
  body: readonly number[],
): ArchiveDataFrameInput {
  return {
    objectId,
    kind,
    part,
    bodyMediaType: "application/octet-stream",
    body: new Uint8Array(body),
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
