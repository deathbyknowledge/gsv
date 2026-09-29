import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { decodeInferenceExecutionStream } from "@humansandmachines/gsv/protocol/managed-inference-stream";
import type { InferenceExecutionRequest, InferenceExecutionService, InferenceExecutor, InferenceTransport } from "@humansandmachines/gsv/services/inference-execution";

export type DelayProcess = { installationId: string; processId: string };
export type DelayScope = { installationId: string; logicalRequestId: string };
export type DelayReceipt = DelayScope & {
  version: 1;
  processId: string;
  runId?: string;
  writerId: string;
  phase: "awaiting-arm" | "capturing" | "held" | "releasing" | "delivered" | "rejected" | "inconclusive";
  receivedAt: number;
  deadlineAt: number;
  timeoutMs: number;
  armedAt?: number;
  byteLength?: number;
  sha256?: string;
  bufferedBytes: number;
  terminal?: { provider: string; model: string; stopReason: string; inputTokens: number; outputTokens: number; totalTokens: number; completedAt: number };
  abort?: { reason: "cancelled" | "timeout"; observedAt: number; forwardedAt?: number };
  cancellationObservedAt?: number;
  releaseAttemptedAt?: number;
  reason?: "lease-lost" | "lease-expired" | "arm-expired" | "caller-cancelled" | "owner-restarted" | "capture-failed";
};
type Environment = {
  INFERENCE_REAL: InferenceExecutionService;
  DELAY_RELAYS: DurableObjectNamespace<DelayedStream>;
  DELAY_INSTALLATION_ID: string;
  DELAY_PROCESS_ID: string;
  DELAY_PROVIDER: string;
  DELAY_MODEL: string;
  DELAY_MAX_BYTES: number;
  DELAY_ARM_TIMEOUT_MS: number;
  DELAY_CAPTURE_TIMEOUT_MS: number;
  DELAY_LEASE_TIMEOUT_MS: number;
};

function dispose(target?: InferenceExecutor | ReadableStream<Uint8Array>): void {
  // SAFETY: Cloudflare adds disposal to returned executor RPC targets.
  (target as ({ [Symbol.dispose]?: () => void }) | undefined)?.[Symbol.dispose]?.();
}

/** Acceptance only. The writer, request context and bytes are never persisted or reconstructed. */
export class DelayedStream extends DurableObject<Environment> {
  private receipt?: DelayReceipt;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private bytes?: Uint8Array;
  private pending?: { input: InferenceExecutionRequest; upstream: InferenceExecutor };
  private captureReader?: ReadableStreamDefaultReader<Uint8Array>;
  private lease?: ReadableStreamDefaultController<Uint8Array>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.receipt = await ctx.storage.get<DelayReceipt>("receipt");
      if (this.receipt && !["delivered", "rejected", "inconclusive"].includes(this.receipt.phase)) {
        this.receipt = { ...this.receipt, phase: "inconclusive", reason: "owner-restarted", bufferedBytes: 0 };
        await ctx.storage.put("receipt", this.receipt);
      }
    });
  }

  async receive(input: InferenceExecutionRequest, upstream: InferenceExecutor): Promise<ReadableStream<Uint8Array>> {
    this.validateProcess({ installationId: input.installationId, processId: input.actor.processId ?? "" });
    if (input.sessionAffinityKey !== this.env.DELAY_PROCESS_ID || this.receipt || input.deadlineAt <= Date.now()) {
      throw new Error("Exact delayed Process request is unavailable");
    }
    this.validateRequestId(input.logicalRequestId);
    const stream = new IdentityTransformStream();
    this.writer = stream.writable.getWriter();
    this.receipt = { version: 1, installationId: input.installationId, processId: this.env.DELAY_PROCESS_ID,
      logicalRequestId: input.logicalRequestId, runId: input.actor.runId, writerId: crypto.randomUUID(), phase: "awaiting-arm",
      receivedAt: Date.now(), deadlineAt: input.deadlineAt, timeoutMs: input.timeoutMs, bufferedBytes: 0 };
    // SAFETY: RPC arguments are borrowed until this method returns; this owner retains a duplicate.
    this.pending = { input, upstream: (upstream as InferenceExecutor & { dup(): InferenceExecutor }).dup() };
    void this.writer.closed.catch(async () => {
      if (!this.receipt || this.receipt.phase === "inconclusive") return;
      this.receipt = { ...this.receipt, cancellationObservedAt: Date.now() };
      await this.save();
    });
    await this.save();
    this.deadline = setTimeout(() => { void this.fail("arm-expired"); }, Math.min(
      this.bound(this.env.DELAY_ARM_TIMEOUT_MS, 30000), input.deadlineAt - Date.now()));
    return stream.readable;
  }

  async arm(scope: DelayScope): Promise<ReadableStream<Uint8Array>> {
    this.validateScope(scope);
    if (this.receipt?.phase !== "awaiting-arm" || !this.pending || !this.writer || this.receipt.deadlineAt <= Date.now()) {
      throw new Error("Original pending request is unavailable");
    }
    clearTimeout(this.deadline);
    const pending = this.pending;
    this.pending = undefined;
    this.receipt = { ...this.receipt, phase: "capturing", armedAt: Date.now() };
    const lease = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.lease = controller;
        controller.enqueue(new TextEncoder().encode("lease-open\n"));
        // A quiet transferred stream notices a disconnected reader on its next write.
        this.heartbeat = setInterval(() => {
          try { controller.enqueue(new TextEncoder().encode(".\n")); }
          catch { void this.fail("lease-lost"); }
        }, 100);
      },
      cancel: () => this.fail("lease-lost"),
    });
    this.deadline = setTimeout(() => { void this.fail("lease-expired"); }, this.bound(this.env.DELAY_LEASE_TIMEOUT_MS, 660000));
    await this.save();
    this.ctx.waitUntil(this.capture(pending.input, pending.upstream));
    return lease;
  }

  async inspect(process: DelayProcess): Promise<DelayReceipt | null> { this.validateProcess(process); return this.receipt ?? null; }
  async status(scope: DelayScope): Promise<DelayReceipt | null> { this.validateScope(scope); return this.receipt ?? null; }

  async observeAbort(scope: DelayScope, reason: "cancelled" | "timeout", observedAt: number, forwardedAt?: number): Promise<void> {
    this.validateScope(scope);
    if (!this.receipt) throw new Error("Delayed request was not received");
    this.receipt = { ...this.receipt, abort: { reason, observedAt, forwardedAt } };
    if (this.receipt.phase === "awaiting-arm") await this.fail("caller-cancelled");
    else await this.save();
  }

  async release(scope: DelayScope): Promise<DelayReceipt> {
    this.validateScope(scope);
    if (this.receipt?.phase === "inconclusive") return this.receipt;
    if (this.receipt?.phase !== "held" || !this.writer || !this.bytes || !this.lease) throw new Error("Original writer is not available for release");
    const writer = this.writer;
    const bytes = this.bytes;
    this.receipt = { ...this.receipt, phase: "releasing", releaseAttemptedAt: Date.now() };
    await this.save();
    try {
      // Deliberately no cancellation/retirement branch: the ORIGINAL stream decides.
      await writer.write(bytes);
      await writer.close();
      this.recordRelease("delivered");
    } catch { this.recordRelease("rejected"); }
    this.bytes = undefined;
    this.writer = undefined;
    this.receipt = { ...this.receipt, bufferedBytes: 0 };
    writer.releaseLock();
    await this.save();
    return this.receipt;
  }

  private async capture(input: InferenceExecutionRequest, upstream: InferenceExecutor): Promise<void> {
    let body: ReadableStream<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timeout = setTimeout(() => { void this.fail("capture-failed"); void upstream.abort(input.logicalRequestId, "timeout").catch(() => {}); },
      Math.min(this.bound(this.env.DELAY_CAPTURE_TIMEOUT_MS, 90000), Math.max(1, input.deadlineAt - Date.now())));
    try {
      body = await upstream.generateStream(input);
      reader = body.getReader();
      this.captureReader = reader;
      if (this.receipt?.phase !== "capturing") { await reader.cancel(); return; }
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.env.DELAY_MAX_BYTES) throw new Error("Delayed capture exceeds its byte limit");
        parts.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let terminal: DelayReceipt["terminal"];
      for await (const event of decodeInferenceExecutionStream(new Response(bytes).body!)) {
        if (terminal || event.type === "error") throw new Error("Capture did not end with one successful result");
        if (event.type === "done") {
          const result = event.message;
          if (!["stop", "length", "toolUse"].includes(result.stopReason) || event.reason !== result.stopReason
            || result.provider !== this.env.DELAY_PROVIDER || result.model !== this.env.DELAY_MODEL
            || result.usage.output < 1 || result.usage.totalTokens < 1) throw new Error("Unexpected inference completion");
          terminal = { provider: result.provider, model: result.model, stopReason: result.stopReason,
            inputTokens: result.usage.input, outputTokens: result.usage.output, totalTokens: result.usage.totalTokens, completedAt: Date.now() };
        }
      }
      if (!terminal) throw new Error("Capture ended without a terminal result");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (this.receipt?.phase !== "capturing") return;
      this.bytes = bytes;
      this.receipt = { ...this.receipt, phase: "held", byteLength: size, bufferedBytes: size, terminal,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") };
      await this.save();
    } catch {
      await this.fail("capture-failed");
      await reader?.cancel().catch(() => {});
    } finally {
      clearTimeout(timeout);
      this.captureReader = undefined;
      reader?.releaseLock();
      dispose(body);
      dispose(upstream);
    }
  }

  private async fail(reason: NonNullable<DelayReceipt["reason"]>): Promise<void> {
    clearInterval(this.heartbeat);
    clearTimeout(this.deadline);
    this.heartbeat = undefined;
    this.deadline = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (reason !== "lease-lost") { try { lease?.error(new Error("Acceptance lease ended")); } catch {} }
    if (this.receipt && !["delivered", "rejected", "inconclusive"].includes(this.receipt.phase)) {
      this.receipt = { ...this.receipt, phase: "inconclusive", reason, bufferedBytes: 0 };
      await this.save();
    }
    dispose(this.pending?.upstream);
    this.pending = undefined;
    this.bytes = undefined;
    await this.captureReader?.cancel().catch(() => {});
    const writer = this.writer;
    this.writer = undefined;
    await writer?.abort("Acceptance lease ended").catch(() => {});
    // A pending release owns the lock until its original write settles.
    if (!this.receipt?.releaseAttemptedAt) writer?.releaseLock();
  }

  private validateProcess(process: DelayProcess): void {
    if (!this.env.DELAY_INSTALLATION_ID || process.installationId !== this.env.DELAY_INSTALLATION_ID
      || !this.env.DELAY_PROCESS_ID || process.processId !== this.env.DELAY_PROCESS_ID || this.ctx.id.name !== process.processId
      || !Number.isSafeInteger(this.env.DELAY_MAX_BYTES) || this.env.DELAY_MAX_BYTES < 1 || this.env.DELAY_MAX_BYTES > 65536) {
      throw new Error("Delayed acceptance Process scope is invalid");
    }
  }
  private validateRequestId(id: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) throw new Error("Invalid logical request"); }
  private validateScope(scope: DelayScope): void {
    this.validateProcess({ installationId: scope.installationId, processId: this.env.DELAY_PROCESS_ID });
    this.validateRequestId(scope.logicalRequestId);
    if (scope.logicalRequestId !== this.receipt?.logicalRequestId) throw new Error("Logical request was not observed for this Process");
  }
  private bound(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid acceptance deadline");
    return value;
  }
  private async save(): Promise<void> { await this.ctx.storage.put("receipt", this.receipt); }
  private recordRelease(phase: "delivered" | "rejected"): void {
    // Lease loss invalidates the experiment, even if it also rejects a pending write.
    if (this.receipt?.phase === "releasing") this.receipt = { ...this.receipt, phase };
  }
}

class DelayedExecutor extends RpcTarget implements InferenceExecutor {
  constructor(private readonly env: Environment, private readonly installationId: string, private readonly upstream: InferenceExecutor) { super(); }
  [Symbol.dispose](): void { dispose(this.upstream); }
  async generateStream(input: InferenceExecutionRequest, transport?: InferenceTransport) {
    if (input.installationId !== this.installationId) throw new Error("Executor installation scope mismatch");
    if (input.actor.processId !== this.env.DELAY_PROCESS_ID || input.sessionAffinityKey !== this.env.DELAY_PROCESS_ID) {
      return this.upstream.generateStream(input, transport);
    }
    if (transport) throw new Error("Delayed acceptance requires native inference without a routed transport");
    // SAFETY: Sending an RPC stub transfers that handle; keep our original for abort/disposal.
    const transferred = (this.upstream as InferenceExecutor & { dup(): InferenceExecutor }).dup();
    return this.env.DELAY_RELAYS.getByName(this.env.DELAY_PROCESS_ID).receive(input, transferred);
  }
  generate(...args: Parameters<InferenceExecutor["generate"]>) { return this.upstream.generate(...args); }
  media(...args: Parameters<InferenceExecutor["media"]>) { return this.upstream.media(...args); }
  async abort(requestId: string, reason: "cancelled" | "timeout" = "cancelled") {
    const observedAt = Date.now();
    const scope = { installationId: this.installationId, logicalRequestId: requestId };
    const owner = this.env.DELAY_RELAYS.getByName(this.env.DELAY_PROCESS_ID);
    const pending = await owner.inspect({ installationId: this.installationId, processId: this.env.DELAY_PROCESS_ID });
    if (pending?.logicalRequestId === requestId) await owner.observeAbort(scope, reason, observedAt);
    await this.upstream.abort(requestId, reason);
    if (pending?.logicalRequestId === requestId) await owner.observeAbort(scope, reason, observedAt, Date.now());
  }
}

export class DelayedControl extends WorkerEntrypoint<Environment, { authority?: string }> {
  inspect(process: DelayProcess) { return this.owner(process.installationId).inspect(process); }
  arm(scope: DelayScope) { return this.owner(scope.installationId).arm(scope); }
  status(scope: DelayScope) { return this.owner(scope.installationId).status(scope); }
  release(scope: DelayScope) { return this.owner(scope.installationId).release(scope); }
  private owner(installationId: string) {
    if (this.ctx.props.authority !== "delayed-inference-acceptance" || installationId !== this.env.DELAY_INSTALLATION_ID) {
      throw new Error("Delayed acceptance control authority is required");
    }
    return this.env.DELAY_RELAYS.getByName(this.env.DELAY_PROCESS_ID);
  }
}

export default class DelayedInference extends WorkerEntrypoint<Environment> implements InferenceExecutionService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }
  async getExecutor(installationId: string): Promise<InferenceExecutor> {
    const upstream = await this.env.INFERENCE_REAL.getExecutor(installationId);
    return installationId === this.env.DELAY_INSTALLATION_ID ? new DelayedExecutor(this.env, installationId, upstream) : upstream;
  }
  resolveModel(provider: string, model: string) { return this.env.INFERENCE_REAL.resolveModel(provider, model); }
}
