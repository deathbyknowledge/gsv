import { DurableObject } from "cloudflare:workers";
import {
  encodeManagedInferenceStreamEvent,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  MANAGED_INFERENCE_QUANTIZATIONS,
  type ManagedInferencePolicy,
  type ManagedInferencePurpose,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceRouting,
  type ManagedInferenceStreamEvent,
  type ManagedInferenceUsageEvent,
  type ManagedInferenceUsageOutcome,
  type ManagedMailSummary,
  type ManagedMailSummaryRequest,
  type ManagedMailSummaryRequestStatus,
} from "@humansandmachines/gsv/protocol";
import type { InferenceEnv } from "./env";
import {
  buildMailSummaryInferenceRequest,
  managedMailSummaryFingerprint,
  parseManagedMailSummaryResult,
  validateManagedMailSummary,
  validateManagedMailSummaryRequest,
} from "./mail-summary";
import {
  createOpenRouterGeneration,
  toManagedInferenceStreamEvent,
} from "./openrouter";
import { reservationNanoUsd, usageNanoUsd } from "./pricing";
import { runInferenceSqlMigrations } from "./schema/migrations";
import {
  MAX_MANAGED_INFERENCE_TIMEOUT_MS,
  validateManagedInferenceRequest,
  validateOpaqueId,
} from "./validation";

const EXPORT_DELAY_MS = 5_000;
const EXPORT_BATCH_SIZE = 100;
const RESERVATION_GRACE_MS = 5 * 60 * 1000;
const MAX_EXPORT_BACKOFF_MS = 5 * 60 * 1000;
const CANCELLATION_TOMBSTONE_TTL_MS = MAX_MANAGED_INFERENCE_TIMEOUT_MS
  + RESERVATION_GRACE_MS;

type ActiveGeneration = {
  promise: Promise<ManagedInferenceResult>;
  abort: () => Promise<void>;
};

type ActiveMailSummary = {
  fingerprint: string;
  promise: Promise<ManagedMailSummary>;
  abort: () => Promise<void>;
};

type StoredRequestState =
  | "reserved"
  | "completed"
  | "failed"
  | "aborted"
  | "abandoned";

type RequestStateRow = {
  logical_request_id: string;
  period: string;
  state: StoredRequestState;
  purpose: ManagedInferencePurpose;
  request_fingerprint: string | null;
  result_json: string | null;
  reserved_nano_usd: number;
};

type ReservationRow = Pick<
  RequestStateRow,
  "logical_request_id" | "period" | "state" | "reserved_nano_usd"
>;

type ExportRow = {
  logical_request_id: string;
  local_uid: number;
  process_id: string | null;
  run_id: string | null;
  purpose: ManagedInferencePurpose;
  period: string;
  model: string;
  state: Exclude<StoredRequestState, "reserved">;
  reserved_nano_usd: number;
  cost_nano_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  response_model: string | null;
  provider_response_id: string | null;
  stop_reason: NonNullable<ManagedInferenceUsageEvent["stopReason"]> | null;
  started_at: number;
  completed_at: number;
  export_attempts: number;
};

export type InferenceUsageSnapshot = {
  installationId: string;
  period: string;
  spentNanoUsd: number;
  reservedNanoUsd: number;
  startedRequests: number;
  completedRequests: number;
  failedRequests: number;
  abortedRequests: number;
  abandonedRequests: number;
};

type PeriodRow = {
  period: string;
  spent_nano_usd: number;
  reserved_nano_usd: number;
  started_requests: number;
  completed_requests: number;
  failed_requests: number;
  aborted_requests: number;
  abandoned_requests: number;
};

export class InferenceInstallation extends DurableObject<InferenceEnv> {
  private readonly installationId: string;
  private readonly activeGenerations = new Map<string, ActiveGeneration>();
  private readonly activeMailSummaries = new Map<string, ActiveMailSummary>();
  private readonly deploymentMonthlyLimitNanoUsd: number;

  constructor(ctx: DurableObjectState, env: InferenceEnv) {
    super(ctx, env);
    this.installationId = validateOpaqueId(ctx.id.name ?? "", "installationId");
    this.deploymentMonthlyLimitNanoUsd = parseMonthlyLimit(
      env.MANAGED_INFERENCE_MONTHLY_LIMIT_NANO_USD,
    );
    runInferenceSqlMigrations(ctx.storage);
  }

  async generate(
    inputValue: ManagedInferenceRequest,
  ): Promise<ManagedInferenceResult> {
    const input = validateManagedInferenceRequest(inputValue);
    this.requireOwnedRequest(input);
    if (this.activeMailSummaries.has(input.logicalRequestId)) {
      throw new Error("Managed inference request conflicts with mail intake");
    }
    const existing = this.activeGenerations.get(input.logicalRequestId);
    if (existing) return await existing.promise;
    if (this.isCancelled(input.logicalRequestId, Date.now())) {
      return abortedResult();
    }

    const generation = createOpenRouterGeneration(
      input,
      this.env.OPENROUTER_API_KEY,
    );
    const active: ActiveGeneration = {
      promise: this.completeGeneration(input, generation),
      abort: generation.abort,
    };
    this.activeGenerations.set(input.logicalRequestId, active);
    try {
      return await active.promise;
    } finally {
      if (this.activeGenerations.get(input.logicalRequestId) === active) {
        this.activeGenerations.delete(input.logicalRequestId);
      }
    }
  }

  async generateStream(
    inputValue: ManagedInferenceRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    const input = validateManagedInferenceRequest(inputValue);
    this.requireOwnedRequest(input);
    if (this.activeMailSummaries.has(input.logicalRequestId)) {
      throw new Error("Managed inference request conflicts with mail intake");
    }
    if (this.activeGenerations.has(input.logicalRequestId)) {
      throw new Error("Managed inference request is already active");
    }
    if (this.isCancelled(input.logicalRequestId, Date.now())) {
      return streamFromEvent(resultEvent(abortedResult()));
    }

    const generation = createOpenRouterGeneration(
      input,
      this.env.OPENROUTER_API_KEY,
    );
    const channel = new TransformStream<Uint8Array, Uint8Array>();
    const writer = channel.writable.getWriter();
    const active: ActiveGeneration = {
      promise: this.completeGenerationStream(input, generation, writer),
      abort: generation.abort,
    };
    this.activeGenerations.set(input.logicalRequestId, active);
    void active.promise.finally(() => {
      if (this.activeGenerations.get(input.logicalRequestId) === active) {
        this.activeGenerations.delete(input.logicalRequestId);
      }
    }).catch(() => {});
    return channel.readable;
  }

  async summarizeMail(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummary> {
    const input = validateManagedMailSummaryRequest(inputValue);
    this.requireOwnedRequest(input);
    const fingerprint = await managedMailSummaryFingerprint(input);
    if (this.activeGenerations.has(input.logicalRequestId)) {
      throw new Error("Managed mail summary request conflicts with agent inference");
    }
    const existing = this.activeMailSummaries.get(input.logicalRequestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("Managed mail summary request conflicts with an existing request");
      }
      return await existing.promise;
    }
    const replay = this.mailSummaryReplay(input.logicalRequestId, fingerprint);
    if (replay) return replay;
    if (!this.env.MANAGED_INFERENCE_ENABLED) {
      throw new Error("Managed inference is disabled");
    }

    const inferenceInput = buildMailSummaryInferenceRequest(input);
    const generation = createOpenRouterGeneration(
      inferenceInput,
      this.env.OPENROUTER_API_KEY,
    );
    const active: ActiveMailSummary = {
      fingerprint,
      promise: this.completeMailSummary(
        inferenceInput,
        fingerprint,
        generation,
      ),
      abort: generation.abort,
    };
    this.activeMailSummaries.set(input.logicalRequestId, active);
    try {
      return await active.promise;
    } finally {
      if (this.activeMailSummaries.get(input.logicalRequestId) === active) {
        this.activeMailSummaries.delete(input.logicalRequestId);
      }
    }
  }

  async getMailSummaryStatus(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummaryRequestStatus> {
    const input = validateManagedMailSummaryRequest(inputValue);
    this.requireOwnedRequest(input);
    return this.mailSummaryStatus(
      input.logicalRequestId,
      await managedMailSummaryFingerprint(input),
    );
  }

  async abort(logicalRequestIdValue: string): Promise<void> {
    const logicalRequestId = validateOpaqueId(
      logicalRequestIdValue,
      "logicalRequestId",
    );
    const request = this.requestState(logicalRequestId);
    if (request && request.state !== "reserved") return;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO inference_cancellations (logical_request_id, expires_at)
       VALUES (?, ?)
       ON CONFLICT(logical_request_id) DO UPDATE SET
         expires_at = MAX(expires_at, excluded.expires_at)`,
      logicalRequestId,
      now + CANCELLATION_TOMBSTONE_TTL_MS,
    );
    const generationAbort = this.activeGenerations.get(logicalRequestId)?.abort();
    const mailSummaryAbort = this.activeMailSummaries.get(logicalRequestId)?.abort();
    await this.scheduleNextAlarm();
    await Promise.all([generationAbort, mailSummaryAbort]);
  }

  async usage(periodValue?: string): Promise<InferenceUsageSnapshot> {
    const period = periodValue ?? inferencePeriod(Date.now());
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new Error("Managed inference period is invalid");
    }
    const row = this.ctx.storage.sql.exec<PeriodRow>(
      `SELECT
         period, spent_nano_usd, reserved_nano_usd, started_requests,
         completed_requests, failed_requests, aborted_requests,
         abandoned_requests
       FROM inference_periods
       WHERE period = ?`,
      period,
    ).toArray()[0];
    return {
      installationId: this.installationId,
      period,
      spentNanoUsd: row?.spent_nano_usd ?? 0,
      reservedNanoUsd: row?.reserved_nano_usd ?? 0,
      startedRequests: row?.started_requests ?? 0,
      completedRequests: row?.completed_requests ?? 0,
      failedRequests: row?.failed_requests ?? 0,
      abortedRequests: row?.aborted_requests ?? 0,
      abandonedRequests: row?.abandoned_requests ?? 0,
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.deleteExpiredCancellations(now);
    await this.abandonExpiredReservations(now);
    await this.exportCompletedRequests(now);
    await this.scheduleNextAlarm();
  }

  private async completeGeneration(
    input: ManagedInferenceRequest,
    generation: ReturnType<typeof createOpenRouterGeneration>,
  ): Promise<ManagedInferenceResult> {
    const policy = await this.env.ACCOUNTS.getManagedInferencePolicy(
      this.installationId,
    );
    if (this.isCancelled(input.logicalRequestId, Date.now())) {
      return abortedResult();
    }
    const monthlyLimitNanoUsd = effectiveMonthlyLimit(
      policy,
      this.installationId,
      this.deploymentMonthlyLimitNanoUsd,
    );
    const routing = requireManagedInferenceRouting(policy.routing);
    const startedAt = Date.now();
    const reservedNanoUsd = reservationNanoUsd(input, routing);
    this.reserve(
      input,
      startedAt,
      reservedNanoUsd,
      monthlyLimitNanoUsd,
      "agent",
      null,
    );
    await this.scheduleNextAlarm();

    try {
      const result = await generation.result(routing);
      this.settleResult(input.logicalRequestId, result, routing, Date.now(), {
        minimumCostNanoUsd: acceptedFailureCost(
          generation,
          result,
          reservedNanoUsd,
        ),
      });
      await this.scheduleNextAlarm();
      return result;
    } catch (error) {
      this.settleFailure(
        input.logicalRequestId,
        Date.now(),
        generation.accepted() ? reservedNanoUsd : 0,
      );
      await this.scheduleNextAlarm();
      throw error;
    }
  }

  private async completeGenerationStream(
    input: ManagedInferenceRequest,
    generation: ReturnType<typeof createOpenRouterGeneration>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<ManagedInferenceResult> {
    let reserved = false;
    let reservedNanoUsd = 0;
    try {
      const policy = await this.env.ACCOUNTS.getManagedInferencePolicy(
        this.installationId,
      );
      if (this.isCancelled(input.logicalRequestId, Date.now())) {
        const result = abortedResult();
        await writeTerminalEvent(writer, resultEvent(result));
        return result;
      }
      const monthlyLimitNanoUsd = effectiveMonthlyLimit(
        policy,
        this.installationId,
        this.deploymentMonthlyLimitNanoUsd,
      );
      const routing = requireManagedInferenceRouting(policy.routing);
      const startedAt = Date.now();
      reservedNanoUsd = reservationNanoUsd(input, routing);
      this.reserve(
        input,
        startedAt,
        reservedNanoUsd,
        monthlyLimitNanoUsd,
        "agent",
        null,
      );
      reserved = true;
      await this.scheduleNextAlarm();

      const source = generation.stream(routing);
      let result: ManagedInferenceResult | undefined;
      let terminal: Extract<
        ManagedInferenceStreamEvent,
        { type: "done" | "error" }
      > | undefined;
      let consumerClosed = false;
      for await (const event of source) {
        const wireEvent = toManagedInferenceStreamEvent(event);
        if (wireEvent.type === "done") {
          result = wireEvent.message;
          terminal = wireEvent;
          break;
        }
        if (wireEvent.type === "error") {
          result = wireEvent.error;
          terminal = wireEvent;
          break;
        }
        try {
          await writer.write(encodeManagedInferenceStreamEvent(wireEvent));
        } catch {
          consumerClosed = true;
          await generation.abort();
          break;
        }
      }
      if (consumerClosed) {
        result = await generation.result(routing);
        terminal = resultEvent(result);
      }
      if (!result || !terminal) {
        throw new Error("Managed inference stream ended without a result");
      }

      this.settleResult(input.logicalRequestId, result, routing, Date.now(), {
        minimumCostNanoUsd: acceptedFailureCost(
          generation,
          result,
          reservedNanoUsd,
        ),
      });
      await this.scheduleNextAlarm();
      if (consumerClosed) {
        await writer.abort().catch(() => {});
      } else {
        await writeTerminalEvent(writer, terminal).catch(() => {});
      }
      return result;
    } catch (error) {
      await generation.abort();
      if (reserved) {
        this.settleFailure(
          input.logicalRequestId,
          Date.now(),
          generation.accepted() ? reservedNanoUsd : 0,
        );
        await this.scheduleNextAlarm();
      }
      await writer.abort(new Error("Managed inference stream failed")).catch(
        () => {},
      );
      throw error;
    }
  }

  private async completeMailSummary(
    input: ManagedInferenceRequest,
    fingerprint: string,
    generation: ReturnType<typeof createOpenRouterGeneration>,
  ): Promise<ManagedMailSummary> {
    const policy = await this.env.ACCOUNTS.getManagedInferencePolicy(
      this.installationId,
    );
    const monthlyLimitNanoUsd = effectiveMonthlyLimit(
      policy,
      this.installationId,
      this.deploymentMonthlyLimitNanoUsd,
    );
    const routing = requireManagedInferenceRouting(policy.routing);
    const startedAt = Date.now();
    const reservedNanoUsd = reservationNanoUsd(input, routing);
    this.reserve(
      input,
      startedAt,
      reservedNanoUsd,
      monthlyLimitNanoUsd,
      "mail-intake",
      fingerprint,
    );
    await this.scheduleNextAlarm();

    let result: ManagedInferenceResult;
    try {
      result = await generation.result(routing);
    } catch (error) {
      this.settleFailure(
        input.logicalRequestId,
        Date.now(),
        generation.accepted() ? reservedNanoUsd : 0,
      );
      await this.scheduleNextAlarm();
      throw error;
    }
    let summary: ManagedMailSummary;
    try {
      summary = parseManagedMailSummaryResult(result);
    } catch (error) {
      try {
        this.settleResult(input.logicalRequestId, result, routing, Date.now(), {
          outcome: failedOutcomeForResult(result),
          minimumCostNanoUsd: acceptedFailureCost(
            generation,
            result,
            reservedNanoUsd,
          ),
          resultJson: null,
        });
      } catch {
        this.settleFailure(
          input.logicalRequestId,
          Date.now(),
          generation.accepted() ? reservedNanoUsd : 0,
        );
      }
      await this.scheduleNextAlarm();
      throw error;
    }
    try {
      this.settleResult(input.logicalRequestId, result, routing, Date.now(), {
        outcome: "completed",
        resultJson: JSON.stringify(summary),
      });
    } catch (error) {
      this.settleFailure(
        input.logicalRequestId,
        Date.now(),
        generation.accepted() ? reservedNanoUsd : 0,
      );
      await this.scheduleNextAlarm();
      throw error;
    }
    await this.scheduleNextAlarm();
    return summary;
  }

  private reserve(
    input: ManagedInferenceRequest,
    startedAt: number,
    reservedNanoUsd: number,
    monthlyLimitNanoUsd: number,
    purpose: ManagedInferencePurpose,
    requestFingerprint: string | null,
  ): void {
    const period = inferencePeriod(startedAt);
    const reservationExpiresAt = startedAt
      + input.timeoutMs
      + RESERVATION_GRACE_MS;
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ state: StoredRequestState }>(
        "SELECT state FROM inference_requests WHERE logical_request_id = ?",
        input.logicalRequestId,
      ).toArray()[0];
      if (existing) {
        throw new Error(
          `Managed inference request was already ${existing.state}`,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO inference_periods (period)
         VALUES (?)
         ON CONFLICT(period) DO NOTHING`,
        period,
      );
      const usage = this.ctx.storage.sql.exec<{
        spent_nano_usd: number;
        reserved_nano_usd: number;
      }>(
        `SELECT spent_nano_usd, reserved_nano_usd
         FROM inference_periods
         WHERE period = ?`,
        period,
      ).one();
      if (
        usage.spent_nano_usd
          + usage.reserved_nano_usd
          + reservedNanoUsd > monthlyLimitNanoUsd
      ) {
        throw new Error("Managed inference monthly allowance is exhausted");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO inference_requests (
           logical_request_id, local_uid, process_id, run_id, period, model,
           purpose, request_fingerprint, state, reserved_nano_usd, started_at,
           reservation_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        input.logicalRequestId,
        input.actor.localUid,
        input.actor.processId ?? null,
        input.actor.runId ?? null,
        period,
        input.model,
        purpose,
        requestFingerprint,
        reservedNanoUsd,
        startedAt,
        reservationExpiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE inference_periods
         SET reserved_nano_usd = reserved_nano_usd + ?,
             started_requests = started_requests + 1
         WHERE period = ?`,
        reservedNanoUsd,
        period,
      );
    });
  }

  private settleResult(
    logicalRequestId: string,
    result: ManagedInferenceResult,
    routing: ManagedInferenceRouting,
    completedAt: number,
    options?: {
      outcome?: Exclude<ManagedInferenceUsageOutcome, "abandoned">;
      minimumCostNanoUsd?: number;
      resultJson?: string | null;
    },
  ): void {
    const outcome = options?.outcome ?? outcomeForResult(result);
    const usage = normalizedUsage(result);
    const costNanoUsd = Math.max(
      usageNanoUsd(result.usage, routing),
      options?.minimumCostNanoUsd ?? 0,
    );
    this.settle(logicalRequestId, {
      outcome,
      costNanoUsd,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.total,
      responseModel: result.responseModel ?? null,
      providerResponseId: result.responseId ?? null,
      stopReason: result.stopReason,
      completedAt,
      resultJson: options?.resultJson ?? null,
    });
  }

  private settleFailure(
    logicalRequestId: string,
    completedAt: number,
    costNanoUsd = 0,
  ): void {
    const request = this.requestState(logicalRequestId);
    if (!request || request.state !== "reserved") return;
    this.settle(logicalRequestId, {
      outcome: "failed",
      costNanoUsd,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      responseModel: null,
      providerResponseId: null,
      stopReason: "error",
      completedAt,
      resultJson: null,
    });
  }

  private settle(
    logicalRequestId: string,
    settlement: {
      outcome: Exclude<ManagedInferenceUsageOutcome, "abandoned">;
      costNanoUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      responseModel: string | null;
      providerResponseId: string | null;
      stopReason: ManagedInferenceUsageEvent["stopReason"];
      completedAt: number;
      resultJson: string | null;
    },
  ): void {
    this.ctx.storage.transactionSync(() => {
      const request = this.requestState(logicalRequestId);
      if (!request || request.state !== "reserved") {
        throw new Error("Managed inference reservation is no longer active");
      }
      this.ctx.storage.sql.exec(
        `UPDATE inference_requests
         SET state = ?, cost_nano_usd = ?, input_tokens = ?,
             output_tokens = ?, cache_read_tokens = ?,
             cache_write_tokens = ?, total_tokens = ?, response_model = ?,
             provider_response_id = ?, stop_reason = ?, completed_at = ?,
             result_json = ?, next_export_at = ?
         WHERE logical_request_id = ? AND state = 'reserved'`,
        settlement.outcome,
        settlement.costNanoUsd,
        settlement.inputTokens,
        settlement.outputTokens,
        settlement.cacheReadTokens,
        settlement.cacheWriteTokens,
        settlement.totalTokens,
        settlement.responseModel,
        settlement.providerResponseId,
        settlement.stopReason,
        settlement.completedAt,
        settlement.resultJson,
        settlement.completedAt + EXPORT_DELAY_MS,
        logicalRequestId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE inference_periods
         SET reserved_nano_usd = MAX(0, reserved_nano_usd - ?),
             spent_nano_usd = spent_nano_usd + ?,
             completed_requests = completed_requests + ?,
             failed_requests = failed_requests + ?,
             aborted_requests = aborted_requests + ?
         WHERE period = ?`,
        request.reserved_nano_usd,
        settlement.costNanoUsd,
        settlement.outcome === "completed" ? 1 : 0,
        settlement.outcome === "failed" ? 1 : 0,
        settlement.outcome === "aborted" ? 1 : 0,
        request.period,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM inference_cancellations WHERE logical_request_id = ?",
        logicalRequestId,
      );
    });
  }

  private async abandonExpiredReservations(now: number): Promise<void> {
    const expired = this.ctx.storage.sql.exec<ReservationRow>(
      `SELECT logical_request_id, period, state, reserved_nano_usd
       FROM inference_requests
       WHERE state = 'reserved' AND reservation_expires_at <= ?`,
      now,
    ).toArray();
    if (expired.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      for (const request of expired) {
        this.ctx.storage.sql.exec(
          `UPDATE inference_requests
           SET state = 'abandoned', cost_nano_usd = ?,
               input_tokens = 0, output_tokens = 0,
               cache_read_tokens = 0, cache_write_tokens = 0,
               total_tokens = 0, completed_at = ?, next_export_at = ?
           WHERE logical_request_id = ? AND state = 'reserved'`,
          request.reserved_nano_usd,
          now,
          now + EXPORT_DELAY_MS,
          request.logical_request_id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE inference_periods
           SET reserved_nano_usd = MAX(0, reserved_nano_usd - ?),
               spent_nano_usd = spent_nano_usd + ?,
               abandoned_requests = abandoned_requests + 1
           WHERE period = ?`,
          request.reserved_nano_usd,
          request.reserved_nano_usd,
          request.period,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM inference_cancellations WHERE logical_request_id = ?",
          request.logical_request_id,
        );
      }
    });
    await Promise.all(expired.map(async (request) => {
      await this.activeGenerations.get(request.logical_request_id)?.abort();
      await this.activeMailSummaries.get(request.logical_request_id)?.abort();
    }));
  }

  private async exportCompletedRequests(now: number): Promise<void> {
    const rows = this.ctx.storage.sql.exec<ExportRow>(
      `SELECT
         logical_request_id, local_uid, process_id, run_id, purpose, period, model,
         state, reserved_nano_usd, cost_nano_usd, input_tokens,
         output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
         response_model, provider_response_id, stop_reason, started_at,
         completed_at, export_attempts
       FROM inference_requests
       WHERE exported_at IS NULL
         AND completed_at IS NOT NULL
         AND next_export_at <= ?
       ORDER BY completed_at, logical_request_id
       LIMIT ?`,
      now,
      EXPORT_BATCH_SIZE,
    ).toArray();
    if (rows.length === 0) return;

    try {
      await this.env.ACCOUNTS.recordManagedInferenceUsage(
        rows.map((row) => this.usageEvent(row)),
      );
    } catch {
      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          const attempts = row.export_attempts + 1;
          this.ctx.storage.sql.exec(
            `UPDATE inference_requests
             SET export_attempts = ?, next_export_at = ?
             WHERE logical_request_id = ? AND exported_at IS NULL`,
            attempts,
            now + exportBackoff(attempts),
            row.logical_request_id,
          );
        }
      });
      return;
    }

    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `UPDATE inference_requests
           SET exported_at = ?, next_export_at = NULL
           WHERE logical_request_id = ? AND exported_at IS NULL`,
          now,
          row.logical_request_id,
        );
      }
    });
  }

  private usageEvent(row: ExportRow): ManagedInferenceUsageEvent {
    if (row.model !== GSV_INFERENCE_PRODUCT_MODEL) {
      throw new Error("Stored managed inference model is invalid");
    }
    return {
      version: 1,
      installationId: this.installationId,
      logicalRequestId: row.logical_request_id,
      actor: {
        localUid: row.local_uid,
        processId: row.process_id ?? undefined,
        runId: row.run_id ?? undefined,
      },
      purpose: row.purpose,
      period: row.period,
      model: row.model,
      responseModel: row.response_model ?? undefined,
      providerResponseId: row.provider_response_id ?? undefined,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      reservedNanoUsd: row.reserved_nano_usd,
      costNanoUsd: row.cost_nano_usd,
      outcome: row.state,
      stopReason: row.stop_reason ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at
       FROM (
         SELECT MIN(reservation_expires_at) AS due_at
         FROM inference_requests
         WHERE state = 'reserved'
         UNION ALL
         SELECT MIN(next_export_at) AS due_at
         FROM inference_requests
         WHERE exported_at IS NULL AND completed_at IS NOT NULL
         UNION ALL
         SELECT MIN(expires_at) AS due_at
         FROM inference_cancellations
       )`,
    ).one().due_at;
    if (next === null) return;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > next) {
      await this.ctx.storage.setAlarm(Math.max(Date.now(), next));
    }
  }

  private isCancelled(logicalRequestId: string, now: number): boolean {
    return this.ctx.storage.sql.exec<{ cancelled: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM inference_cancellations
         WHERE logical_request_id = ? AND expires_at > ?
       ) AS cancelled`,
      logicalRequestId,
      now,
    ).one().cancelled === 1;
  }

  private deleteExpiredCancellations(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM inference_cancellations WHERE expires_at <= ?",
      now,
    );
  }

  private requestState(logicalRequestId: string): RequestStateRow | undefined {
    return this.ctx.storage.sql.exec<RequestStateRow>(
      `SELECT logical_request_id, period, state, purpose, request_fingerprint,
              result_json, reserved_nano_usd
       FROM inference_requests
       WHERE logical_request_id = ?`,
      logicalRequestId,
    ).toArray()[0];
  }

  private mailSummaryReplay(
    logicalRequestId: string,
    fingerprint: string,
  ): ManagedMailSummary | undefined {
    const status = this.mailSummaryStatus(logicalRequestId, fingerprint);
    if (status.state === "missing") return undefined;
    if (status.state === "completed") return status.summary;
    throw new Error(`Managed mail summary request was already ${status.state}`);
  }

  private mailSummaryStatus(
    logicalRequestId: string,
    fingerprint: string,
  ): ManagedMailSummaryRequestStatus {
    const request = this.requestState(logicalRequestId);
    if (!request) return { state: "missing" };
    if (
      request.purpose !== "mail-intake"
      || request.request_fingerprint !== fingerprint
    ) {
      throw new Error("Managed mail summary request conflicts with an existing request");
    }
    if (request.state !== "completed") return { state: request.state };
    if (request.result_json === null) {
      throw new Error("Stored managed mail summary is invalid");
    }
    let result: Parameters<typeof validateManagedMailSummary>[0];
    try {
      result = JSON.parse(request.result_json);
    } catch {
      throw new Error("Stored managed mail summary is invalid");
    }
    try {
      return { state: "completed", summary: validateManagedMailSummary(result) };
    } catch {
      throw new Error("Stored managed mail summary is invalid");
    }
  }

  private requireOwnedRequest(input: { installationId: string }): void {
    if (input.installationId !== this.installationId) {
      throw new Error("Managed inference request belongs to another installation");
    }
  }
}

function normalizedUsage(result: ManagedInferenceResult) {
  return {
    input: tokenCount(result.usage.input),
    output: tokenCount(result.usage.output),
    cacheRead: tokenCount(result.usage.cacheRead),
    cacheWrite: tokenCount(result.usage.cacheWrite),
    total: tokenCount(result.usage.totalTokens),
  };
}

function abortedResult(): ManagedInferenceResult {
  return {
    role: "assistant",
    content: [],
    api: "gsv-inference",
    provider: GSV_INFERENCE_PROVIDER,
    model: GSV_INFERENCE_PRODUCT_MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "aborted",
    timestamp: Date.now(),
  };
}

function resultEvent(
  result: ManagedInferenceResult,
): Extract<ManagedInferenceStreamEvent, { type: "done" | "error" }> {
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    return { type: "error", reason: result.stopReason, error: result };
  }
  return { type: "done", reason: result.stopReason, message: result };
}

function streamFromEvent(
  event: Extract<ManagedInferenceStreamEvent, { type: "done" | "error" }>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeManagedInferenceStreamEvent(event));
      controller.close();
    },
  });
}

async function writeTerminalEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: Extract<ManagedInferenceStreamEvent, { type: "done" | "error" }>,
): Promise<void> {
  await writer.write(encodeManagedInferenceStreamEvent(event));
  await writer.close();
}

function tokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Managed inference usage is invalid");
  }
  return value;
}

function outcomeForResult(
  result: ManagedInferenceResult,
): Exclude<ManagedInferenceUsageOutcome, "abandoned"> {
  if (result.stopReason === "aborted") return "aborted";
  if (result.stopReason === "error") return "failed";
  return "completed";
}

function acceptedFailureCost(
  generation: ReturnType<typeof createOpenRouterGeneration>,
  result: ManagedInferenceResult,
  reservedNanoUsd: number,
): number {
  return generation.accepted()
      && (result.stopReason === "error" || result.stopReason === "aborted")
    ? reservedNanoUsd
    : 0;
}

function failedOutcomeForResult(
  result: ManagedInferenceResult,
): Exclude<ManagedInferenceUsageOutcome, "abandoned" | "completed"> {
  const outcome = outcomeForResult(result);
  return outcome === "completed" ? "failed" : outcome;
}

function parseMonthlyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Managed inference monthly limit is invalid");
  }
  return value;
}

function effectiveMonthlyLimit(
  policy: ManagedInferencePolicy,
  installationId: string,
  deploymentLimitNanoUsd: number,
): number {
  if (
    policy.version !== 1
    || policy.installationId !== installationId
    || (policy.enabled !== true && policy.enabled !== false)
    || !Number.isSafeInteger(policy.monthlyLimitNanoUsd)
    || policy.monthlyLimitNanoUsd < 0
  ) {
    throw new Error("Managed inference policy is invalid");
  }
  if (!policy.enabled) {
    throw new Error("Managed inference is disabled for this installation");
  }
  if (policy.monthlyLimitNanoUsd === 0) {
    throw new Error("Managed inference policy is invalid");
  }
  return deploymentLimitNanoUsd === 0
    ? policy.monthlyLimitNanoUsd
    : Math.min(policy.monthlyLimitNanoUsd, deploymentLimitNanoUsd);
}

function requireManagedInferenceRouting(
  value: ManagedInferenceRouting,
): ManagedInferenceRouting {
  if (
    !value
    || value.version !== 1
    || String(value.modelId) !== value.modelId
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.modelId)
    || String(value.displayName) !== value.displayName
    || value.displayName.length < 1
    || value.displayName.length > 200
    || value.displayName.trim() !== value.displayName
    || !positiveInteger(value.contextWindow)
    || !positiveInteger(value.maxOutputTokens)
    || value.maxOutputTokens > value.contextWindow
    || (value.reasoning !== true && value.reasoning !== false)
    || !price(value.inputNanoUsdPerToken)
    || !price(value.outputNanoUsdPerToken)
    || !price(value.cacheReadNanoUsdPerToken)
    || !price(value.cacheWriteNanoUsdPerToken)
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < 0
  ) {
    throw new Error("Managed inference routing is invalid");
  }
  const provider = value.provider;
  if (
    !provider
    || provider.allowFallbacks !== true && provider.allowFallbacks !== false
    || provider.requireParameters !== true && provider.requireParameters !== false
    || (provider.dataCollection !== "allow" && provider.dataCollection !== "deny")
    || provider.zdr !== true && provider.zdr !== false
    || !providerList(provider.order)
    || !providerList(provider.only)
    || !providerList(provider.ignore)
    || provider.only.some((name) => provider.ignore.includes(name))
    || !Array.isArray(provider.quantizations)
    || provider.quantizations.length > MANAGED_INFERENCE_QUANTIZATIONS.length
    || new Set(provider.quantizations).size !== provider.quantizations.length
    || provider.quantizations.some((item) =>
      !MANAGED_INFERENCE_QUANTIZATIONS.includes(item)
    )
    || !["default", "price", "throughput", "latency"].includes(provider.sort)
    || !optionalPositive(provider.preferredMinThroughput)
    || !optionalPositive(provider.preferredMaxLatency)
  ) {
    throw new Error("Managed inference routing is invalid");
  }
  return value;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function price(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function providerList(value: string[]): boolean {
  return Array.isArray(value)
    && value.length <= 32
    && new Set(value).size === value.length
    && value.every((item) =>
      String(item) === item
      && item.length >= 1
      && item.length <= 80
      && item.trim() === item
      && !/[\p{Cc},]/u.test(item)
    );
}

function optionalPositive(value: number | undefined): boolean {
  return value === undefined
    || (Number(value) === value && Number.isFinite(value) && value > 0);
}

function inferencePeriod(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function exportBackoff(attempts: number): number {
  return Math.min(MAX_EXPORT_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 8));
}
