import { describe, expect, it, vi } from "vitest";
import { matchHookPath, receiveHook } from "./event-hooks";
import { MAX_WEBHOOK_BYTES } from "./kernel/event-webhook";

const SOURCE = `src_${"a".repeat(32)}`;
const post = (path: string, body?: BodyInit) => new Request(`https://ada.example${path}`, { method: "POST", body });

describe("event hook route", () => {
  it("is only a POST to a well-formed source", () => {
    expect(matchHookPath(post(`/hooks/${SOURCE}`))).toEqual({ sourceId: SOURCE, token: null });
    expect(matchHookPath(post(`/hooks/${SOURCE}/tok_en-1`))).toEqual({ sourceId: SOURCE, token: "tok_en-1" });
    expect(matchHookPath(new Request(`https://ada.example/hooks/${SOURCE}`))).toBeNull();
    expect(matchHookPath(post("/hooks/nope"))).toBeNull();
    expect(matchHookPath(post(`/hooks/${SOURCE}/a/b`))).toBeNull();
  });

  it("hands the Kernel the exact bytes and passes back its answer", async () => {
    const receiveEventWebhook = vi.fn(async (_id: string, _token: string | null, _headers: [string, string][], _body: Uint8Array) => ({ status: 429, retryAfter: 60 }));
    const response = await receiveHook(post(`/hooks/${SOURCE}`, "hello"), { sourceId: SOURCE, token: null }, { receiveEventWebhook });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(new TextDecoder().decode(receiveEventWebhook.mock.calls[0]?.[3])).toBe("hello");
  });

  it("stops reading a body that is too large, before the Kernel sees it", async () => {
    const receiveEventWebhook = vi.fn(async () => ({ status: 200 }));
    const response = await receiveHook(post(`/hooks/${SOURCE}`, new Uint8Array(MAX_WEBHOOK_BYTES + 1)), { sourceId: SOURCE, token: null }, { receiveEventWebhook });
    expect(response.status).toBe(413);
    expect(receiveEventWebhook).not.toHaveBeenCalled();
  });
});
