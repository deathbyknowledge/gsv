import { describe, expect, it } from "vitest";
import {
  PortableArchiveError,
  canonicalJsonBytes,
  canonicalizeJson,
  parseCanonicalJson,
} from "../src/index";

describe("RFC 8785 canonical JSON", () => {
  it("sorts object names and uses ECMAScript number and string serialization", () => {
    expect(
      canonicalizeJson({
        z: 1e30,
        a: "€$\u000f\nA'B\"\\\"/",
        numbers: [333333333.33333329, 1e-27, -0],
      }),
    ).toBe(
      "{\"a\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\",\"numbers\":[333333333.3333333,1e-27,0],\"z\":1e+30}",
    );
  });

  it("accepts only the exact canonical UTF-8 representation", () => {
    const canonical = canonicalJsonBytes({ a: 1, b: [true, null] });
    expect(parseCanonicalJson(canonical)).toEqual({ a: 1, b: [true, null] });
    expect(() => parseCanonicalJson(new TextEncoder().encode('{"b":[],"a":1}'))).toThrowError(
      PortableArchiveError,
    );
    expect(() => parseCanonicalJson(new TextEncoder().encode('{"a":1,"a":1}'))).toThrow(
      /canonical/,
    );
  });

  it("rejects values outside the canonical JSON data model", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalizeJson([, 1])).toThrow(/holes/);
    expect(() => canonicalizeJson("\ud800")).toThrow(/surrogate/);
    expect(() => canonicalizeJson(new Date())).toThrow(/plain/);
    expect(() => canonicalizeJson(cyclic)).toThrow(/cyclic/);
    expect(() => canonicalizeJson({ a: { b: 1 } }, { maxDepth: 1 })).toThrow(/nesting/);
  });
});
