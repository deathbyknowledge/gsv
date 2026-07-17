import { describe, expect, it } from "vitest";

import {
  assertR2ObjectSize,
  r2ObjectLimit,
} from "./storage-policy";

describe("deployment R2 object policy", () => {
  it("leaves storage unconstrained when no deployment limit is configured", () => {
    expect(r2ObjectLimit({})).toBeUndefined();
  });

  it("accepts an explicit canonical deployment limit", () => {
    expect(r2ObjectLimit({ GSV_MAX_R2_OBJECT_BYTES: "123" })).toBe(123);
  });

  it("fails closed on malformed configuration and oversized objects", () => {
    expect(() => r2ObjectLimit({ GSV_MAX_R2_OBJECT_BYTES: "0123" }))
      .toThrow("positive integer");
    expect(() => assertR2ObjectSize(4, 5)).toThrow(
      "storage object exceeds 4 bytes",
    );
  });
});
