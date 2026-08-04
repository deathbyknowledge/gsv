import { DurableObject } from "cloudflare:workers";
import {
  MANAGED_INFERENCE_PROVIDER,
  MANAGED_INFERENCE_PRODUCT_MODEL,
  type AiAssistantMessage,
  type ManagedEntitlementProjection,
  type ManagedInferencePartialMessage,
  type ManagedInferenceStreamEvent,
} from "@humansandmachines/gsv/protocol";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import {
  InferenceBoundaryError,
  parseCurrentEntitlement,
  parseInferenceRequest,
  requestFingerprint,
} from "./domain";
import {
  BudgetAdmissionError,
  BudgetLedger,
  type BudgetSnapshot,
} from "./ledger";
import { maximumRequestCostMicrounits, type TokenUsage } from "./price-book";
import { mapDeepSeekReasoning } from "./providers/deepseek";
import {
  resolveManagedProvider,
  type ProviderEnvironment,
} from "./providers/router";
import { runInferenceMigrations } from "./schema/migrations";

export type InferenceCoordinatorEnvironment = ProviderEnvironment & {
  MANAGED_MAX_CONCURRENT?: string;
  MANAGED_DAILY_BUDGET_MICROUNITS?: string;
  MANAGED_MAX_ATTEMPTS?: string;
};

type ActiveAttempt = {
  attemptId: string;
  deadlineAt: number;
  controller: AbortController;
};

const encoder = new TextEncoder();
const AMBIGUITY_GRACE_MS = 15_000;

export class BudgetCoordinator extends DurableObject<InferenceCoordinatorEnvironment> {
  private readonly ledger: BudgetLedger;
  private readonly active = new Map<string, ActiveAttempt>();

  constructor(
    ctx: DurableObjectState,
    env: InferenceCoordinatorEnvironment,
  ) {
    super(ctx, env);
    runInferenceMigrations(ctx.storage);
    this.ledger = new BudgetLedger(ctx.storage);
  }

  async run(
    rawRequest: unknown,
    rawEntitlement: ManagedEntitlementProjection | null,
  ): Promise<Response> {
    try {
      const now = Date.now();
      const request = parseInferenceRequest(rawRequest);
      const entitlement = parseCurrentEntitlement(
        rawEntitlement,
        request.installationId,
        now,
      );
      const provider = resolveManagedProvider(this.env);
      const reservationMicrounits = maximumRequestCostMicrounits(
        provider.price,
        request.inputTokenCeiling,
        request.maxOutputTokens,
      );
      const admission = this.ledger.beginAttempt({
        entitlement,
        logicalRequestId: request.logicalRequestId,
        requestFingerprint: await requestFingerprint(request.serialized),
        actorUid: request.actor.localUid,
        processId: request.actor.processId,
        runId: request.actor.runId,
        price: provider.price,
        reservationMicrounits,
        dailyBudgetMicrounits: positiveInteger(
          this.env.MANAGED_DAILY_BUDGET_MICROUNITS,
          500_000,
        ),
        maxConcurrent: positiveInteger(this.env.MANAGED_MAX_CONCURRENT, 2),
        maxAttempts: positiveInteger(this.env.MANAGED_MAX_ATTEMPTS, 3),
        deadlineAt: now + request.timeoutMs + AMBIGUITY_GRACE_MS,
        now,
      });
      this.ledger.markRunning(admission.attemptId, now);

      const controller = new AbortController();
      this.active.set(request.logicalRequestId, {
        attemptId: admission.attemptId,
        deadlineAt: admission.deadlineAt,
        controller,
      });
      await this.scheduleNextAlarm();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      this.ctx.waitUntil(this.execute({
        request,
        provider,
        attemptId: admission.attemptId,
        attemptOrdinal: admission.ordinal,
        controller,
        writer: writable.getWriter(),
      }));
      return new Response(readable, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-gsv-inference-request": request.logicalRequestId,
        },
      });
    } catch (error) {
      return inferenceErrorResponse(error);
    }
  }

  async abort(logicalRequestId: string): Promise<{ aborted: boolean }> {
    const active = this.active.get(logicalRequestId);
    if (active) {
      active.controller.abort(new DOMException("Managed inference cancelled", "AbortError"));
      return { aborted: true };
    }
    const attemptId = this.ledger.activeAttempt(logicalRequestId);
    if (!attemptId) return { aborted: false };
    // After an object restart the upstream outcome cannot be known. Conservatively
    // settle the reservation instead of claiming an unverified zero-cost abort.
    this.ledger.settleAmbiguous(attemptId, Date.now());
    await this.scheduleNextAlarm();
    return { aborted: true };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const active of this.active.values()) {
      if (active.deadlineAt <= now) {
        active.controller.abort(new DOMException("Managed inference deadline exceeded", "TimeoutError"));
      }
    }
    this.ledger.settleExpired(now);
    await this.scheduleNextAlarm();
  }

  inspect(): BudgetSnapshot {
    if (this.env.ENVIRONMENT !== "test") {
      throw new Error("Inference inspection is test-only");
    }
    return this.ledger.snapshot();
  }

  private async execute(input: {
    request: ReturnType<typeof parseInferenceRequest>;
    provider: ReturnType<typeof resolveManagedProvider>;
    attemptId: string;
    attemptOrdinal: number;
    controller: AbortController;
    writer: WritableStreamDefaultWriter<Uint8Array>;
  }): Promise<void> {
    let terminal = false;
    const timeout = setTimeout(() => {
      input.controller.abort(new DOMException("Managed inference timed out", "TimeoutError"));
    }, input.request.timeoutMs);
    try {
      const context = contextFromRequest(input.request);
      const stream = await input.provider.stream({
        request: input.request,
        context,
        reasoning: mapDeepSeekReasoning(input.request.reasoning),
        attemptId: input.attemptId,
        attemptOrdinal: input.attemptOrdinal,
        signal: input.controller.signal,
      });
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          this.ledger.settleAttempt({
            attemptId: input.attemptId,
            state: event.type === "done"
              ? "succeeded"
              : event.reason === "aborted"
                ? "aborted"
                : "failed",
            usage: tokenUsage(message),
            price: input.provider.price,
            now: Date.now(),
          });
          terminal = true;
        }
        await writeEvent(input.writer, sanitizeEvent(event));
        if (terminal) return;
      }
      throw new Error("Managed inference provider ended without a terminal event");
    } catch {
      const aborted = input.controller.signal.aborted;
      if (!aborted) {
        input.controller.abort(new DOMException("Managed inference stopped", "AbortError"));
      }
      if (aborted) {
        this.ledger.settleAttempt({
          attemptId: input.attemptId,
          state: "aborted",
          usage: { cacheHitInputTokens: 0, cacheMissInputTokens: 0, outputTokens: 0 },
          price: input.provider.price,
          now: Date.now(),
        });
      } else {
        // Once an upstream stream throws without a terminal usage event, the
        // provider-side outcome is unknowable. Charge the reservation instead
        // of making retries able to exceed the installation's funded budget.
        this.ledger.settleAmbiguous(input.attemptId, Date.now());
      }
      if (!terminal) {
        await writeEvent(input.writer, managedErrorEvent(aborted)).catch(() => {});
      }
    } finally {
      clearTimeout(timeout);
      this.active.delete(input.request.logicalRequestId);
      await input.writer.close().catch(() => {});
      await this.scheduleNextAlarm();
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const deadline = this.ledger.nextActiveDeadline();
    if (deadline === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(deadline);
  }
}

function contextFromRequest(
  request: ReturnType<typeof parseInferenceRequest>,
): Context {
  return {
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    messages: request.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    })) as Context["messages"],
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools as Context["tools"] }
      : {}),
  };
}

function tokenUsage(message: AssistantMessage): TokenUsage {
  return {
    cacheHitInputTokens: message.usage.cacheRead,
    cacheMissInputTokens: message.usage.input + message.usage.cacheWrite,
    outputTokens: message.usage.output,
  };
}

function sanitizeEvent(event: AssistantMessageEvent): ManagedInferenceStreamEvent {
  if (event.type === "done") {
    return { ...event, message: sanitizeFinalMessage(event.message) };
  }
  if (event.type === "error") {
    return { ...event, error: sanitizeFinalMessage(event.error, true) };
  }
  return { ...event, partial: sanitizePartialMessage(event.partial) } as ManagedInferenceStreamEvent;
}

function sanitizeFinalMessage(
  message: AssistantMessage,
  error = false,
): AiAssistantMessage {
  return {
    role: "assistant",
    content: message.content,
    api: "gsv-managed",
    provider: MANAGED_INFERENCE_PROVIDER,
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    usage: sanitizeUsage(message.usage),
    stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
    ...(error
      ? { errorMessage: message.stopReason === "aborted"
          ? "Managed inference cancelled"
          : "Managed inference temporarily unavailable" }
      : {}),
    timestamp: message.timestamp,
  };
}

function sanitizePartialMessage(
  message: AssistantMessage,
): ManagedInferencePartialMessage {
  return {
    role: "assistant",
    content: message.content,
    api: "gsv-managed",
    provider: MANAGED_INFERENCE_PROVIDER,
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    usage: sanitizeUsage(message.usage),
    stopReason: message.stopReason,
    timestamp: message.timestamp,
  };
}

function sanitizeUsage(
  usage: AssistantMessage["usage"],
): AiAssistantMessage["usage"] {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    totalTokens: usage.totalTokens,
    // gsv/default is bundled product capacity, not a metered charge to the
    // installation. Provider cost remains private in the settlement ledger.
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function managedErrorEvent(aborted: boolean): ManagedInferenceStreamEvent {
  const message: AiAssistantMessage = {
    role: "assistant",
    content: [],
    api: "gsv-managed",
    provider: MANAGED_INFERENCE_PROVIDER,
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted
      ? "Managed inference cancelled"
      : "Managed inference temporarily unavailable",
    timestamp: Date.now(),
  };
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: message,
  };
}

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: ManagedInferenceStreamEvent,
): Promise<void> {
  await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
}

export function inferenceErrorResponse(error: unknown): Response {
  const recognized = error instanceof InferenceBoundaryError || error instanceof BudgetAdmissionError;
  const status = recognized ? error.status : 503;
  const code = recognized ? error.code : "inference_unavailable";
  const message = recognized ? error.message : "Managed inference temporarily unavailable";
  return Response.json({ error: message, code }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
