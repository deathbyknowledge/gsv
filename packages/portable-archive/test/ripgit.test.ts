import { describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../src/canonical-json";
import type { ArchiveDataFrameInput } from "../src/inner";
import {
  computeRipgitSnapshotManifestHash,
  computeRipgitSnapshotPageHash,
  decodeRipgitSnapshotManifestFrame,
  decodeRipgitSnapshotPageFrame,
  RIPGIT_MANIFEST_KIND,
  RIPGIT_MANIFEST_MEDIA_TYPE,
  RIPGIT_PAGE_KIND,
  RIPGIT_PAGE_MEDIA_TYPE,
  RIPGIT_SNAPSHOT_TABLE_LAYOUT,
  ripgitSqliteInventory,
  RipgitSnapshotStreamValidator,
  type RipgitSnapshotManifestBodyV1,
  type RipgitSnapshotManifestV1,
  type RipgitSnapshotPageBodyV1,
  type RipgitSnapshotPageV1,
} from "../src/ripgit";
import golden from "./fixtures/ripgit-v1.json";

const OBJECT_ID = "repository:alice/memory";

describe("ripgit public snapshot contract", () => {
  it("matches the shared Rust hash golden despite canonical frame key order", async () => {
    const manifest = golden.manifest as RipgitSnapshotManifestV1;
    const page = golden.page as RipgitSnapshotPageV1;

    expect(await computeRipgitSnapshotManifestHash(manifest.body)).toBe(
      "c7c4dbf5d0236e56df800c0ba6083150ba0b0d418be4ef591b8d6552f8da9b10",
    );
    expect(await computeRipgitSnapshotPageHash(page.body)).toBe(
      "74c82318ea5b3780970a9bb05f69ce79ceab2a6639e9f89019bc4dccef5f7de8",
    );

    const canonical = new TextDecoder().decode(canonicalJsonBytes(manifest.body));
    expect(canonical.startsWith('{"excludedCacheTables"')).toBe(true);
    expect(JSON.stringify(manifest.body).startsWith('{"format"')).toBe(true);

    await expect(decodeRipgitSnapshotManifestFrame(manifestFrame(manifest)))
      .resolves.toEqual(manifest);
    await expect(decodeRipgitSnapshotPageFrame(pageFrame(page, 0)))
      .resolves.toEqual(page);
  });

  it("denies unknown fields, provider IDs, invalid identities, and unsafe counts", async () => {
    const providerIdentity = clone(golden.manifest) as unknown as Record<string, unknown>;
    const providerBody = providerIdentity.body as Record<string, unknown>;
    (providerBody.identity as Record<string, unknown>).providerId = "a".repeat(64);
    await expect(decodeRipgitSnapshotManifestFrame(rawManifestFrame(providerIdentity)))
      .rejects.toThrow(/unexpected or missing fields/);

    const invalidOwner = clone(golden.manifest) as unknown as Record<string, unknown>;
    ((invalidOwner.body as Record<string, unknown>).identity as Record<string, unknown>).owner =
      "bad/owner";
    await expect(decodeRipgitSnapshotManifestFrame(rawManifestFrame(invalidOwner)))
      .rejects.toThrow(/owner is invalid/);

    const unsafeEpoch = clone(golden.manifest) as unknown as Record<string, unknown>;
    (unsafeEpoch.body as Record<string, unknown>).sourceEpoch = Number.MAX_SAFE_INTEGER + 1;
    await expect(decodeRipgitSnapshotManifestFrame(rawManifestFrame(unsafeEpoch)))
      .rejects.toThrow(/safe integer/);

    const unsafeCount = clone(golden.manifest) as unknown as Record<string, unknown>;
    (((unsafeCount.body as Record<string, unknown>).tables as unknown[])[0] as
      Record<string, unknown>).rowCount = Number.MAX_SAFE_INTEGER + 1;
    await expect(decodeRipgitSnapshotManifestFrame(rawManifestFrame(unsafeCount)))
      .rejects.toThrow(/safe integer/);
  });

  it("enforces exact tagged values, canonical base64, and lossless SQL integers", async () => {
    const tooLargeInteger = clone(golden.page) as unknown as Record<string, unknown>;
    const integerRows = ((tooLargeInteger.body as Record<string, unknown>).rows as unknown[][]);
    (integerRows[0]![1] as Record<string, unknown>).value = "9007199254740992";
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(tooLargeInteger, 0)))
      .rejects.toThrow(/losslessly portable/);

    const invalidBlob = clone(golden.page) as unknown as Record<string, unknown>;
    const blobRows = ((invalidBlob.body as Record<string, unknown>).rows as unknown[][]);
    (blobRows[0]![4] as Record<string, unknown>).value = "AB==";
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(invalidBlob, 0)))
      .rejects.toThrow(/canonical standard base64/);

    const wrongTag = clone(golden.page) as unknown as Record<string, unknown>;
    const tagRows = ((wrongTag.body as Record<string, unknown>).rows as unknown[][]);
    tagRows[0]![1] = { type: "boolean", value: true };
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(wrongTag, 0)))
      .rejects.toThrow(/losslessly portable/);

    const extraValueField = clone(golden.page) as unknown as Record<string, unknown>;
    const extraRows = ((extraValueField.body as Record<string, unknown>).rows as unknown[][]);
    (extraRows[0]![6] as Record<string, unknown>).value = null;
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(extraValueField, 0)))
      .rejects.toThrow(/unexpected or missing fields/);

    const noncanonicalInteger = clone(golden.page) as unknown as Record<string, unknown>;
    const noncanonicalRows = ((noncanonicalInteger.body as Record<string, unknown>).rows as
      unknown[][]);
    (noncanonicalRows[0]![1] as Record<string, unknown>).value = "+7";
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(noncanonicalInteger, 0)))
      .rejects.toThrow(/signed 64-bit decimal/);

    const noncanonicalFloat = clone(golden.page) as unknown as Record<string, unknown>;
    const floatRows = ((noncanonicalFloat.body as Record<string, unknown>).rows as unknown[][]);
    floatRows[0]![1] = { type: "float_bits", value: "A" };
    await expect(decodeRipgitSnapshotPageFrame(rawPageFrame(noncanonicalFloat, 0)))
      .rejects.toThrow(/float bits are invalid/);
  });

  it("validates a complete manifest-first object and returns sorted inventory", async () => {
    const manifest = golden.manifest as RipgitSnapshotManifestV1;
    const page = golden.page as RipgitSnapshotPageV1;
    const validator = new RipgitSnapshotStreamValidator({
      objectId: OBJECT_ID,
      logicalName: "alice/memory",
    });

    await validator.observe(manifestFrame(manifest));
    await validator.observe(pageFrame(page, 0));
    const result = validator.finish();

    expect(result.pageCount).toBe(1);
    expect(result.rowCount).toBe(1);
    expect(result.sqlite).toEqual(ripgitSqliteInventory(manifest));
    expect(result.sqlite.tables.map((entry) => entry.name)).toEqual(
      [...RIPGIT_SNAPSHOT_TABLE_LAYOUT]
        .map((entry) => entry.name)
        .sort(),
    );
    expect(result.sqlite.tables.find((entry) => entry.name === "blobs")?.rowCount)
      .toBe("1");
  });

  it("rejects wrong object identity, page parts, ranges, and incomplete coverage", async () => {
    const manifest = await manifestWithBlobRows(2);
    const firstPage = await blobPage(manifest, 0, 1, [goldenRow()]);

    const wrongObject = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await expect(wrongObject.observe({
      ...manifestFrame(manifest),
      objectId: "repository:other/repo",
    })).rejects.toThrow(/another archive object/);

    const pagesBeforeManifest = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await expect(pagesBeforeManifest.observe(pageFrame(firstPage, 0)))
      .rejects.toThrow(/manifest frame envelope/);

    const wrongPart = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await wrongPart.observe(manifestFrame(manifest));
    await expect(wrongPart.observe(pageFrame(firstPage, 1)))
      .rejects.toThrow(/parts must be contiguous/);

    const wrongRange = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await wrongRange.observe(manifestFrame(manifest));
    const offsetPage = await blobPage(manifest, 1, 2, [goldenRow()]);
    await expect(wrongRange.observe(pageFrame(offsetPage, 0)))
      .rejects.toThrow(/table or offset order/);

    const incomplete = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await incomplete.observe(manifestFrame(manifest));
    await incomplete.observe(pageFrame(firstPage, 0));
    expect(() => incomplete.finish()).toThrow(/before all declared rows/);
  });

  it("rejects empty pages and pages bound to another manifest", async () => {
    const manifest = await manifestWithBlobRows(1);
    const empty = await blobPage(manifest, 0, 0, []);
    const emptyValidator = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await emptyValidator.observe(manifestFrame(manifest));
    await expect(emptyValidator.observe(pageFrame(empty, 0)))
      .rejects.toThrow(/at least one row/);

    const other = clone(golden.page) as RipgitSnapshotPageV1;
    const otherBody = { ...other.body, manifestHash: "a".repeat(64) };
    const otherPage: RipgitSnapshotPageV1 = {
      body: otherBody,
      pageHash: await computeRipgitSnapshotPageHash(otherBody),
    };
    const boundValidator = new RipgitSnapshotStreamValidator({ objectId: OBJECT_ID });
    await boundValidator.observe(manifestFrame(golden.manifest as RipgitSnapshotManifestV1));
    await expect(boundValidator.observe(pageFrame(otherPage, 0)))
      .rejects.toThrow(/another manifest/);
  });

  it("rejects a hostile page containing more than 250 rows", async () => {
    const manifest = await manifestWithBlobRows(251);
    const body: RipgitSnapshotPageBodyV1 = {
      manifestHash: manifest.manifestHash,
      tableIndex: 5,
      table: "blobs",
      offset: 0,
      nextOffset: 251,
      rows: Array.from({ length: 251 }, goldenRow),
    };
    await expect(computeRipgitSnapshotPageHash(body)).rejects.toThrow(/at most 250 rows/);
  });
});

function manifestFrame(manifest: RipgitSnapshotManifestV1): ArchiveDataFrameInput {
  return rawManifestFrame(manifest);
}

function rawManifestFrame(value: unknown): ArchiveDataFrameInput {
  return {
    kind: RIPGIT_MANIFEST_KIND,
    objectId: OBJECT_ID,
    part: 0,
    bodyMediaType: RIPGIT_MANIFEST_MEDIA_TYPE,
    bodyEncoding: "identity",
    body: canonicalJsonBytes(value),
  };
}

function pageFrame(page: RipgitSnapshotPageV1, part: number): ArchiveDataFrameInput {
  return rawPageFrame(page, part);
}

function rawPageFrame(value: unknown, part: number): ArchiveDataFrameInput {
  return {
    kind: RIPGIT_PAGE_KIND,
    objectId: OBJECT_ID,
    part,
    bodyMediaType: RIPGIT_PAGE_MEDIA_TYPE,
    bodyEncoding: "identity",
    body: canonicalJsonBytes(value),
  };
}

async function manifestWithBlobRows(rowCount: number): Promise<RipgitSnapshotManifestV1> {
  const original = clone(golden.manifest).body as RipgitSnapshotManifestBodyV1;
  const tables = original.tables.map((entry) => ({
    ...entry,
    rowCount: entry.name === "blobs" ? rowCount : 0,
  }));
  const body: RipgitSnapshotManifestBodyV1 = { ...original, tables };
  return { body, manifestHash: await computeRipgitSnapshotManifestHash(body) };
}

async function blobPage(
  manifest: RipgitSnapshotManifestV1,
  offset: number,
  nextOffset: number,
  rows: RipgitSnapshotPageBodyV1["rows"],
): Promise<RipgitSnapshotPageV1> {
  const body: RipgitSnapshotPageBodyV1 = {
    manifestHash: manifest.manifestHash,
    tableIndex: 5,
    table: "blobs",
    offset,
    nextOffset,
    rows,
  };
  return { body, pageHash: await computeRipgitSnapshotPageHash(body) };
}

function goldenRow(): RipgitSnapshotPageBodyV1["rows"][number] {
  return clone(golden.page.body.rows[0]) as RipgitSnapshotPageBodyV1["rows"][number];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
