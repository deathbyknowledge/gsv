import { describe, expect, it } from "vitest";
import { CATALOG, ERROR_CODES, GsvFailure, isRetryable, KIND_VERBS, toGsvError } from "../src/index.ts";

describe("catalog", () => {
  it("gives every operation a schema, a timeout, a verb its kind has and only listed error codes", () => {
    for (const def of CATALOG.values()) {
      expect(def.timeoutMs, def.name).toBeGreaterThan(0);
      expect(KIND_VERBS[def.kind] as readonly string[], def.name).toContain(def.verb);
      for (const code of def.errors) expect(Object.keys(ERROR_CODES), def.name).toContain(code);
      expect(def.doc.length, def.name).toBeGreaterThan(0);
    }
  });

  it("sets retryable on the server side, with timeouts retryable only for reads", () => {
    const read = CATALOG.get("connect");
    expect(isRetryable("unavailable")).toBe(true);
    expect(isRetryable("forbidden")).toBe(false);
    expect(isRetryable("timeout", read)).toBe(true);
    expect(isRetryable("timeout", read && { ...read, effect: "effect" })).toBe(false);
  });

  it("restores a failure that crossed Workers RPC as a plain error with its fields", () => {
    const crossed = Object.assign(new Error("The owner moved."), { name: "GsvFailure", code: "moved", details: { generation: 2 } });
    expect(toGsvError(crossed, undefined)).toEqual({ code: "moved", message: "The owner moved.", retryable: true, details: { generation: 2 } });
    expect(GsvFailure.revive(Object.assign(new Error("x"), { name: "GsvFailure", code: "made_up" }))).toBeUndefined();
  });

  it("hides anything that isn't a failure behind internal with a reference", () => {
    expect(toGsvError(new TypeError("secret detail"), undefined, "ref-1")).toEqual({ code: "internal", message: "Something went wrong on our side.", retryable: false, ref: "ref-1" });
  });
});
