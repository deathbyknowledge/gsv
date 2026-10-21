import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeInferenceExecutionStream, type AiImageContent, type JsonValue } from "@humansandmachines/gsv/protocol";
import { encodeInferenceRequest, type InferenceRequest } from "@humansandmachines/gsv/services/inference-body";
import type { InferenceExecutionRequest, InferenceExecutionService, InferenceExecutor, InferenceTransport } from "@humansandmachines/gsv/services/inference-execution";
import type { ManagedInferenceResult } from "@humansandmachines/gsv/services/inference";
import { RoutedInferenceTransport } from "../../gateway/src/inference/transport";

const serviceBinding: unknown = exports.default;
// SAFETY: The configured Worker entrypoint implements this public RPC contract.
const service = serviceBinding as InferenceExecutionService;

function request(): InferenceExecutionRequest {
  return {
    version: 1,
    installationId: `space_body_${crypto.randomUUID()}`,
    logicalRequestId: crypto.randomUUID(),
    diagnosticId: crypto.randomUUID(),
    actor: { localUid: 1000 },
    connection: {
      provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", apiKey: "",
      maxTokens: 32, contextWindowTokens: null,
    },
    messages: [{ role: "user", content: "inspect the attached images", timestamp: 123 }],
    timeoutMs: 60_000,
    deadlineAt: Date.now() + 60_000,
  };
}

function completion(): Response {
  const chunk = (data: JsonValue) => `data: ${JSON.stringify(data)}\n\n`;
  return new Response(
    chunk({ id: "body-response", choices: [{ index: 0, delta: { content: "images received" } }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function generate(
  executor: InferenceExecutor,
  input: InferenceRequest<InferenceExecutionRequest>,
  streaming: boolean,
  transport?: InferenceTransport,
): Promise<ManagedInferenceResult> {
  if (!streaming) return executor.generate(input, transport);
  for await (const event of decodeInferenceExecutionStream(await executor.generateStream(input, transport))) {
    if (event.type === "done") return event.message;
    if (event.type === "error") return event.error;
  }
  throw new Error("Missing terminal inference result");
}

async function rows(installationId: string) {
  return runInDurableObject(env.INFERENCE_EXECUTORS.getByName(installationId), (_instance, state) => ({
    requests: state.storage.sql.exec("SELECT * FROM executor_requests ORDER BY accepted_at").toArray(),
    usage: state.storage.sql.exec("SELECT * FROM executor_usage").toArray(),
  }));
}

/** Deliver a first chunk, then leave upload completion under the test's control. */
function heldUpload(input: InferenceExecutionRequest) {
  const encoded = encodeInferenceRequest(input);
  const source = encoded.contextBody.stream;
  const reader = source.getReader();
  const waiting = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let first = true;
  let closed = false;
  const stream: ReadableStream<Uint8Array> = new ReadableStream({
    type: "bytes",
    async pull(controller) {
      if (!first) {
        waiting.resolve();
        await released.promise;
      }
      first = false;
      if (closed) return;
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      released.resolve();
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  });
  return {
    input: { ...encoded, contextBody: { ...encoded.contextBody, stream } },
    waiting: waiting.promise,
    release: released.resolve,
    source,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inference request bodies over real Worker RPC", () => {
  it.each([
    { source: "user", streaming: false },
    { source: "user", streaming: true },
    { source: "toolResult", streaming: false },
    { source: "toolResult", streaming: true },
  ] as const)("delivers fifteen $source images above the RPC value limit, streaming=$streaming", async ({ source, streaming }) => {
    const input = request();
    if (streaming) {
      input.connection = {
        ...input.connection, provider: "custom", model: "body-test-model",
        baseUrl: "https://selected-target.invalid/v1", providerStyle: "openai-chat-completions",
        apiKey: "synthetic-body-test-credential",
      };
    }
    const images: AiImageContent[] = Array.from({ length: 15 }, (_, index) => ({
      type: "image",
      data: btoa(String.fromCharCode(index + 1).repeat(1_750_000 + index)),
      mimeType: index % 2 === 0 ? "image/png" : "image/jpeg",
    }));
    input.systemPrompt = "Keep every image in its original order.";
    input.messages = source === "user" ? [{
      role: "user",
      content: [{ type: "text", text: "inspect the attached images" }, ...images],
      timestamp: 123,
    }] : [{
      role: "user", content: "Read and inspect the images.", timestamp: 123,
    }, {
      role: "assistant",
      content: [{ type: "toolCall", id: "body-image-call", name: "read_images", arguments: { count: 15 } }],
      api: "openai-completions", provider: input.connection.provider, model: input.connection.model,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse", timestamp: 124,
    }, {
      role: "toolResult", toolCallId: "body-image-call", toolName: "read_images", isError: false,
      content: [{ type: "text", text: "inspect the attached images" }, ...images],
      timestamp: 125,
    }];
    input.tools = [{
      name: "read_images",
      description: "Read the requested number of images.",
      parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
    }];
    input.options = { maxTokens: 17 };
    input.sessionAffinityKey = "body-fixture-affinity";

    // These are synthetic bytes: no production image, prompt or credential is used.
    expect(images.reduce((total, image) => total + image.data.length, 0)).toBeGreaterThan(32 * 1024 * 1024);
    let observed: {
      maxTokens: number;
      system: unknown;
      tools: unknown;
      contentTypes: string[];
      text?: string;
      roles: string[];
      toolCalls: unknown;
      toolResults: unknown[];
      exactImages: boolean[];
      metadata: Record<string, string>;
    } | undefined;
    const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
      const outbound = new Request(url, init);
      const payload = await outbound.json<{
        model: string;
        max_tokens: number;
        messages: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          tool_call_id?: string;
        }>;
        tools: Array<{ type: string; function: { name: string; description: string; parameters: JsonValue } }>;
      }>();
      const userContent = payload.messages.find((message) => message.role === "user"
        && Array.isArray(message.content) && message.content.some((block) => block.type === "image_url"))?.content;
      const content = Array.isArray(userContent) ? userContent : [];
      observed = {
        maxTokens: payload.max_tokens,
        system: payload.messages[0],
        tools: payload.tools,
        contentTypes: content.map((block) => block.type),
        text: content[0]?.text,
        roles: payload.messages.map((message) => message.role),
        toolCalls: payload.messages.find((message) => message.role === "assistant")?.tool_calls,
        toolResults: payload.messages.filter((message) => message.role === "tool"),
        exactImages: images.map((image, index) => content[index + 1]?.image_url?.url === `data:${image.mimeType};base64,${image.data}`),
        metadata: JSON.parse(outbound.headers.get("cf-aig-metadata") ?? "{}"),
      };
      return completion();
    });
    vi.stubGlobal("fetch", providerFetch);
    const encoded = encodeInferenceRequest(input);
    expect(JSON.stringify(encoded).length).toBeLessThan(2_000);
    expect(encoded).not.toHaveProperty("messages");
    expect(encoded).not.toHaveProperty("systemPrompt");
    expect(encoded).not.toHaveProperty("tools");
    // SAFETY: The actual Worker RPC target owns the platform's disposer.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    const transport = streaming ? new RoutedInferenceTransport(providerFetch) : undefined;
    try {
      const result = await generate(executor, encoded, streaming, transport);
      expect(result.errorMessage).toBeUndefined();
      expect(result).toMatchObject({
        stopReason: "stop", content: [{ type: "text", text: "images received" }],
      });
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(observed).toMatchObject({
        maxTokens: 17,
        system: { role: "system", content: input.systemPrompt },
        tools: [{ type: "function", function: input.tools[0] }],
        contentTypes: ["text", ...images.map(() => "image_url")],
        exactImages: images.map(() => true),
      });
      if (source === "toolResult") {
        expect(observed).toMatchObject({
          roles: ["system", "user", "assistant", "tool", "user"],
          toolCalls: [{
            id: "body-image-call", type: "function",
            function: { name: "read_images", arguments: '{"count":15}' },
          }],
          toolResults: [{
            role: "tool", tool_call_id: "body-image-call", content: "inspect the attached images",
          }],
        });
      } else {
        expect(observed).toMatchObject({
          roles: ["system", "user"], text: "inspect the attached images", toolResults: [],
        });
      }
      if (!streaming) {
        expect(observed?.metadata).toMatchObject({
          "gsv.installation_id": input.installationId,
          "gsv.request_id": input.logicalRequestId,
        });
      }
      expect(await rows(input.installationId)).toMatchObject({
        requests: [{ state: "completed", output_tokens: 1, reserved_tokens: 0 }],
        usage: [{ requests: 1, output_tokens: 1, reserved_tokens: 0 }],
      });
      const stored = JSON.stringify(await rows(input.installationId));
      expect(stored).not.toContain("inspect the attached images");
      expect(stored).not.toContain("synthetic-body-test-credential");
    } finally {
      transport?.close();
      await executor.abort(input.logicalRequestId);
    }
  }, 60_000);

  it.each([false, true])("cancels a pending upload before provider dispatch, streaming=%s", async (streaming) => {
    const providerFetch = vi.fn<typeof fetch>(async () => completion());
    vi.stubGlobal("fetch", providerFetch);
    const input = request();
    const upload = heldUpload(input);
    // SAFETY: The actual Worker RPC target owns the platform's disposer.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    const pending = generate(executor, upload.input, streaming);
    try {
      await upload.waiting;
      await vi.waitFor(async () => expect((await rows(input.installationId)).requests).toMatchObject([{ state: "active" }]));
      await executor.abort(input.logicalRequestId);
      expect(await pending).toMatchObject({ stopReason: "aborted" });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(await rows(input.installationId)).toMatchObject({
        requests: [{ state: "cancelled", output_tokens: 0, reserved_tokens: 0 }],
        usage: [{ requests: 1, output_tokens: 0, reserved_tokens: 0 }],
      });
      upload.release();
      await vi.waitFor(() => expect(upload.source.locked).toBe(false));
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      upload.release();
      await executor.abort(input.logicalRequestId);
      await pending;
    }
  });

  it.each([false, true])("applies the durable deadline while an upload is incomplete, streaming=%s", async (streaming) => {
    const providerFetch = vi.fn<typeof fetch>(async () => completion());
    vi.stubGlobal("fetch", providerFetch);
    const input = request();
    const upload = heldUpload(input);
    // SAFETY: The actual Worker RPC target owns the platform's disposer.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    const pending = generate(executor, upload.input, streaming);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await upload.waiting;
      await vi.waitFor(async () => expect((await rows(input.installationId)).requests).toMatchObject([{ state: "active" }]));
      clock = vi.spyOn(Date, "now").mockReturnValue(input.deadlineAt + 1);
      await runDurableObjectAlarm(env.INFERENCE_EXECUTORS.getByName(input.installationId));
      expect(await pending).toMatchObject({ stopReason: "error", errorMessage: "Inference deadline exceeded" });
      expect(await rows(input.installationId)).toMatchObject({
        requests: [{ state: "timeout", output_tokens: 0, reserved_tokens: 0 }],
        usage: [{ requests: 1, output_tokens: 0, reserved_tokens: 0 }],
      });
      upload.release();
      await vi.waitFor(() => expect(upload.source.locked).toBe(false));
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      clock?.mockRestore();
      upload.release();
      await executor.abort(input.logicalRequestId);
      await pending;
    }
  });

  it.each([false, true])("rejects malformed multipart intake without provider work or output usage, streaming=%s", async (streaming) => {
    const providerFetch = vi.fn<typeof fetch>(async () => completion());
    vi.stubGlobal("fetch", providerFetch);
    const input = request();
    const encoded = encodeInferenceRequest(input);
    await encoded.contextBody.stream.cancel();
    const malformed = {
      ...encoded,
      contextBody: {
        contentType: "multipart/form-data; boundary=body-test",
        stream: new Response("--body-test\r\ninvalid multipart headers\r\n\r\nbroken\r\n--body-test--\r\n").body!,
      },
    };
    // SAFETY: The actual Worker RPC target owns the platform's disposer.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    await expect(generate(executor, malformed, streaming)).rejects.toThrow();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await rows(input.installationId)).toMatchObject({
      requests: [{ state: "error", output_tokens: 0, reserved_tokens: 0 }],
      usage: [{ requests: 1, output_tokens: 0, reserved_tokens: 0 }],
    });
  });

  it.each(["scope", "pre-abort"] as const)("rejects %s before consuming the context or calling a provider", async (reason) => {
    const providerFetch = vi.fn<typeof fetch>(async () => completion());
    vi.stubGlobal("fetch", providerFetch);
    const input = request();
    // SAFETY: The actual Worker RPC target owns the platform's disposer.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    if (reason === "scope") input.installationId = `other_${crypto.randomUUID()}`;
    else await executor.abort(input.logicalRequestId);
    const upload = heldUpload(input);
    try {
      if (reason === "scope") await expect(generate(executor, upload.input, false)).rejects.toThrow("scope mismatch");
      else expect(await generate(executor, upload.input, false)).toMatchObject({ stopReason: "aborted" });
      expect(providerFetch).not.toHaveBeenCalled();
      upload.release();
      await vi.waitFor(() => expect(upload.source.locked).toBe(false));
    } finally {
      upload.release();
      await executor.abort(input.logicalRequestId);
    }
  });

  it("claims an identity before upload and never replays a concurrent or completed request", async () => {
    const providerFetch = vi.fn<typeof fetch>(async () => completion());
    vi.stubGlobal("fetch", providerFetch);
    const input = request();
    const upload = heldUpload(input);
    // SAFETY: The actual Worker RPC targets own the platform's disposers.
    using executor = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    // SAFETY: This independently acquired Worker RPC target has its own disposer.
    using duplicate = await service.getExecutor(input.installationId) as InferenceExecutor & Disposable;
    const pending = generate(executor, upload.input, false);
    try {
      await upload.waiting;
      await vi.waitFor(async () => expect((await rows(input.installationId)).requests).toMatchObject([{ state: "active" }]));
      await expect(generate(duplicate, encodeInferenceRequest(input), true)).rejects.toThrow("already been used");
      expect(providerFetch).not.toHaveBeenCalled();
      upload.release();
      expect(await pending).toMatchObject({ stopReason: "stop" });
      await expect(generate(duplicate, encodeInferenceRequest(input), false)).rejects.toThrow("already been used");
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(await rows(input.installationId)).toMatchObject({
        requests: [{ state: "completed", reserved_tokens: 0 }],
        usage: [{ requests: 1, output_tokens: 1, reserved_tokens: 0 }],
      });
    } finally {
      upload.release();
      await executor.abort(input.logicalRequestId);
      await pending;
    }
  });
});
