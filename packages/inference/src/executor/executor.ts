import { DurableObject } from "cloudflare:workers";
import type { Context } from "@earendil-works/pi-ai";
import { encodeInferenceExecutionStreamEvent as encodeManagedInferenceStreamEvent } from "@humansandmachines/gsv/protocol";
import type { InferenceExecutionRequest, InferenceExecutor as ExecutorContract, InferenceTransport, InferenceMediaRequest, InferenceMediaResult } from "@humansandmachines/gsv/services/inference-execution";
import type { ManagedInferenceAbortReason, ManagedInferenceResult, ManagedInferenceStreamEvent } from "@humansandmachines/gsv/services/inference";
import { createGenerationService } from "../text/service";
import type { InferenceProviderFactory } from "../text/provider";
import { createInferenceTransportFetch } from "../transport";
import { raceWithAbort } from "../shared/abort";
import { TimeoutError } from "../shared/timeout";
import { executorConnection, executorLimits, opaqueId, requireActiveInstallation, type ExecutorEnvironment } from "./config";
import { ExecutorStore, type TerminalState } from "./store";
import { executionEvent, executionResult } from "./projection";
import { executeMedia } from "./media";
import { requestBinding } from "./bodies";
import * as z from "zod/mini";
import { errorMessageFromUnknown, formatProviderErrorMessage } from "../text/errors";

type RequestIdentity = Pick<InferenceExecutionRequest, "version" | "installationId" | "logicalRequestId" | "actor" | "timeoutMs" | "deadlineAt">;

type ActiveRequest = {
  id: string;
  deadline: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  state?: TerminalState;
  transport?: InferenceTransport;
  errorMessage?: string;
};

/** Shared request ownership for reference hosting and commercial composition. */
export class InferenceExecutor<Environment extends ExecutorEnvironment = ExecutorEnvironment>
  extends DurableObject<Environment> implements ExecutorContract {
  private readonly store: ExecutorStore;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly installationId: string;

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.store = new ExecutorStore(ctx.storage);
    this.installationId = this.store.installationId(ctx.id.name ? opaqueId(ctx.id.name) : undefined);
    // Provider operations do not survive an isolate restart. Never replay them.
    this.store.recover();
    this.scheduleExpiry();
  }

  protected providerFactories(): readonly InferenceProviderFactory[] { return []; }

  async generate(input: InferenceExecutionRequest, transport?: InferenceTransport): Promise<ManagedInferenceResult> {
    const request = this.open(input, transport);
    try {
      await this.admit(input, request, this.outputTokens(input));
      if (request.state) return terminalResult(input, request.state);
      const response = await raceWithAbort(
        this.service(request).generate(this.generationInput(input, request)), request.controller.signal,
      );
      this.checkDeadline(request);
      if (request.state) return terminalResult(input, request.state);
      const result = executionResult(response);
      this.finish(request, result.stopReason === "aborted" ? "cancelled" : result.stopReason === "error" ? "error" : "completed", result.usage.output);
      return result;
    } catch (error) {
      if (request.state) return terminalResult(input, request.state);
      this.finish(request, "error");
      throw error;
    }
  }

  async generateStream(input: InferenceExecutionRequest, transport?: InferenceTransport): Promise<ReadableStream<Uint8Array>> {
    const request = this.open(input, transport);
    try {
      await this.admit(input, request, this.outputTokens(input));
      if (request.state) return terminalStream(input, request.state);
      const iterator = this.service(request).stream(this.generationInput(input, request))[Symbol.asyncIterator]();
      let closed = false;
      const cleanup = () => {
        request.controller.signal.removeEventListener("abort", interrupted);
        void iterator.return?.().catch(() => {});
      };
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const interrupted = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.enqueue(encodeManagedInferenceStreamEvent(terminalEvent(input, request.state ?? "cancelled", request.errorMessage)));
        controller.close();
      };
      return new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          request.controller.signal.addEventListener("abort", interrupted, { once: true });
          if (request.controller.signal.aborted) interrupted();
        },
        pull: async () => {
          try {
            const event = await raceWithAbort(iterator.next(), request.controller.signal);
            this.checkDeadline(request);
            if (closed) return;
            if (event.done) throw new Error("Inference stream ended without a terminal event");
            const projected = executionEvent(event.value);
            if (projected.type === "done" || projected.type === "error") {
              const encoded = encodeManagedInferenceStreamEvent(projected);
              closed = true;
              cleanup();
              const result = projected.type === "done" ? projected.message : projected.error;
              this.finish(request, result.stopReason === "aborted" ? "cancelled" : result.stopReason === "error" ? "error" : "completed", result.usage.output);
              controller.enqueue(encoded);
              controller.close();
            } else {
              controller.enqueue(encodeManagedInferenceStreamEvent(projected));
            }
          } catch (error) {
            if (closed) return;
            request.errorMessage = formatProviderErrorMessage(errorMessageFromUnknown(error), input.connection);
            this.finish(request, "error");
          }
        },
        cancel: () => {
          if (closed) return;
          closed = true;
          cleanup();
          this.checkDeadline(request);
          this.finish(request, "cancelled");
        },
      });
    } catch (error) {
      if (request.state) return terminalStream(input, request.state);
      this.finish(request, "error");
      throw error;
    }
  }

  async abort(id: string, reason: ManagedInferenceAbortReason = "cancelled"): Promise<void> {
    opaqueId(id);
    if (reason !== "cancelled" && reason !== "timeout") throw new Error("Invalid inference abort reason");
    const active = this.active.get(id);
    if (active) {
      this.checkDeadline(active);
      this.finish(active, reason);
    } else {
      this.store.finish(id, reason);
      this.scheduleExpiry();
    }
  }

  async media(input: InferenceMediaRequest, body?: ReadableStream<Uint8Array>, transport?: InferenceTransport): Promise<InferenceMediaResult> {
    let request: ActiveRequest | undefined;
    try {
      request = this.open(input, transport);
      const tokens = input.kind === "image-read" ? Math.min(input.input.maxTokens ?? 28_672, executorLimits(this.env).maxOutputTokens) : 0;
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid media output token limit");
      await this.admit(input, request, tokens);
      request.controller.signal.throwIfAborted();
      if (input.kind !== "transcription" && input.kind !== "image-read" && body) throw new Error("Unexpected inference media body");
      const signal = request.controller.signal;
      const rawFetch = request.transport ? createInferenceTransportFetch(request.transport, signal) : fetch;
      const providerFetch: typeof fetch = (url, init) => rawFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
      const operation = executeMedia(this.env, input.kind === "image-read" ? { ...input, input: { ...input.input, maxTokens: tokens } } : input, body, signal, providerFetch);
      const result = await raceWithAbort(operation, signal, { onLateResolve: (late) => { if ("body" in late) void late.body?.cancel(signal.reason).catch(() => {}); } });
      this.checkDeadline(request);
      signal.throwIfAborted();
      if ("body" in result && result.body) {
        return { ...result, body: this.ownMediaBody(result.body, request, tokens) };
      }
      this.finish(request, "completed", result.kind === "image-read" ? result.result.metrics?.outputTokens ?? tokens : 0);
      return result;
    } catch (error) {
      if (body && !body.locked) void body.cancel(error).catch(() => {});
      if (request) this.finish(request, "error");
      else dispose(transport);
      throw error;
    }
  }

  private ownMediaBody(body: ReadableStream<Uint8Array>, request: ActiveRequest, tokens: number): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = (cancel = false) => {
      request.controller.signal.removeEventListener("abort", abort);
      if (cancel) void reader.cancel(request.controller.signal.reason).catch(() => {});
      reader.releaseLock();
    };
    const abort = () => {
      if (closed) return;
      closed = true;
      cleanup(true);
      controller.error(request.controller.signal.reason);
    };
    return new ReadableStream({
      start(value) {
        controller = value;
        request.controller.signal.addEventListener("abort", abort, { once: true });
        if (request.controller.signal.aborted) abort();
      },
      pull: async () => {
        try {
          const next = await raceWithAbort(reader.read(), request.controller.signal);
          this.checkDeadline(request);
          if (closed) return;
          if (next.done) {
            closed = true;
            cleanup();
            this.finish(request, "completed", tokens);
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (closed) return;
          closed = true;
          cleanup(true);
          this.finish(request, "error");
          controller.error(error);
        }
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        cleanup(true);
        this.checkDeadline(request);
        this.finish(request, "cancelled");
      },
    });
  }

  async alarm(): Promise<void> {
    for (const id of this.store.expire(Date.now())) {
      const request = this.active.get(id);
      if (request) this.finish(request, "timeout");
    }
    this.scheduleExpiry();
  }

  private service(request: ActiveRequest) {
    return createGenerationService({ workersAi: requestBinding(this.env.AI, request.controller.signal), providers: this.providerFactories() });
  }

  private open(input: RequestIdentity, transport?: InferenceTransport): ActiveRequest {
    if (input.version !== 1 || input.installationId !== this.installationId) throw new Error("Inference installation scope mismatch");
    opaqueId(input.logicalRequestId);
    if (!Number.isSafeInteger(input.actor?.localUid) || input.actor.localUid < 0) throw new Error("Invalid inference actor");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) throw new Error("Invalid inference deadline");
    const existing = this.store.get(input.logicalRequestId);
    if (this.active.has(input.logicalRequestId) || (existing && existing.state !== "cancelled" && existing.state !== "timeout")) {
      throw new Error("Inference request identity has already been used");
    }
    const request: ActiveRequest = {
      id: input.logicalRequestId,
      deadline: Math.min(Date.now() + Math.min(input.timeoutMs, executorLimits(this.env).maxDurationMs), input.deadlineAt),
      controller: new AbortController(),
      transport: retainTransport(transport),
    };
    this.active.set(request.id, request);
    if (existing) this.finish(request, existing.state === "timeout" ? "timeout" : "cancelled");
    else if (!this.checkDeadline(request)) request.timer = setTimeout(() => this.finish(request, "timeout"), Math.max(0, request.deadline - Date.now()));
    return request;
  }

  private async admit(input: RequestIdentity, request: ActiveRequest, maxTokens: number): Promise<void> {
    if (request.state) return;
    const admission = requireActiveInstallation(this.env, this.installationId, request.controller.signal);
    await raceWithAbort(admission, request.controller.signal);
    this.checkDeadline(request);
    if (request.state) return;
    const limits = executorLimits(this.env);
    this.store.admit(request.id, input.actor.localUid, request.deadline, maxTokens, limits);
    this.scheduleExpiry();
  }

  private outputTokens(input: InferenceExecutionRequest): number {
    if (!input.connection || !z.string().safeParse(input.connection.provider).success || !z.string().safeParse(input.connection.model).success || !Array.isArray(input.messages)) throw new Error("Invalid inference request");
    const limits = executorLimits(this.env);
    const maxTokens = Math.min(input.options?.maxTokens ?? input.connection.maxTokens, input.connection.maxTokens, limits.maxOutputTokens);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("Invalid inference output token limit");
    return maxTokens;
  }

  private generationInput(input: InferenceExecutionRequest, request: ActiveRequest) {
    const connection = executorConnection(this.env, input.connection);
    // SAFETY: The SDK message union matches pi-ai JSON context; timestamps are optional at ingress.
    const context = { systemPrompt: input.systemPrompt, messages: input.messages.map((message) => ({ ...message, timestamp: message.timestamp ?? Date.now() })), tools: input.tools } as Context;
    return {
      config: { ...connection, executor: { kind: "kernel" as const }, capabilities: [], maxContextBytes: 0, contextWindowSource: "config" as const, generationTimeoutMs: input.timeoutMs, maxTokens: Math.min(connection.maxTokens, executorLimits(this.env).maxOutputTokens) },
      context,
      options: { ...input.options, timeoutMs: input.timeoutMs },
      fetch: request.transport ? createInferenceTransportFetch(request.transport, request.controller.signal) : undefined,
      signal: request.controller.signal,
      deadlineAt: request.deadline,
      sessionAffinityKey: input.sessionAffinityKey,
      attribution: { installationId: this.installationId, logicalRequestId: request.id, actor: input.actor, workload: input.workload },
    };
  }

  private checkDeadline(request: ActiveRequest): boolean {
    if (!request.state && Date.now() >= request.deadline) this.finish(request, "timeout");
    return request.state !== undefined;
  }

  private finish(request: ActiveRequest, state: TerminalState, outputTokens?: number): void {
    if (request.state) return;
    request.state = this.store.finish(request.id, state, outputTokens);
    clearTimeout(request.timer);
    this.active.delete(request.id);
    if (request.state !== "completed") {
      request.controller.abort(request.state === "timeout" ? new TimeoutError("Inference deadline exceeded") : new DOMException("Inference cancelled", "AbortError"));
    }
    dispose(request.transport);
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    const deadline = this.store.nextAlarm();
    const scheduled = deadline === undefined ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(deadline);
    this.ctx.waitUntil(scheduled);
  }
}

function dispose(value: InferenceTransport | undefined): void {
  // SAFETY: Cloudflare RPC arguments may expose optional disposal; this executor owns the argument.
  const disposable = value as (InferenceTransport & { [Symbol.dispose]?: () => void }) | undefined;
  disposable?.[Symbol.dispose]?.();
}

function retainTransport(value: InferenceTransport | undefined): InferenceTransport | undefined {
  // SAFETY: RPC argument stubs expose dup(); retain a stream's capability beyond the opening RPC.
  const resource = value as (InferenceTransport & { dup?: () => InferenceTransport }) | undefined;
  return resource?.dup?.() ?? value;
}

function terminalResult(input: InferenceExecutionRequest, state: TerminalState, errorMessage?: string): ManagedInferenceResult {
  return {
    role: "assistant", content: [], api: "inference-execution", provider: input.connection.provider, model: input.connection.model,
    stopReason: state === "cancelled" ? "aborted" : "error",
    errorMessage: state === "timeout" ? "Inference deadline exceeded" : state === "cancelled" ? "Inference cancelled" : errorMessage || "Inference execution failed",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function terminalEvent(input: InferenceExecutionRequest, state: TerminalState, errorMessage?: string): ManagedInferenceStreamEvent {
  const error = terminalResult(input, state, errorMessage);
  return { type: "error", reason: state === "cancelled" ? "aborted" : "error", error };
}

function terminalStream(input: InferenceExecutionRequest, state: TerminalState): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(encodeManagedInferenceStreamEvent(terminalEvent(input, state))); controller.close(); } });
}
