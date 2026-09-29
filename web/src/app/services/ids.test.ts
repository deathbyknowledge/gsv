import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./ids";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a version 4 UUID and never repeats", () => {
    const first = randomId();
    expect(first).toMatch(V4);
    expect(randomId()).not.toBe(first);
  });

  it("still yields a version 4 UUID where randomUUID is absent, as on a page that is not a secure context", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index * 17;
        return bytes;
      },
    });
    expect(randomId()).toMatch(V4);
    expect(randomId()).toBe(randomId());
  });
});
