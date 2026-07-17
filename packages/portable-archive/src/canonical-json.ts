import { equalBytes } from "./bytes";
import { fail } from "./error";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type CanonicalJsonOptions = Readonly<{
  maxDepth?: number;
  maxBytes?: number;
}>;

const DEFAULT_MAX_DEPTH = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function canonicalizeJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    fail("invalid_argument", "canonical JSON maxDepth must be non-negative");
  }
  const ancestors = new Set<object>();

  function encode(current: unknown, depth: number): string {
    if (depth > maxDepth) {
      fail("limit_exceeded", "canonical JSON exceeds its nesting limit");
    }
    if (current === null) return "null";
    switch (typeof current) {
      case "boolean":
        return current ? "true" : "false";
      case "number": {
        if (!Number.isFinite(current)) {
          fail("invalid_value", "canonical JSON numbers must be finite");
        }
        return JSON.stringify(current);
      }
      case "string":
        assertValidUnicode(current);
        return JSON.stringify(current);
      case "object":
        break;
      default:
        fail("invalid_value", `canonical JSON cannot encode ${typeof current}`);
    }

    if (ancestors.has(current)) {
      fail("invalid_value", "canonical JSON cannot encode cyclic data");
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) {
            fail("invalid_value", "canonical JSON arrays cannot contain holes");
          }
          values.push(encode(current[index], depth + 1));
        }
        const extraKeys = Object.keys(current).filter(
          (key) => !isArrayIndexForLength(key, current.length),
        );
        if (extraKeys.length > 0 || Object.getOwnPropertySymbols(current).length > 0) {
          fail("invalid_value", "canonical JSON arrays cannot have extra properties");
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("invalid_value", "canonical JSON objects must be plain objects");
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        fail("invalid_value", "canonical JSON objects cannot have symbol keys");
      }
      const keys = Object.keys(current).sort(compareUtf16);
      const entries: string[] = [];
      for (const key of keys) {
        assertValidUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("invalid_value", "canonical JSON objects require enumerable data properties");
        }
        entries.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  const result = encode(value, 0);
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      fail("invalid_argument", "canonical JSON maxBytes must be non-negative");
    }
    if (encoder.encode(result).byteLength > maxBytes) {
      fail("limit_exceeded", "canonical JSON exceeds its byte limit");
    }
  }
  return result;
}

export function canonicalJsonBytes(
  value: unknown,
  options: CanonicalJsonOptions = {},
): Uint8Array {
  return encoder.encode(canonicalizeJson(value, options));
}

export function parseCanonicalJson(
  bytes: Uint8Array,
  options: CanonicalJsonOptions = {},
): CanonicalJsonValue {
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    fail("limit_exceeded", "canonical JSON exceeds its byte limit");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    fail("noncanonical_json", `canonical JSON is not valid UTF-8: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("noncanonical_json", `canonical JSON cannot be parsed: ${errorMessage(error)}`);
  }
  const canonical = canonicalJsonBytes(value, options);
  if (!equalBytes(bytes, canonical)) {
    fail("noncanonical_json", "JSON bytes are not in RFC 8785 canonical form");
  }
  return value as CanonicalJsonValue;
}

export function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        fail("invalid_value", "string contains an unpaired high surrogate");
      }
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        fail("invalid_value", "string contains an unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid_value", "string contains an unpaired low surrogate");
    }
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isArrayIndexForLength(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
