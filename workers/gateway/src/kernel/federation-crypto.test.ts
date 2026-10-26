import { describe, expect, it } from "vitest";
import { canonicalJson } from "./federation-crypto";

describe("federation cryptography", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(canonicalJson({ z: 1, a: [3, 2, 1], nested: { b: true, a: false } }))
      .toBe('{"a":[3,2,1],"nested":{"a":false,"b":true},"z":1}');
  });
});
