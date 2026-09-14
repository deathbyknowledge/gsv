import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { InferenceExecutionRequest, InferenceExecutionService, InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { DelayScope, DelayedControl } from "../../acceptance/delayed-inference/relay.ts";

const fixtureText = JSON.stringify({ type: "done", reason: "stop", message: {
  role: "assistant", content: [{ type: "text", text: "local upstream completed once" }], api: "local",
  provider: "local-fixture", model: "no-provider", stopReason: "stop", timestamp: 1,
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} }) + "\n";
const upstreamCalls = new Map<string, { generations: number; aborts: ("cancelled" | "timeout")[]; disposed: number }>();

/** No model/provider connection: this fixture proves only real RPC stream lifetime. */
class LocalExecutor extends RpcTarget implements InferenceExecutor {
  private requestIds = new Set<string>();
  [Symbol.dispose](): void { for (const id of this.requestIds) upstreamCalls.get(id)!.disposed++; }
  async generateStream(input: InferenceExecutionRequest): Promise<ReadableStream<Uint8Array>> {
    const calls = upstreamCalls.get(input.logicalRequestId) ?? { generations: 0, aborts: [], disposed: 0 };
    calls.generations++;
    this.requestIds.add(input.logicalRequestId);
    upstreamCalls.set(input.logicalRequestId, calls);
    return new Response(input.logicalRequestId === "bad-terminal" ? "not a terminal event\n" : fixtureText).body!;
  }
  async generate(): Promise<never> { throw new Error("Not part of the lifetime test"); }
  async media(): Promise<never> { throw new Error("Not part of the lifetime test"); }
  async abort(requestId: string, reason: "cancelled" | "timeout" = "cancelled"): Promise<void> {
    const calls = upstreamCalls.get(requestId);
    if (!calls) throw new Error("Original upstream request was not found");
    calls.aborts.push(reason);
  }
}

export class LocalUpstream extends WorkerEntrypoint implements InferenceExecutionService {
  async getExecutor(): Promise<InferenceExecutor> { return new LocalExecutor(); }
  async resolveModel(provider: string, model: string) { return { provider, model, contextWindowTokens: 1024 }; }
  async calls(requestId: string) { return upstreamCalls.get(requestId) ?? null; }
}

type Environment = { CONTROL: Service<DelayedControl>; RELAY: InferenceExecutionService; UPSTREAM: Service<LocalUpstream>;
  CALLERS: DurableObjectNamespace<Caller>; CONTROLLERS: DurableObjectNamespace<Controller> };

/** Holds the execution reader where GSV's Process owns it: inside workerd. */
export class Caller extends DurableObject<Environment> {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private result?: string;
  private receivedBytes = 0;
  private cancelledAt?: number;
  private streamFailed = false;
  private disposedHandleRejected = false;
  private executor?: InferenceExecutor;
  private scope?: DelayScope;
  async start(scope: DelayScope): Promise<void> {
    const input: InferenceExecutionRequest = {
      version: 1, ...scope, actor: { localUid: 1, processId: "proc_disposable" }, sessionAffinityKey: "proc_disposable", connection: {
        provider: "local-fixture", model: "no-provider", apiKey: "", reasoning: "off", maxTokens: 8,
        contextWindowTokens: 1024, baseUrl: undefined, providerStyle: undefined, openAiCodex: undefined,
      }, messages: [], timeoutMs: 60_000, deadlineAt: Date.now() + 60_000,
    };
    const executor = await this.env.RELAY.getExecutor(scope.installationId);
    this.executor = executor;
    this.scope = scope;
    const body = await executor.generateStream(input);
    const reader = body.getReader();
    this.reader = reader;
    this.ctx.waitUntil((async () => {
      let text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          this.receivedBytes += part.value.byteLength;
          text += decoder.decode(part.value, { stream: true });
        }
        this.result = text + decoder.decode();
      } catch {
        this.streamFailed = true;
      } finally {
        reader.releaseLock();
        // SAFETY: RPC-returned objects can carry a disposer independently of their stream lock.
        (body as ReadableStream<Uint8Array> & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        // SAFETY: The real Worker RPC result owns a platform-provided disposer.
        (executor as InferenceExecutor & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        try { await executor.generate(input); }
        catch (error) { this.disposedHandleRejected = error instanceof Error && error.message.includes("RPC stub used after being disposed"); }
      }
    })());
  }
  async cancel(): Promise<void> {
    this.cancelledAt = Date.now();
    const abort = this.executor?.abort(this.scope!.logicalRequestId, "cancelled");
    await this.reader?.cancel("Original caller cancelled");
    await abort;
  }
  async completed() { return { text: this.result ?? null, receivedBytes: this.receivedBytes,
    cancelledAt: this.cancelledAt ?? null, streamFailed: this.streamFailed, disposedHandleRejected: this.disposedHandleRejected }; }
}

/** A separate event owner keeps the control RPC stream alive independently. */
export class Controller extends DurableObject<Environment> {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  async open(scope: DelayScope): Promise<string> {
    this.reader = (await this.env.CONTROL.arm(scope)).getReader();
    return new TextDecoder().decode((await this.reader.read()).value);
  }
  async disconnect(): Promise<void> { await this.reader?.cancel("Controller disconnected"); this.reader = undefined; }
}

/** Local-only HTTP probe. A deployed controller would require operator authentication. */
export default class Probe extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const scope: DelayScope = { installationId: "inst_disposable", logicalRequestId: url.searchParams.get("id") ?? "" };
    const controller = this.env.CONTROLLERS.getByName(scope.logicalRequestId);
    const caller = this.env.CALLERS.getByName(scope.logicalRequestId);
    if (url.pathname === "/lease") return new Response(await controller.open(scope));
    if (url.pathname === "/disconnect") { await controller.disconnect(); return new Response("disconnected"); }
    if (url.pathname === "/inspect") return Response.json(await this.env.CONTROL.inspect({ installationId: scope.installationId, processId: "proc_disposable" }));
    if (url.pathname === "/status") return Response.json(await this.env.CONTROL.status(scope));
    if (url.pathname === "/upstream") return Response.json(await this.env.UPSTREAM.calls(scope.logicalRequestId));
    if (url.pathname === "/release") return Response.json(await this.env.CONTROL.release(scope));
    if (url.pathname === "/cancel") { await caller.cancel(); return new Response("cancelled"); }
    if (url.pathname === "/result") return Response.json(await caller.completed());
    if (url.pathname !== "/generation") return new Response("Not Found", { status: 404 });
    await caller.start(scope);
    return new Response("started");
  }
}
