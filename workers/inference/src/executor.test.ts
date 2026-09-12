import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JsonValue, decodeInferenceExecutionStream } from "@humansandmachines/gsv/protocol";
import type { InferenceExecutionRequest, InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import { RoutedInferenceTransport } from "../../gateway/src/inference/transport";
import { ExecutorStore } from "../../../packages/inference/src/executor/store";
import { executorLimits } from "../../../packages/inference/src/executor/config";

const serviceBinding: unknown = exports.default;
// SAFETY: The configured entrypoint implements the public execution service.
const service = serviceBinding as InferenceExecutionService;
const directoryBinding: unknown = env.INSTALLATION_DIRECTORY;
// SAFETY: The test-only directory implements setState in vitest.config.ts.
const directory = directoryBinding as { setState(id: string, state: string): Promise<void> };
function request(installationId: string, logicalRequestId = crypto.randomUUID()): InferenceExecutionRequest {
  return { version: 1, installationId, logicalRequestId, actor: { localUid: 1000 }, connection: { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", apiKey: "", maxTokens: 32, contextWindowTokens: null }, messages: [{ role: "user", content: "test input" }], timeoutMs: 10_000, deadlineAt: Date.now() + 10_000 };
}
function completion(): Response {
  const chunk = (data: JsonValue) => `data: ${JSON.stringify(data)}\n\n`;
  return new Response(chunk({ id: "response", choices: [{ index: 0, delta: { content: "hello" } }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function rows(id: string) {
  return runInDurableObject(env.INFERENCE_EXECUTORS.getByName(id), (_instance, state) => ({
    requests: state.storage.sql.exec("SELECT * FROM executor_requests ORDER BY accepted_at").toArray(),
    usage: state.storage.sql.exec("SELECT * FROM executor_usage").toArray(),
  }));
}
afterEach(() => vi.unstubAllGlobals());

class SelectedTransport extends RoutedInferenceTransport {
  readonly requested: string[];
  readonly aborted: string[] = [];
  private readonly state: { bodyCancelled: boolean };
  get bodyCancelled(): boolean { return this.state.bodyCancelled; }
  constructor(mode: "complete" | "stream" | "disconnect") {
    const requested: string[] = [];
    const state = { bodyCancelled: false };
    super(async (input, init) => {
      const request = new Request(input, init);
      requested.push(request.url);
      if (mode === "disconnect") throw new Error("Selected target disconnected");
      if (mode === "complete") return completion();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
        },
        cancel: () => { state.bodyCancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    this.requested = requested;
    this.state = state;
  }
  async abort(id: string): Promise<void> { this.aborted.push(id); await super.abort(id); }
}

function transportedRequest(id: string): InferenceExecutionRequest {
  const input = request(id);
  input.connection = { ...input.connection, provider: "custom", model: "test-model", baseUrl: "https://selected-target.invalid/v1", providerStyle: "openai-chat-completions", apiKey: "transient-test-credential" };
  return input;
}

describe("public inference executor RPC", () => {
  it("resolves operator defaults and newly available binding models", async () => {
    expect(await service.resolveModel("gsv", "default")).toMatchObject({ provider: "gsv", model: "default", contextWindowTokens: 1_310_720 });
    expect(await service.resolveModel("workers-ai", "@cf/test/new-model")).toMatchObject({ contextWindowTokens: 12345 });
  });
  it("rejects unknown installations before allocating durable state", async () => {
    const before = await listDurableObjectIds(env.INFERENCE_EXECUTORS);
    await expect(Promise.resolve(service.getExecutor("space_missing"))).rejects.toThrow("not active");
    expect(await listDurableObjectIds(env.INFERENCE_EXECUTORS)).toHaveLength(before.length);
  });

  it("keeps identities and monthly usage isolated between two installations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const a = await service.getExecutor("space_a");
    const b = await service.getExecutor("space_b");
    const input = request("space_a", "same-request");
    await expect(Promise.resolve(a.generate({ ...input, installationId: "space_b" }))).rejects.toThrow("scope mismatch");
    expect((await a.generate(input)).stopReason).toBe("stop");
    expect((await b.generate({ ...input, installationId: "space_b" })).stopReason).toBe("stop");
    expect((await rows("space_a")).usage[0]).toMatchObject({ requests: 1, output_tokens: 1, reserved_tokens: 0 });
    expect((await rows("space_b")).usage[0]).toMatchObject({ requests: 1, output_tokens: 1, reserved_tokens: 0 });
    await expect(Promise.resolve(a.generate(input))).rejects.toThrow("already been used");
    const serialized = JSON.stringify(await rows("space_a"));
    expect(serialized).not.toContain("test input");
    expect(serialized).not.toContain("hello");
  });

  it("attributes concurrent native dispatches to their owning spaces despite forged request metadata", async () => {
    const dispatched: { metadata: Record<string, string>; collectLog: string | null }[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const bindingFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      dispatched.push({
        // SAFETY: The assertions below validate the complete emitted metadata shape.
        metadata: JSON.parse(headers.get("cf-aig-metadata") ?? "{}") as Record<string, string>,
        collectLog: headers.get("cf-aig-collect-log"),
      });
      if (dispatched.length === 2) release();
      await held;
      return completion();
    });
    vi.stubGlobal("fetch", bindingFetch);
    const ids = ["space_metadata_a", "space_metadata_b"];
    const executors = await Promise.all(ids.map((id) => service.getExecutor(id)));
    const inputs = ids.map((id) => ({
      ...request(id, "same-logical-request"),
      attribution: { installationId: "forged-space", logicalRequestId: "forged-request", attemptId: "forged-attempt" },
      metadata: { "gsv.installation_id": "forged-space", "gsv.request_id": "forged-request", "gsv.attempt_id": "forged-attempt" },
    }));
    await expect(Promise.resolve(executors[0]!.generate(inputs[1]!))).rejects.toThrow("scope mismatch");
    expect(bindingFetch).not.toHaveBeenCalled();

    const results = await Promise.all(executors.map((executor, index) => executor.generate(inputs[index]!)));
    expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop"]);
    expect(bindingFetch).toHaveBeenCalledTimes(2);
    expect(dispatched.map((entry) => entry.metadata["gsv.installation_id"]).sort()).toEqual(ids);
    for (const entry of dispatched) {
      expect(entry.metadata).toEqual({
        "gsv.installation_id": expect.stringMatching(/^space_metadata_[ab]$/),
        "gsv.request_id": "same-logical-request",
        "gsv.attempt_id": expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      });
      expect(entry.collectLog).toBe("false");
    }
    expect(new Set(dispatched.map((entry) => entry.metadata["gsv.attempt_id"])).size).toBe(2);
  });

  it("streams generic provider identity through the real RPC codec", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const executor = await service.getExecutor("space_stream");
    const stream = await executor.generateStream(request("space_stream"));
    const events = [];
    for await (const event of decodeInferenceExecutionStream(stream)) events.push(event);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "hello")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { provider: "workers-ai", stopReason: "stop" } });
  });

  it("rechecks restriction at admission while allowing cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const executor = await service.getExecutor("space_restricted");
    await directory.setState("space_restricted", "restricted");
    await expect(Promise.resolve(executor.generate(request("space_restricted")))).rejects.toThrow("not active");
    await executor.abort("cancel-before-arrival");
    expect((await executor.generate(request("space_restricted", "cancel-before-arrival"))).stopReason).toBe("aborted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the first cancellation reason when abort overtakes admission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const executor = await service.getExecutor("space_abort");
    await executor.abort("early", "cancelled");
    await executor.abort("early", "timeout");
    const input = request("space_abort", "early");
    input.deadlineAt = Date.now() - 1;
    expect((await executor.generate(input)).stopReason).toBe("aborted");
    await executor.abort("expired", "timeout");
    expect(await executor.generate(request("space_abort", "expired"))).toMatchObject({ stopReason: "error", errorMessage: "Inference deadline exceeded" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a stuck directory lookup by the supplied deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const executor = await service.getExecutor("space_stuck_admission");
    await directory.setState("space_stuck_admission", "stuck");
    const input = request("space_stuck_admission");
    input.deadlineAt = Date.now() + 40;
    expect(await executor.generate(input)).toMatchObject({ stopReason: "error", errorMessage: "Inference deadline exceeded" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await rows(input.installationId)).usage).toHaveLength(0);
  });

  it("expires a provider that never responds and fences a late completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 100)); return completion(); }));
    const executor = await service.getExecutor("space_timeout");
    const input = request("space_timeout");
    input.deadlineAt = Date.now() + 80;
    const result = await executor.generate(input);
    expect(result).toMatchObject({ stopReason: "error", errorMessage: "Inference deadline exceeded" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await rows(input.installationId)).requests[0]).toMatchObject({ state: "timeout", output_tokens: 32, reserved_tokens: 0 });
  });

  it("cancels native response bodies that arrive after the deadline", async () => {
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const cancel = vi.fn(() => { cancelled(); });
    vi.stubGlobal("fetch", vi.fn(async () => {
      entered();
      await held;
      return new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } });
    }));
    const executor = await service.getExecutor("space_late_body");
    const input = request("space_late_body");
    const pending = Promise.resolve(executor.generate(input));
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await dispatched;
      expect(fetch).toHaveBeenCalledTimes(1);
      // Expire admitted work through the real persisted deadline, independently of RPC startup time.
      clock = vi.spyOn(Date, "now").mockReturnValue(input.deadlineAt + 1);
      await runDurableObjectAlarm(env.INFERENCE_EXECUTORS.getByName(input.installationId));
      expect(await pending).toMatchObject({ stopReason: "error", errorMessage: "Inference deadline exceeded" });
      expect(cancel).not.toHaveBeenCalled();
      release();
      await cancellation;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect((await rows(input.installationId)).requests[0]).toMatchObject({ state: "timeout", reserved_tokens: 0 });
    } finally {
      clock?.mockRestore();
      release();
      await env.INFERENCE_EXECUTORS.getByName(input.installationId).abort(input.logicalRequestId);
      await pending;
    }
  });

  it("reserves capacity across concurrent requests and enforces request limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion()));
    const executor = await service.getExecutor("space_limits");
    for (let index = 0; index < 3; index++) expect((await executor.generate(request("space_limits"))).stopReason).toBe("stop");
    await expect(Promise.resolve(executor.generate(request("space_limits")))).rejects.toThrow("request limit");
    expect((await rows("space_limits")).usage[0]).toMatchObject({ requests: 3, reserved_tokens: 0 });
  });

  it("holds token reservations across concurrent requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return completion(); }));
    const executor = await service.getExecutor("space_concurrent");
    const first = request("space_concurrent");
    first.connection.maxTokens = 64;
    const pending = Promise.resolve(executor.generate(first));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const second = request("space_concurrent");
    second.connection.maxTokens = 64;
    await expect(Promise.resolve(executor.generate(second))).rejects.toThrow("output token limit");
    await executor.abort(first.logicalRequestId);
    expect((await pending).stopReason).toBe("aborted");
    expect((await rows(first.installationId)).usage[0]).toMatchObject({ requests: 1, output_tokens: 64, reserved_tokens: 0 });
    await new Promise((resolve) => setTimeout(resolve, 220));
  });

  it("supports explicit unlimited monthly quotas while requiring positive request bounds", async () => {
    const id = "space_unlimited";
    await service.getExecutor(id);
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(id), (_instance, state) => {
      const store = new ExecutorStore(state.storage);
      const limits = { monthlyRequests: 0, monthlyOutputTokens: 0, maxOutputTokens: 64, maxDurationMs: 1000 };
      for (let count = 0; count < 5; count++) store.admit(`unlimited-${count}`, 1000, Date.now() + 1000, 64, limits);
      expect(state.storage.sql.exec("SELECT * FROM executor_usage").one()).toMatchObject({ requests: 5, reserved_tokens: 320 });
      store.recover();
    });
    const base = { INSTALLATION_DIRECTORY: { resolveInstallation: async () => ({ found: false as const }), resolveHostname: async () => ({ found: false as const }) } };
    expect(executorLimits({ ...base, INFERENCE_MONTHLY_REQUESTS: 0, INFERENCE_MONTHLY_OUTPUT_TOKENS: 0 })).toMatchObject({ monthlyRequests: 0, monthlyOutputTokens: 0 });
    expect(() => executorLimits({ ...base, INFERENCE_MAX_OUTPUT_TOKENS: 0 })).toThrow("operator limit");
    expect(() => executorLimits({ ...base, INFERENCE_MAX_DURATION_MS: 0 })).toThrow("operator limit");
  });

  it("uses the selected transport across RPC without persisting credentials", async () => {
    const executor = await service.getExecutor("space_transport");
    const transport = new SelectedTransport("complete");
    const stream = await executor.generateStream(transportedRequest("space_transport"), transport);
    const events = [];
    for await (const event of decodeInferenceExecutionStream(stream)) events.push(event);
    const last = events.at(-1);
    if (last?.type === "error") throw new Error(last.error.errorMessage);
    expect(last).toMatchObject({ type: "done" });
    expect(transport.requested).toEqual(["https://selected-target.invalid/v1/chat/completions"]);
    expect(JSON.stringify(await rows("space_transport"))).not.toContain("transient-test-credential");
  });

  it("propagates explicit cancellation through RPC to an open provider body", async () => {
    const executor = await service.getExecutor("space_transport_abort");
    const transport = new SelectedTransport("stream");
    const input = transportedRequest("space_transport_abort");
    const stream = await executor.generateStream(input, transport);
    const iterator = decodeInferenceExecutionStream(stream);
    for (let count = 0; count < 20; count++) {
      const event = await iterator.next();
      expect(event.done).toBe(false);
      expect(event.value?.type).not.toBe("error");
      if (event.value?.type === "text_delta") break;
    }
    await executor.abort(input.logicalRequestId);
    const terminal = await iterator.next();
    expect(terminal.value).toMatchObject({ type: "error", reason: "aborted" });
    await iterator.return(undefined);
    await vi.waitFor(() => expect(transport.aborted).toHaveLength(1));
    await vi.waitFor(() => expect(transport.bodyCancelled).toBe(true));
  });

  it("settles a disconnected selected transport without a fallback request", async () => {
    const executor = await service.getExecutor("space_disconnect");
    const transport = new SelectedTransport("disconnect");
    const stream = await executor.generateStream(transportedRequest("space_disconnect"), transport);
    const events = [];
    for await (const event of decodeInferenceExecutionStream(stream)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(transport.requested).toHaveLength(1);
    expect((await rows("space_disconnect")).requests[0]).toMatchObject({ state: "error", reserved_tokens: 0 });
  });

  it("executes media with a separate body and cancels an oversized body", async () => {
    const executor = await service.getExecutor("space_media");
    const identity = request("space_media");
    const input = { ...identity, kind: "transcription" as const, input: { provider: "workers-ai", model: "@cf/openai/whisper-large-v3-turbo", maxInputBytes: 4 } };
    const result = await executor.media(input, new Response(new Uint8Array([1, 2])).body!);
    expect(result).toMatchObject({ kind: "transcription", result: { text: "transcribed" } });
    await expect(Promise.resolve(executor.media({ ...input, logicalRequestId: "oversized" }, new Response(new Uint8Array(5)).body!))).rejects.toThrow("too large");
  });

  it("recovers interrupted reservations and expires request metadata by alarm", async () => {
    const id = "space_restart";
    await service.getExecutor(id);
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(id), async (_instance, state) => {
      const store = new ExecutorStore(state.storage);
      store.admit("lost", 1000, Date.now() + 1000, 25, { monthlyRequests: 3, monthlyOutputTokens: 100, maxOutputTokens: 64, maxDurationMs: 1000 });
      store.recover();
      expect(store.get("lost")).toMatchObject({ state: "interrupted", output_tokens: 25 });
      state.storage.sql.exec("UPDATE executor_requests SET expires_at = ?", Date.now() - 1);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(env.INFERENCE_EXECUTORS.getByName(id));
    expect((await rows(id)).requests).toHaveLength(0);
  });
});
