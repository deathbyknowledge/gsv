import { describe, expect, it, vi } from "vitest";
import { createAttributedAiBindingFetch } from "../src/ai-gateway-fetch";

const ATTRIBUTION = { installationId: "space-a", logicalRequestId: "request-a" };

describe("AI Gateway request attribution", () => {
  it("records only structural counts and UTF-8 size without modifying a JSON request", async () => {
    const secret = "private fixture text 🔒";
    const body = JSON.stringify({
      messages: [
        { role: "system", content: secret },
        { role: "user", content: [{ type: "image_url", image_url: { url: secret } }] },
        { role: "assistant", content: null, reasoning_content: "", tool_calls: [
          { id: secret, function: { name: secret, arguments: secret } },
        ] },
        { role: "tool", tool_call_id: secret, content: secret },
        { role: "tool", tool_call_id: "unmatched", content: "" },
      ],
      tools: [{ function: { name: secret, description: secret } }],
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: true, private: secret },
    });
    const response = new Response(null, { status: 400 });
    const bindingFetch = vi.fn<typeof fetch>(async () => response);
    const fetch = createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, ATTRIBUTION);

    expect(await fetch("https://workers-binding.ai/compat/chat/completions", { method: "POST", body })).toBe(response);
    const init = bindingFetch.mock.calls[0]![1]!;
    expect(init.body).toBe(body);
    const metadata = new Headers(init.headers).get("cf-aig-metadata")!;
    expect(metadata).not.toContain("private");
    const parsed = JSON.parse(metadata);
    expect(Object.keys(parsed)).toHaveLength(5);
    expect(parsed["gsv.request_bytes"]).toBe(new TextEncoder().encode(body).byteLength);
    expect(JSON.parse(parsed["gsv.request_shape"])).toEqual({
      version: 1, messages: 5, users: 1, assistants: 1, toolResults: 2, toolCalls: 1,
      unmatchedToolResults: 1, images: 1, emptyMessages: 1, reasoningMessages: 1,
      emptyReasoningMessages: 1, tools: 1, maxTokens: 4096, thinking: true,
    });
  });

  it("forwards malformed JSON without retaining its contents or masking the provider response", async () => {
    const response = new Response(null, { status: 400 });
    const bindingFetch = vi.fn<typeof fetch>(async () => response);
    const fetch = createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, ATTRIBUTION);
    const body = "private invalid JSON";

    expect(await fetch("https://workers-binding.ai/compat/chat/completions", { method: "POST", body })).toBe(response);
    const init = bindingFetch.mock.calls[0]![1]!;
    expect(init.body).toBe(body);
    const metadata = new Headers(init.headers).get("cf-aig-metadata")!;
    expect(metadata).not.toContain("private");
    expect(JSON.parse(JSON.parse(metadata)["gsv.request_shape"])).toEqual({ version: 1, validJson: false });
  });

  it("forwards an invalid request without recording schema errors or private field values", async () => {
    const response = new Response(null, { status: 400 });
    const bindingFetch = vi.fn<typeof fetch>(async () => response);
    const fetch = createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, ATTRIBUTION);
    const body = JSON.stringify({ messages: [{ role: "user", content: { private: "private text" } }] });

    expect(await fetch("https://workers-binding.ai/compat/chat/completions", { method: "POST", body })).toBe(response);
    const init = bindingFetch.mock.calls[0]![1]!;
    expect(init.body).toBe(body);
    const metadata = new Headers(init.headers).get("cf-aig-metadata")!;
    expect(metadata).not.toContain("private");
    expect(JSON.parse(JSON.parse(metadata)["gsv.request_shape"])).toEqual({
      version: 1, validJson: true, validRequest: false,
    });
  });

  it("replaces forged metadata after merging without taking ownership of either body", async () => {
    const requestPull = vi.fn();
    const requestCancel = vi.fn();
    const responseCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: requestPull, cancel: requestCancel }, { highWaterMark: 0 });
    const requestInit = {
      method: "POST", body, duplex: "half",
      headers: { "cf-aig-metadata": JSON.stringify({ "gsv.installation_id": "forged-input" }) },
    };
    const input = new Request("https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions", requestInit);
    const response = new Response(new ReadableStream({ cancel: responseCancel }, { highWaterMark: 0 }));
    const bindingFetch = vi.fn<typeof fetch>(async () => response);
    const fetch = createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, ATTRIBUTION);
    const headers = new Headers({
      "cf-aig-metadata": JSON.stringify({ "gsv.installation_id": "forged-init", "gsv.request_id": "forged", "gsv.attempt_id": "forged" }),
      "cf-aig-collect-log": "false", "cf-aig-collect-log-payload": "false", "content-type": "application/octet-stream",
    });

    expect(await fetch(input, { headers })).toBe(response);
    const [forwarded, init] = bindingFetch.mock.calls[0]!;
    expect(forwarded).toBe(input);
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("cf-aig-metadata")).not.toBe(headers.get("cf-aig-metadata"));
    expect(JSON.parse(new Headers(init?.headers).get("cf-aig-metadata")!)).toEqual({
      "gsv.installation_id": "space-a", "gsv.request_id": "request-a", "gsv.attempt_id": expect.any(String),
    });
    expect(new Headers(init?.headers).get("cf-aig-collect-log")).toBe("false");
    expect(new Headers(init?.headers).get("cf-aig-collect-log-payload")).toBe("false");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
    expect(input.bodyUsed).toBe(false);
    expect(response.bodyUsed).toBe(false);
    expect(requestPull).not.toHaveBeenCalled();
    await input.body!.cancel();
    await response.body!.cancel();
    expect(requestCancel).toHaveBeenCalledTimes(1);
    expect(responseCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent spaces isolated and creates a fresh identity for every dispatch", async () => {
    const bindingFetch = vi.fn<typeof fetch>(async () => new Response(null));
    const binding = { aiGatewayLogId: null, fetch: bindingFetch };
    const ownedAttribution = { ...ATTRIBUTION };
    const first = createAttributedAiBindingFetch(binding, ownedAttribution);
    const second = createAttributedAiBindingFetch(binding, { ...ATTRIBUTION, installationId: "space-b" });
    ownedAttribution.installationId = "changed-after-construction";
    await Promise.all([first("https://workers-binding.ai/first"), second("https://workers-binding.ai/second"), first("https://workers-binding.ai/retry")]);
    const metadata = bindingFetch.mock.calls.map(([, init]) => JSON.parse(new Headers(init?.headers).get("cf-aig-metadata")!));
    expect(metadata.map((value) => value["gsv.installation_id"])).toEqual(["space-a", "space-b", "space-a"]);
    expect(metadata.map((value) => value["gsv.request_id"])).toEqual(["request-a", "request-a", "request-a"]);
    const attempts = metadata.map((value) => value["gsv.attempt_id"]);
    expect(new Set(attempts).size).toBe(3);
    for (const attempt of attempts) expect(attempt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("forwards cancellation and the original request body to the binding", async () => {
    const controller = new AbortController();
    const body = new Uint8Array([1, 2, 3]);
    const bindingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      expect(init?.body).toBe(body);
      expect(init?.signal).toBe(controller.signal);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    }));
    const fetch = createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, ATTRIBUTION);
    const pending = fetch("https://workers-binding.ai/compat/chat/completions", { method: "POST", body, signal: controller.signal });
    const reason = new DOMException("cancelled by owner", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("requires owned attribution before any native provider dispatch", () => {
    const bindingFetch = vi.fn<typeof fetch>();
    expect(() => createAttributedAiBindingFetch({ aiGatewayLogId: null, fetch: bindingFetch }, undefined))
      .toThrow("Workers AI requires installation request attribution");
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});
