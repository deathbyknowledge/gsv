import { describe, expect, it } from "vitest";
import {
  assertArchiveManifest,
  type ArchiveInventoryObjectV1,
  type ArchiveManifestV1,
} from "../src/index";
import { createFixture } from "./support";

describe("portable archive inventory units", () => {
  it("accepts multiple independently framed R2 objects in one logical bucket", async () => {
    const { manifest } = await createFixture();
    const inventory = [
      r2Object("r2:bucket-a:a", "3"),
      r2Object("r2:bucket-a:b", "4"),
      ...manifest.inventory,
    ];
    const value: ArchiveManifestV1 = {
      ...manifest,
      inventory,
      totals: {
        dataFrames: "5",
        dataBodyBytes: String(Number(manifest.totals.dataBodyBytes) + 17),
        r2Objects: "2",
        r2Bytes: "7",
      },
    };

    expect(() => assertArchiveManifest(value)).not.toThrow();
    expect(value.inventory.slice(0, 2).map((item) => item.logicalName)).toEqual([
      "tenant-storage",
      "tenant-storage",
    ]);
  });

  it("requires one matching storage record for each object or entry kind", async () => {
    const { manifest } = await createFixture();
    const invalidCount = withItem(manifest, {
      ...r2Object("r2:bucket-a:a", "3"),
      storage: { r2: { objectCount: "2", totalBytes: "3" } },
    });
    expect(() => assertArchiveManifest(invalidCount)).toThrow(
      "exactly one r2-object",
    );

    const missingKvStorage = withItem(manifest, {
      ...r2Object("workers-kv:a", "3"),
      kind: "workers-kv-entry",
      storage: {},
    });
    expect(() => assertArchiveManifest(missingKvStorage)).toThrow(
      "requires Workers KV storage detail",
    );

    const oldAggregateKind = withItem(manifest, {
      ...r2Object("r2:bucket-a", "3"),
      kind: "r2-bucket" as never,
    });
    expect(() => assertArchiveManifest(oldAggregateKind)).toThrow("unknown kind");
  });
});

function r2Object(objectId: string, bytes: string): ArchiveInventoryObjectV1 {
  return {
    objectId,
    kind: "r2-object",
    component: "gateway",
    logicalName: "tenant-storage",
    frameCount: "2",
    bodyBytes: String(Number(bytes) + 5),
    semanticSha256: "A".repeat(43),
    storage: { r2: { objectCount: "1", totalBytes: bytes } },
  };
}

function withItem(
  manifest: ArchiveManifestV1,
  item: ArchiveInventoryObjectV1,
): ArchiveManifestV1 {
  const inventory = [item, ...manifest.inventory].sort((left, right) =>
    left.objectId.localeCompare(right.objectId));
  return {
    ...manifest,
    inventory,
    totals: {
      dataFrames: String(Number(manifest.totals.dataFrames) + Number(item.frameCount)),
      dataBodyBytes: String(
        Number(manifest.totals.dataBodyBytes) + Number(item.bodyBytes),
      ),
      r2Objects: item.storage.r2?.objectCount ?? "0",
      r2Bytes: item.storage.r2?.totalBytes ?? "0",
    },
  };
}
