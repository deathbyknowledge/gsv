import { decodeBase64Url, encodeBase64Url } from "./bytes";
import { assertValidUnicode } from "./canonical-json";
import { fail } from "./error";

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

export type PortableSqliteValueV1 =
  | Readonly<{ type: "null" }>
  | Readonly<{ type: "integer"; value: string }>
  | Readonly<{ type: "real"; value: string }>
  | Readonly<{ type: "text"; byteLength: string; value: string }>
  | Readonly<{ type: "blob"; byteLength: string; value: string }>
  | Readonly<{
      type: "blob-ref";
      byteLength: string;
      objectId: string;
      firstPart: number;
      partCount: number;
    }>
  | Readonly<{
      type: "text-ref";
      byteLength: string;
      objectId: string;
      firstPart: number;
      partCount: number;
    }>;

export type DecodedSqliteValue =
  | null
  | bigint
  | number
  | string
  | Uint8Array
  | Readonly<{
      type: "blob-ref";
      byteLength: bigint;
      objectId: string;
      firstPart: number;
      partCount: number;
    }>
  | Readonly<{
      type: "text-ref";
      byteLength: bigint;
      objectId: string;
      firstPart: number;
      partCount: number;
    }>;

export function sqliteNull(): PortableSqliteValueV1 {
  return { type: "null" };
}

export function sqliteInteger(value: bigint): PortableSqliteValueV1 {
  if (value < I64_MIN || value > I64_MAX) {
    fail("invalid_value", "SQLite integer is outside the signed 64-bit range");
  }
  return { type: "integer", value: value.toString() };
}

export function sqliteReal(value: number): PortableSqliteValueV1 {
  return { type: "real", value: encodeReal(value) };
}

export function sqliteText(value: string): PortableSqliteValueV1 {
  assertValidUnicode(value);
  return {
    type: "text",
    byteLength: textEncoder.encode(value).byteLength.toString(),
    value,
  };
}

export function sqliteTextFromUtf8(value: Uint8Array): PortableSqliteValueV1 {
  return sqliteText(decodeSqliteTextUtf8(value));
}

export function decodeSqliteTextUtf8(value: Uint8Array): string {
  if (!(value instanceof Uint8Array)) {
    fail("invalid_value", "SQLite text bytes must be a Uint8Array");
  }
  try {
    const text = fatalTextDecoder.decode(value);
    assertValidUnicode(text);
    return text;
  } catch (error) {
    fail("invalid_value", `SQLite text contains invalid UTF-8: ${String(error)}`);
  }
}

export function sqliteTextReference(input: Readonly<{
  byteLength: bigint;
  objectId: string;
  firstPart: number;
  partCount: number;
}>): PortableSqliteValueV1 {
  return sqliteExternalReference("text-ref", input);
}

export function sqliteBlob(value: Uint8Array): PortableSqliteValueV1 {
  return {
    type: "blob",
    byteLength: value.byteLength.toString(),
    value: encodeBase64Url(value),
  };
}

export function sqliteBlobReference(input: Readonly<{
  byteLength: bigint;
  objectId: string;
  firstPart: number;
  partCount: number;
}>): PortableSqliteValueV1 {
  return sqliteExternalReference("blob-ref", input);
}

function sqliteExternalReference(
  type: "blob-ref" | "text-ref",
  input: Readonly<{
    byteLength: bigint;
    objectId: string;
    firstPart: number;
    partCount: number;
  }>,
): PortableSqliteValueV1 {
  const label = type === "blob-ref" ? "blob" : "text";
  assertNonEmptyIdentifier(input.objectId, `${label} objectId`);
  assertU32(input.firstPart, `${label} firstPart`);
  assertU32(input.partCount, `${label} partCount`);
  if (input.partCount === 0) {
    fail("invalid_value", `${label} partCount must be positive`);
  }
  if (input.byteLength < 0n || input.byteLength > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_value", `${label} byteLength is outside the unsigned 64-bit range`);
  }
  return {
    type,
    byteLength: input.byteLength.toString(),
    objectId: input.objectId,
    firstPart: input.firstPart,
    partCount: input.partCount,
  };
}

export function decodeSqliteValue(value: PortableSqliteValueV1): DecodedSqliteValue {
  const record = expectRecord(value, "SQLite value");
  switch (record.type) {
    case "null":
      expectExactKeys(record, ["type"], "SQLite null");
      return null;
    case "integer": {
      expectExactKeys(record, ["type", "value"], "SQLite integer");
      const integer = parseCanonicalInteger(expectString(record.value, "SQLite integer"));
      if (integer < I64_MIN || integer > I64_MAX) {
        fail("invalid_value", "SQLite integer is outside the signed 64-bit range");
      }
      return integer;
    }
    case "real":
      expectExactKeys(record, ["type", "value"], "SQLite real");
      return decodeReal(expectString(record.value, "SQLite real"));
    case "text": {
      expectExactKeys(record, ["type", "byteLength", "value"], "SQLite text");
      const text = expectString(record.value, "SQLite text");
      assertValidUnicode(text);
      const length = parseCanonicalUnsigned(record.byteLength, "SQLite text byteLength");
      if (length !== BigInt(textEncoder.encode(text).byteLength)) {
        fail("integrity_error", "SQLite text byteLength does not match its UTF-8 data");
      }
      return text;
    }
    case "text-ref":
    case "blob": {
      if (record.type === "text-ref") {
        return decodeExternalReference(record, "text-ref", "SQLite text");
      }
      expectExactKeys(record, ["type", "byteLength", "value"], "SQLite blob");
      const bytes = decodeBase64Url(expectString(record.value, "SQLite blob"));
      const length = parseCanonicalUnsigned(record.byteLength, "SQLite blob byteLength");
      if (length !== BigInt(bytes.byteLength)) {
        fail("integrity_error", "SQLite blob byteLength does not match its data");
      }
      return bytes;
    }
    case "blob-ref": {
      return decodeExternalReference(record, "blob-ref", "SQLite blob");
    }
    default:
      fail("invalid_value", "unknown SQLite value tag");
  }
}

function decodeExternalReference(
  record: Record<string, unknown>,
  type: "blob-ref" | "text-ref",
  label: string,
): Extract<DecodedSqliteValue, { type: "blob-ref" | "text-ref" }> {
  expectExactKeys(
    record,
    ["type", "byteLength", "objectId", "firstPart", "partCount"],
    `${label} reference`,
  );
  const objectId = expectString(record.objectId, `${label} objectId`);
  assertNonEmptyIdentifier(objectId, `${label} objectId`);
  const firstPart = expectU32(record.firstPart, `${label} firstPart`);
  const partCount = expectU32(record.partCount, `${label} partCount`);
  if (partCount === 0) fail("invalid_value", `${label} partCount must be positive`);
  return {
    type,
    byteLength: parseCanonicalUnsigned(record.byteLength, `${label} byteLength`),
    objectId,
    firstPart,
    partCount,
  };
}

export type PortableStringV1 =
  | Readonly<{ encoding: "utf8"; byteLength: string; value: string }>
  | Readonly<{ encoding: "utf16le"; codeUnits: string; value: string }>;

export type PortableKvAtomV1 =
  | Readonly<{ type: "undefined" }>
  | Readonly<{ type: "null" }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "number"; value: string }>
  | Readonly<{ type: "bigint"; value: string }>
  | Readonly<{ type: "string"; value: PortableStringV1 }>
  | Readonly<{ type: "reference"; id: string }>
  | Readonly<{ type: "hole" }>;

export type PortableKvNodeV1 =
  | Readonly<{ id: string; type: "array"; items: readonly PortableKvAtomV1[] }>
  | Readonly<{
      id: string;
      type: "object";
      prototype: "object" | "null";
      entries: readonly (readonly [PortableStringV1, PortableKvAtomV1])[];
    }>
  | Readonly<{
      id: string;
      type: "map";
      entries: readonly (readonly [PortableKvAtomV1, PortableKvAtomV1])[];
    }>
  | Readonly<{ id: string; type: "set"; values: readonly PortableKvAtomV1[] }>
  | Readonly<{ id: string; type: "date"; milliseconds: string }>
  | Readonly<{ id: string; type: "array-buffer"; byteLength: string; value: string }>
  | Readonly<{
      id: string;
      type: "typed-array";
      name: PortableTypedArrayName;
      buffer: PortableKvAtomV1;
      byteOffset: string;
      length: string;
    }>;

export type PortableKvDocumentV1 = Readonly<{
  version: 1;
  root: PortableKvAtomV1;
  nodes: readonly PortableKvNodeV1[];
}>;

export type PortableTypedArrayName =
  | "DataView"
  | "Int8Array"
  | "Uint8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

export type KvCodecLimits = Readonly<{
  maxNodes?: number;
  maxDepth?: number;
  maxCollectionEntries?: number;
}>;

const DEFAULT_KV_CODEC_LIMITS = Object.freeze({
  maxNodes: 100_000,
  maxDepth: 256,
  maxCollectionEntries: 1_000_000,
});

export function encodeKvValue(
  value: unknown,
  limits: KvCodecLimits = {},
): PortableKvDocumentV1 {
  const resolved = resolveKvLimits(limits);
  const identifiers = new Map<object, number>();
  const nodes: PortableKvNodeV1[] = [];
  let collectionEntries = 0;

  const encode = (current: unknown, depth: number, allowHole = false): PortableKvAtomV1 => {
    if (depth > resolved.maxDepth) {
      fail("limit_exceeded", "DO KV value exceeds its nesting limit");
    }
    if (current === KV_HOLE) {
      if (!allowHole) fail("invalid_value", "array hole used outside an array");
      return { type: "hole" };
    }
    if (current === undefined) return { type: "undefined" };
    if (current === null) return { type: "null" };
    if (typeof current === "boolean") return { type: "boolean", value: current };
    if (typeof current === "number") return { type: "number", value: encodeReal(current) };
    if (typeof current === "bigint") return { type: "bigint", value: current.toString() };
    if (typeof current === "string") {
      return { type: "string", value: encodePortableString(current) };
    }
    if (typeof current !== "object") {
      fail("unsupported_feature", `DO KV codec does not support ${typeof current}`);
    }

    const existing = identifiers.get(current);
    if (existing !== undefined) return { type: "reference", id: existing.toString() };
    if (nodes.length >= resolved.maxNodes) {
      fail("limit_exceeded", "DO KV value exceeds its node limit");
    }
    const id = nodes.length;
    identifiers.set(current, id);
    nodes.push(undefined as unknown as PortableKvNodeV1);
    const nodeId = id.toString();

    if (Array.isArray(current)) {
      countEntries(current.length);
      const items: PortableKvAtomV1[] = [];
      for (let index = 0; index < current.length; index += 1) {
        items.push(
          encode(Object.hasOwn(current, index) ? current[index] : KV_HOLE, depth + 1, true),
        );
      }
      rejectArrayProperties(current);
      nodes[id] = { id: nodeId, type: "array", items };
    } else if (current instanceof Date) {
      nodes[id] = {
        id: nodeId,
        type: "date",
        milliseconds: encodeReal(current.getTime()),
      };
    } else if (current instanceof ArrayBuffer) {
      const bytes = new Uint8Array(current);
      nodes[id] = {
        id: nodeId,
        type: "array-buffer",
        byteLength: bytes.byteLength.toString(),
        value: encodeBase64Url(bytes),
      };
    } else if (ArrayBuffer.isView(current)) {
      const name = typedArrayName(current);
      const length =
        current instanceof DataView
          ? current.byteLength
          : (current as ArrayBufferView & { length: number }).length;
      nodes[id] = {
        id: nodeId,
        type: "typed-array",
        name,
        buffer: encode(current.buffer, depth + 1),
        byteOffset: current.byteOffset.toString(),
        length: length.toString(),
      };
    } else if (current instanceof Map) {
      countEntries(current.size);
      const entries: [PortableKvAtomV1, PortableKvAtomV1][] = [];
      for (const [key, entryValue] of current) {
        entries.push([encode(key, depth + 1), encode(entryValue, depth + 1)]);
      }
      nodes[id] = { id: nodeId, type: "map", entries };
    } else if (current instanceof Set) {
      countEntries(current.size);
      const values: PortableKvAtomV1[] = [];
      for (const entryValue of current) values.push(encode(entryValue, depth + 1));
      nodes[id] = { id: nodeId, type: "set", values };
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("unsupported_feature", "DO KV codec supports only plain objects");
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        fail("unsupported_feature", "DO KV codec does not support symbol properties");
      }
      const keys = Object.keys(current);
      countEntries(keys.length);
      const entries: [PortableStringV1, PortableKvAtomV1][] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("unsupported_feature", "DO KV codec does not invoke property accessors");
        }
        entries.push([encodePortableString(key), encode(descriptor.value, depth + 1)]);
      }
      nodes[id] = {
        id: nodeId,
        type: "object",
        prototype: prototype === null ? "null" : "object",
        entries,
      };
    }
    return { type: "reference", id: nodeId };
  };

  function countEntries(count: number): void {
    collectionEntries += count;
    if (collectionEntries > resolved.maxCollectionEntries) {
      fail("limit_exceeded", "DO KV value exceeds its collection entry limit");
    }
  }

  return { version: 1, root: encode(value, 0), nodes };
}

export function decodeKvValue(
  document: PortableKvDocumentV1,
  limits: KvCodecLimits = {},
): unknown {
  const resolved = resolveKvLimits(limits);
  const record = expectRecord(document, "DO KV document");
  expectExactKeys(record, ["version", "root", "nodes"], "DO KV document");
  if (record.version !== 1 || !Array.isArray(record.nodes)) {
    fail("invalid_value", "DO KV document has an unsupported version or node list");
  }
  if (record.nodes.length > resolved.maxNodes) {
    fail("limit_exceeded", "DO KV document exceeds its node limit");
  }
  const nodeRecords = record.nodes.map((node, index) => {
    const nodeRecord = expectRecord(node, `DO KV node ${index}`);
    if (nodeRecord.id !== index.toString()) {
      fail("invalid_value", "DO KV node IDs must be sequential canonical decimals");
    }
    return nodeRecord;
  });
  const values = new Array<unknown>(nodeRecords.length);
  let collectionEntries = 0;

  for (let index = 0; index < nodeRecords.length; index += 1) {
    const node = nodeRecords[index];
    switch (node.type) {
      case "array":
        values[index] = [];
        break;
      case "object":
        values[index] = Object.create(node.prototype === "null" ? null : Object.prototype);
        break;
      case "map":
        values[index] = new Map();
        break;
      case "set":
        values[index] = new Set();
        break;
      case "date":
        values[index] = new Date(decodeReal(expectString(node.milliseconds, "date")));
        break;
      case "array-buffer": {
        const bytes = decodeBase64Url(expectString(node.value, "array buffer"));
        if (
          parseCanonicalUnsigned(node.byteLength, "array buffer byteLength") !==
          BigInt(bytes.byteLength)
        ) {
          fail("integrity_error", "array buffer byteLength does not match its data");
        }
        values[index] = bytes.slice().buffer;
        break;
      }
      case "typed-array":
        break;
      default:
        fail("invalid_value", `DO KV node ${index} has an unknown type`);
    }
  }

  const decodeAtom = (
    atom: unknown,
    depth: number,
    allowHole = false,
  ): unknown | typeof KV_HOLE => {
    if (depth > resolved.maxDepth) {
      fail("limit_exceeded", "DO KV document exceeds its nesting limit");
    }
    const tagged = expectRecord(atom, "DO KV tagged value");
    switch (tagged.type) {
      case "undefined":
        expectExactKeys(tagged, ["type"], "undefined value");
        return undefined;
      case "null":
        expectExactKeys(tagged, ["type"], "null value");
        return null;
      case "boolean":
        expectExactKeys(tagged, ["type", "value"], "boolean value");
        if (typeof tagged.value !== "boolean") fail("invalid_value", "invalid boolean value");
        return tagged.value;
      case "number":
        expectExactKeys(tagged, ["type", "value"], "number value");
        return decodeReal(expectString(tagged.value, "number value"));
      case "bigint":
        expectExactKeys(tagged, ["type", "value"], "bigint value");
        return parseCanonicalInteger(expectString(tagged.value, "bigint value"));
      case "string":
        expectExactKeys(tagged, ["type", "value"], "string value");
        return decodePortableString(tagged.value as PortableStringV1);
      case "reference": {
        expectExactKeys(tagged, ["type", "id"], "reference value");
        const id = parseCanonicalUnsigned(tagged.id, "reference ID");
        if (id >= BigInt(values.length)) fail("invalid_value", "DO KV reference is out of range");
        return values[Number(id)];
      }
      case "hole":
        expectExactKeys(tagged, ["type"], "array hole");
        if (!allowHole) fail("invalid_value", "array hole used outside an array");
        return KV_HOLE;
      default:
        fail("invalid_value", "unknown DO KV value tag");
    }
  };

  for (let index = 0; index < nodeRecords.length; index += 1) {
    const node = nodeRecords[index];
    if (node.type !== "typed-array") continue;
    expectExactKeys(
      node,
      ["id", "type", "name", "buffer", "byteOffset", "length"],
      "typed array node",
    );
    const buffer = decodeAtom(node.buffer, 1);
    if (!(buffer instanceof ArrayBuffer)) {
      fail("invalid_value", "typed array buffer reference must resolve to ArrayBuffer");
    }
    const byteOffset = bigintToSafeNumber(
      parseCanonicalUnsigned(node.byteOffset, "typed array byteOffset"),
      "typed array byteOffset",
    );
    const length = bigintToSafeNumber(
      parseCanonicalUnsigned(node.length, "typed array length"),
      "typed array length",
    );
    values[index] = createTypedArray(expectTypedArrayName(node.name), buffer, byteOffset, length);
  }

  for (let index = 0; index < nodeRecords.length; index += 1) {
    const node = nodeRecords[index];
    switch (node.type) {
      case "array": {
        expectExactKeys(node, ["id", "type", "items"], "array node");
        if (!Array.isArray(node.items)) fail("invalid_value", "array node items must be an array");
        countEntries(node.items.length);
        const target = values[index] as unknown[];
        target.length = node.items.length;
        node.items.forEach((item, itemIndex) => {
          const decoded = decodeAtom(item, 1, true);
          if (decoded !== KV_HOLE) target[itemIndex] = decoded;
        });
        break;
      }
      case "object": {
        expectExactKeys(node, ["id", "type", "prototype", "entries"], "object node");
        if (node.prototype !== "object" && node.prototype !== "null") {
          fail("invalid_value", "object node has an invalid prototype tag");
        }
        const entries = expectPairArray(node.entries, "object entries");
        countEntries(entries.length);
        const target = values[index] as Record<string, unknown>;
        const seen = new Set<string>();
        for (const [keyValue, entryValue] of entries) {
          const key = decodePortableString(keyValue as PortableStringV1);
          if (seen.has(key)) fail("invalid_value", "object node contains a duplicate key");
          seen.add(key);
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: decodeAtom(entryValue, 1),
          });
        }
        break;
      }
      case "map": {
        expectExactKeys(node, ["id", "type", "entries"], "map node");
        const entries = expectPairArray(node.entries, "map entries");
        countEntries(entries.length);
        const target = values[index] as Map<unknown, unknown>;
        for (const [key, entryValue] of entries) {
          const decodedKey = decodeAtom(key, 1);
          if (target.has(decodedKey)) {
            fail("invalid_value", "map node contains a duplicate key");
          }
          target.set(decodedKey, decodeAtom(entryValue, 1));
        }
        break;
      }
      case "set": {
        expectExactKeys(node, ["id", "type", "values"], "set node");
        if (!Array.isArray(node.values)) fail("invalid_value", "set values must be an array");
        countEntries(node.values.length);
        const target = values[index] as Set<unknown>;
        for (const entryValue of node.values) {
          const decodedValue = decodeAtom(entryValue, 1);
          if (target.has(decodedValue)) {
            fail("invalid_value", "set node contains a duplicate value");
          }
          target.add(decodedValue);
        }
        break;
      }
      case "date":
        expectExactKeys(node, ["id", "type", "milliseconds"], "date node");
        break;
      case "array-buffer":
        expectExactKeys(
          node,
          ["id", "type", "byteLength", "value"],
          "array buffer node",
        );
        break;
      case "typed-array":
        break;
      default:
        break;
    }
  }

  return decodeAtom(record.root, 0);

  function countEntries(count: number): void {
    collectionEntries += count;
    if (collectionEntries > resolved.maxCollectionEntries) {
      fail("limit_exceeded", "DO KV document exceeds its collection entry limit");
    }
  }
}

export function encodePortableString(value: string): PortableStringV1 {
  if (hasOnlyPairedSurrogates(value)) {
    return {
      encoding: "utf8",
      byteLength: textEncoder.encode(value).byteLength.toString(),
      value,
    };
  }
  const bytes = new Uint8Array(value.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return {
    encoding: "utf16le",
    codeUnits: value.length.toString(),
    value: encodeBase64Url(bytes),
  };
}

export function decodePortableString(value: PortableStringV1): string {
  const record = expectRecord(value, "portable string");
  if (record.encoding === "utf8") {
    expectExactKeys(record, ["encoding", "byteLength", "value"], "UTF-8 string");
    const text = expectString(record.value, "UTF-8 string");
    assertValidUnicode(text);
    if (
      parseCanonicalUnsigned(record.byteLength, "UTF-8 string byteLength") !==
      BigInt(textEncoder.encode(text).byteLength)
    ) {
      fail("integrity_error", "UTF-8 string byteLength does not match its value");
    }
    return text;
  }
  if (record.encoding === "utf16le") {
    expectExactKeys(record, ["encoding", "codeUnits", "value"], "UTF-16 string");
    const bytes = decodeBase64Url(expectString(record.value, "UTF-16 string"));
    const codeUnits = parseCanonicalUnsigned(record.codeUnits, "UTF-16 codeUnits");
    if (codeUnits * 2n !== BigInt(bytes.byteLength)) {
      fail("integrity_error", "UTF-16 code unit count does not match its data");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let result = "";
    const block: number[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      block.push(view.getUint16(offset, true));
      if (block.length === 4096) {
        result += String.fromCharCode(...block);
        block.length = 0;
      }
    }
    if (block.length > 0) result += String.fromCharCode(...block);
    if (hasOnlyPairedSurrogates(result)) {
      fail("invalid_value", "paired Unicode strings must use canonical UTF-8 encoding");
    }
    return result;
  }
  fail("invalid_value", "portable string has an unknown encoding");
}

export function encodeReal(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

export function decodeReal(value: string): number {
  let decoded: number;
  switch (value) {
    case "NaN":
      decoded = Number.NaN;
      break;
    case "Infinity":
      decoded = Number.POSITIVE_INFINITY;
      break;
    case "-Infinity":
      decoded = Number.NEGATIVE_INFINITY;
      break;
    case "-0":
      decoded = -0;
      break;
    default:
      if (value.length === 0 || value.trim() !== value) {
        fail("invalid_value", "real value is not canonical");
      }
      decoded = Number(value);
      if (!Number.isFinite(decoded) || encodeReal(decoded) !== value) {
        fail("invalid_value", "real value is not a canonical round-trippable double");
      }
  }
  return decoded;
}

function resolveKvLimits(limits: KvCodecLimits): {
  maxNodes: number;
  maxDepth: number;
  maxCollectionEntries: number;
} {
  const resolved = {
    maxNodes: limits.maxNodes ?? DEFAULT_KV_CODEC_LIMITS.maxNodes,
    maxDepth: limits.maxDepth ?? DEFAULT_KV_CODEC_LIMITS.maxDepth,
    maxCollectionEntries:
      limits.maxCollectionEntries ?? DEFAULT_KV_CODEC_LIMITS.maxCollectionEntries,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("invalid_argument", `${name} must be a non-negative safe integer`);
    }
  }
  return resolved;
}

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function typedArrayName(value: ArrayBufferView): PortableTypedArrayName {
  const name = value.constructor.name;
  if (isTypedArrayName(name)) return name;
  fail("unsupported_feature", `DO KV codec does not support ${name}`);
}

function expectTypedArrayName(value: unknown): PortableTypedArrayName {
  if (typeof value !== "string" || !isTypedArrayName(value)) {
    fail("invalid_value", "typed array has an unknown name");
  }
  return value;
}

function isTypedArrayName(value: string): value is PortableTypedArrayName {
  return TYPED_ARRAY_NAMES.has(value as PortableTypedArrayName);
}

const TYPED_ARRAY_NAMES = new Set<PortableTypedArrayName>([
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

type TypedArrayConstructor = new (
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
) => ArrayBufferView;

function createTypedArray(
  name: PortableTypedArrayName,
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
): ArrayBufferView {
  try {
    if (name === "DataView") return new DataView(buffer, byteOffset, length);
    const constructor = globalThis[name] as unknown as TypedArrayConstructor;
    return new constructor(buffer, byteOffset, length);
  } catch (error) {
    fail("invalid_value", `typed array bounds are invalid: ${String(error)}`);
  }
}

function rejectArrayProperties(value: unknown[]): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("unsupported_feature", "DO KV codec does not support array symbol properties");
  }
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      fail("unsupported_feature", "DO KV codec does not support extra array properties");
    }
  }
}

function parseCanonicalInteger(value: string): bigint {
  if (!/^(0|-?[1-9][0-9]*)$/.test(value) || value === "-0") {
    fail("invalid_value", "integer is not a canonical decimal");
  }
  return BigInt(value);
}

function parseCanonicalUnsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_value", `${label} is not a canonical unsigned decimal`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_value", `${label} is outside the unsigned 64-bit range`);
  }
  return parsed;
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("limit_exceeded", `${label} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail("invalid_value", `${label} is outside the unsigned 32-bit range`);
  }
}

function expectU32(value: unknown, label: string): number {
  if (typeof value !== "number") fail("invalid_value", `${label} must be a number`);
  assertU32(value, label);
  return value;
}

function assertNonEmptyIdentifier(value: string, label: string): void {
  assertValidUnicode(value);
  if (value.length === 0 || textEncoder.encode(value).byteLength > 1024) {
    fail("invalid_value", `${label} must contain between 1 and 1024 UTF-8 bytes`);
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_value", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") fail("invalid_value", `${label} must be a string`);
  return value;
}

function expectExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid_value", `${label} has unexpected or missing fields`);
  }
}

function expectPairArray(value: unknown, label: string): readonly (readonly unknown[])[] {
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    fail("invalid_value", `${label} must be an array of pairs`);
  }
  return value;
}

const KV_HOLE = Symbol("gsv-kv-hole");
