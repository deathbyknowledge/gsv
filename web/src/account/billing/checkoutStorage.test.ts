import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetCheckoutOperation,
  rememberedCheckoutOperation,
  rememberCheckoutOperation,
} from "./checkoutStorage";

describe("checkout operation storage", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("retains one idempotency key across a hosted checkout round trip", () => {
    const key = "01933f6a-3f88-7d3f-8b27-6b1d3d5ab638";
    rememberCheckoutOperation("inst_fixture", key);
    expect(rememberedCheckoutOperation("inst_fixture")).toBe(key);

    forgetCheckoutOperation("inst_fixture");
    expect(rememberedCheckoutOperation("inst_fixture")).toBeNull();
  });

  it("discards malformed browser state instead of replaying it", () => {
    values.set("gsv.billing.checkout.inst_fixture", "attacker-controlled");
    expect(rememberedCheckoutOperation("inst_fixture")).toBeNull();
    expect(values.has("gsv.billing.checkout.inst_fixture")).toBe(false);
  });
});
