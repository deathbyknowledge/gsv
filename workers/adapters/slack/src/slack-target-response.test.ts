import { describe, expect, it, vi } from "vitest";
import { bodyFromText } from "../../../../packages/gsv/src/protocol/body.js";
import { forwardSlackTargetResponse } from "./slack-target-response";
import type { SlackTargetResponse } from "./slack-target";

function response(body: ReturnType<typeof bodyFromText>): SlackTargetResponse & Disposable {
  return {
    type: "res", id: "read", ok: true,
    data: { ok: true, path: "/workspace.json", kind: "text", contentType: "application/json", size: body.length ?? 0 },
    body,
    [Symbol.dispose]: vi.fn(),
  };
}

describe("Slack target RPC body ownership", () => {
  it("keeps the upstream response alive through two forwarding hops", async () => {
    const upstream = response(bodyFromText("{\"workspace\":\"test\"}"));
    const middle = forwardSlackTargetResponse(upstream);
    const intermediate = Object.assign(middle, { [Symbol.dispose]: vi.fn() });
    const forwarded = forwardSlackTargetResponse(intermediate);
    expect(upstream[Symbol.dispose]).not.toHaveBeenCalled();
    expect(intermediate[Symbol.dispose]).not.toHaveBeenCalled();
    if (!forwarded.ok || !forwarded.body) throw new Error("Expected file bytes");
    expect(await new Response(forwarded.body.stream).text()).toBe('{"workspace":"test"}');
    expect(upstream[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(intermediate[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("cancels the source and disposes its response when the reader cancels", async () => {
    const cancel = vi.fn();
    const upstream = response({ stream: new ReadableStream({ cancel }), length: 1 });
    const forwarded = forwardSlackTargetResponse(upstream);
    if (!forwarded.ok || !forwarded.body) throw new Error("Expected file bytes");
    await forwarded.body.stream.cancel("unused file");
    expect(cancel).toHaveBeenCalledWith("unused file");
    expect(upstream[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("disposes the response after a source stream failure", async () => {
    const upstream = response({ stream: new ReadableStream({ pull(controller) { controller.error(new Error("broken source")); } }) });
    const forwarded = forwardSlackTargetResponse(upstream);
    if (!forwarded.ok || !forwarded.body) throw new Error("Expected file bytes");
    await expect(new Response(forwarded.body.stream).text()).rejects.toThrow("broken source");
    expect(upstream[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});
