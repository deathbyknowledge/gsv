import { describe, expect, it, vi } from "vitest";
import {
  deepSeekIsolatingFetch,
  mapDeepSeekReasoning,
  opaqueDeepSeekUserId,
} from "./deepseek";

describe("DeepSeek managed provider boundary", () => {
  it("adds an opaque per-installation actor user_id and attempt correlation", async () => {
    const userId = await opaqueDeepSeekUserId("inst_private", 1000);
    const fetchMock = vi.fn(async () => new Response("ok"));
    const isolatedFetch = deepSeekIsolatingFetch(
      userId,
      "request:attempt:1",
      fetchMock as typeof fetch,
    );

    await isolatedFetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });

    const forwarded = fetchMock.mock.calls[0]![0] as Request;
    expect(await forwarded.clone().json()).toMatchObject({ user_id: userId });
    expect(forwarded.headers.get("x-client-request-id")).toBe("request:attempt:1");
    expect(userId).toMatch(/^gsv_[a-f0-9]{64}$/);
    expect(userId).not.toContain("inst_private");
  });

  it("fails closed for provider requests outside the approved endpoint", async () => {
    const isolatedFetch = deepSeekIsolatingFetch(
      "gsv_opaque",
      "request:attempt:1",
      vi.fn() as typeof fetch,
    );

    await expect(isolatedFetch("https://example.com/chat/completions", {
      method: "POST",
      body: "{}",
    })).rejects.toThrow("target is not allowed");
  });

  it("maps the stable product reasoning levels to this release", () => {
    expect(mapDeepSeekReasoning("off")).toBeUndefined();
    expect(mapDeepSeekReasoning("minimal")).toBe("low");
    expect(mapDeepSeekReasoning("medium")).toBe("high");
    expect(mapDeepSeekReasoning("xhigh")).toBe("high");
    expect(mapDeepSeekReasoning("max")).toBe("max");
  });
});
