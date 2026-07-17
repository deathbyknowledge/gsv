import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-v1.json";
import {
  MAX_FRAME_BODY_BYTES,
  canonicalizeJson,
  decodeKvValue,
  decodeBase64Url,
  decodeReal,
  decodeSqliteTextUtf8,
  decodeSqliteValue,
  encodeKvValue,
  encodeReal,
  sqliteBlob,
  sqliteBlobReference,
  sqliteInteger,
  sqliteReal,
  sqliteText,
  sqliteTextFromUtf8,
  sqliteTextReference,
} from "../src/index";

describe("lossless SQLite values", () => {
  it("keeps signed i64 values out of JavaScript number coercion", () => {
    const minimum = sqliteInteger(-9_223_372_036_854_775_808n);
    const maximum = sqliteInteger(9_223_372_036_854_775_807n);
    expect(decodeSqliteValue(minimum)).toBe(-9_223_372_036_854_775_808n);
    expect(decodeSqliteValue(maximum)).toBe(9_223_372_036_854_775_807n);
    expect(() => sqliteInteger(9_223_372_036_854_775_808n)).toThrow(/64-bit/);
  });

  it("round trips every real special value canonically", () => {
    const values = [0, -0, 1.5, Number.NaN, Infinity, -Infinity];
    for (const value of values) {
      const encoded = encodeReal(value);
      expect(
        Object.is(decodeReal(encoded), value) ||
          (Number.isNaN(value) && Number.isNaN(decodeReal(encoded))),
      ).toBe(true);
      const decoded = decodeSqliteValue(sqliteReal(value));
      expect(Object.is(decoded, value) || (Number.isNaN(value) && Number.isNaN(decoded))).toBe(true);
    }
    expect(() => decodeReal("1.0")).toThrow(/canonical/);
  });

  it("authenticates text and blob lengths and describes external blob parts", () => {
    expect(decodeSqliteValue(sqliteText("héllo"))).toBe("héllo");
    expect(decodeSqliteValue(sqliteBlob(new Uint8Array([0, 255])))).toEqual(
      new Uint8Array([0, 255]),
    );
    expect(
      decodeSqliteValue(
        sqliteBlobReference({
          byteLength: 5_000_000n,
          objectId: "kernel/table/blob/7",
          firstPart: 4,
          partCount: 2,
        }),
      ),
    ).toMatchObject({ byteLength: 5_000_000n, firstPart: 4, partCount: 2 });
    expect(() =>
      decodeSqliteValue({ type: "text", byteLength: "1", value: "héllo" }),
    ).toThrow(/byteLength/);
  });

  it("keeps externalized large TEXT typed and rejects invalid UTF-8", () => {
    const reference = sqliteTextReference({
      byteLength: BigInt(golden.largeTextReference.byteLength),
      objectId: golden.largeTextReference.objectId,
      firstPart: golden.largeTextReference.firstPart,
      partCount: golden.largeTextReference.partCount,
    });
    expect(decodeSqliteValue(reference)).toEqual({
      type: "text-ref",
      byteLength: BigInt(MAX_FRAME_BODY_BYTES) + 1n,
      objectId: "kernel/table/text/9",
      firstPart: 0,
      partCount: 2,
    });
    expect(sqliteTextFromUtf8(new TextEncoder().encode("€"))).toEqual({
      type: "text",
      byteLength: "3",
      value: "€",
    });
    expect(decodeSqliteTextUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x78]))).toBe(
      "\ufeffx",
    );
    expect(golden.largeTextReference.byteLength).toBe(
      (BigInt(MAX_FRAME_BODY_BYTES) + 1n).toString(),
    );
    expect(() => decodeSqliteTextUtf8(decodeBase64Url(golden.invalidUtf8))).toThrow(
      /invalid UTF-8/,
    );
  });
});

describe("versioned DO KV structured-clone values", () => {
  it("preserves cycles, shared identity, holes, maps, sets, dates, and typed views", () => {
    const buffer = new ArrayBuffer(8);
    const bytes = new Uint8Array(buffer);
    bytes.set([1, 2, 3, 4]);
    const view = new Uint16Array(buffer, 2, 2);
    const root: Record<string, unknown> = Object.create(null);
    const sparse = new Array(2);
    sparse[1] = undefined;
    root.self = root;
    root.undefined = undefined;
    root.nan = Number.NaN;
    root.negativeZero = -0;
    root.big = 12_345_678_901_234_567_890n;
    root.invalidUnicode = "x\ud800y";
    root.date = new Date("2026-07-16T10:00:00.000Z");
    root.buffer = buffer;
    root.bytes = bytes;
    root.view = view;
    root.sparse = sparse;
    root.map = new Map<unknown, unknown>([[root, new Set([root, "x"])]]);

    const document = encodeKvValue(root);
    expect(canonicalizeJson(document)).toBe(canonicalizeJson(encodeKvValue(root)));
    const decoded = decodeKvValue(document) as typeof root;
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(decoded.self).toBe(decoded);
    expect(decoded.invalidUnicode).toBe("x\ud800y");
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(Object.is(decoded.negativeZero, -0)).toBe(true);
    expect(decoded.big).toBe(12_345_678_901_234_567_890n);
    expect(decoded.date).toEqual(new Date("2026-07-16T10:00:00.000Z"));
    expect((decoded.bytes as Uint8Array).buffer).toBe(decoded.buffer);
    expect((decoded.view as Uint16Array).buffer).toBe(decoded.buffer);
    expect(0 in (decoded.sparse as unknown[])).toBe(false);
    expect(1 in (decoded.sparse as unknown[])).toBe(true);
    const [[mapKey, mapValue]] = [...(decoded.map as Map<unknown, Set<unknown>>).entries()];
    expect(mapKey).toBe(decoded);
    expect([...mapValue][0]).toBe(decoded);
  });

  it("rejects unsupported objects and malformed graph references", () => {
    expect(() => encodeKvValue(/regexp/)).toThrow(/plain objects/);
    const document = encodeKvValue({ ok: true });
    const malformed = {
      ...document,
      root: { type: "reference", id: "99" },
    } as typeof document;
    expect(() => decodeKvValue(malformed)).toThrow(/out of range/);
    expect(() => encodeKvValue([{}], { maxNodes: 1 })).toThrow(/node limit/);
  });
});
