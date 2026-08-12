import { DurableObject } from "cloudflare:workers";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferencePolicy,
  type ManagedInferenceRequest,
  type ManagedInferenceResult,
  type ManagedInferenceUsageEvent,
  type ManagedInferenceUsageOutcome,
} from "@humansandmachines/gsv/protocol";
import type { InferenceEnv } from "./env";
import { createOpenRouterGeneration } from "./openrouter";
import { reservationNanoUsd, usageNanoUsd } from "./pricing";
import { runInferenceSqlMigrations } from "./schema/migrations";
import {
  validateManagedInferenceRequest,
  validateOpaqueId,
} from "./validation";

const EXPORT_DELAY_MS = 5_000;
const EXPORT_BATCH_SIZE = 100;
const RESERVATION_GRACE_MS = 5 * 60 * 1000;
const MAX_EXPORT_BACKOFF_MS = 5 * 60 * 1000;

type ActiveGeneration = {
  promise: Promise<ManagedInferenceResult>;
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
  reserved_nano_usd: number;
};

type ExportRow = {
  logical_request_id: string;
  local_uid: number;
  process_id: string | null;
  run_id: string | null;
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
    const existing = this.activeGenerations.get(input.logicalRequestId);
    if (existing) return await existing.promise;

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

  async abort(logicalRequestIdValue: string): Promise<void> {
    const logicalRequestId = validateOpaqueId(
      logicalRequestIdValue,
      "logicalRequestId",
    );
    await this.activeGenerations.get(logicalRequestId)?.abort();
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
    const monthlyLimitNanoUsd = effectiveMonthlyLimit(
      policy,
      this.installationId,
      this.deploymentMonthlyLimitNanoUsd,
    );
    const startedAt = Date.now();
    const reservedNanoUsd = reservationNanoUsd(input);
    this.reserve(
      input,
      startedAt,
      reservedNanoUsd,
      monthlyLimitNanoUsd,
    );
    await this.scheduleNextAlarm();

    try {
      const result = await generation.result();
      this.settleResult(input.logicalRequestId, result, Date.now());
      await this.scheduleNextAlarm();
      return result;
    } catch (error) {
      this.settleFailure(input.logicalRequestId, Date.now());
      await this.scheduleNextAlarm();
      throw error;
    }
  }

  private reserve(
    input: ManagedInferenceRequest,
    startedAt: number,
    reservedNanoUsd: number,
    monthlyLimitNanoUsd: number,
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
           state, reserved_nano_usd, started_at, reservation_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        input.logicalRequestId,
        input.actor.localUid,
        input.actor.processId ?? null,
        input.actor.runId ?? null,
        period,
        input.model,
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
    completedAt: number,
  ): void {
    const outcome = outcomeForResult(result);
    const usage = normalizedUsage(result);
    const costNanoUsd = usageNanoUsd(result.usage);
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
    });
  }

  private settleFailure(logicalRequestId: string, completedAt: number): void {
    const request = this.requestState(logicalRequestId);
    if (!request || request.state !== "reserved") return;
    this.settle(logicalRequestId, {
      outcome: "failed",
      costNanoUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      responseModel: null,
      providerResponseId: null,
      stopReason: "error",
      completedAt,
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
             next_export_at = ?
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
    });
  }

  private async abandonExpiredReservations(now: number): Promise<void> {
    const expired = this.ctx.storage.sql.exec<RequestStateRow>(
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
           SET state = 'abandoned', cost_nano_usd = 0,
               input_tokens = 0, output_tokens = 0,
               cache_read_tokens = 0, cache_write_tokens = 0,
               total_tokens = 0, completed_at = ?, next_export_at = ?
           WHERE logical_request_id = ? AND state = 'reserved'`,
          now,
          now + EXPORT_DELAY_MS,
          request.logical_request_id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE inference_periods
           SET reserved_nano_usd = MAX(0, reserved_nano_usd - ?),
               abandoned_requests = abandoned_requests + 1
           WHERE period = ?`,
          request.reserved_nano_usd,
          request.period,
        );
      }
    });
    await Promise.all(expired.map(async (request) => {
      await this.activeGenerations.get(request.logical_request_id)?.abort();
    }));
  }

  private async exportCompletedRequests(now: number): Promise<void> {
    const rows = this.ctx.storage.sql.exec<ExportRow>(
      `SELECT
         logical_request_id, local_uid, process_id, run_id, period, model,
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
        ...(row.process_id ? { processId: row.process_id } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
      },
      period: row.period,
      model: row.model,
      ...(row.response_model ? { responseModel: row.response_model } : {}),
      ...(row.provider_response_id
        ? { providerResponseId: row.provider_response_id }
        : {}),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      reservedNanoUsd: row.reserved_nano_usd,
      costNanoUsd: row.cost_nano_usd,
      outcome: row.state,
      ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
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
       )`,
    ).one().due_at;
    if (next === null) return;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > next) {
      await this.ctx.storage.setAlarm(Math.max(Date.now(), next));
    }
  }

  private requestState(logicalRequestId: string): RequestStateRow | undefined {
    return this.ctx.storage.sql.exec<RequestStateRow>(
      `SELECT logical_request_id, period, state, reserved_nano_usd
       FROM inference_requests
       WHERE logical_request_id = ?`,
      logicalRequestId,
    ).toArray()[0];
  }

  private requireOwnedRequest(input: ManagedInferenceRequest): void {
    if (input.installationId !== this.installationId) {
      throw new Error("Managed inference request belongs to another installation");
    }
  }
}

function normalizedUsage(result: ManagedInferenceResult): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} {
  return {
    input: tokenCount(result.usage.input),
    output: tokenCount(result.usage.output),
    cacheRead: tokenCount(result.usage.cacheRead),
    cacheWrite: tokenCount(result.usage.cacheWrite),
    total: tokenCount(result.usage.totalTokens),
  };
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
    || typeof policy.enabled !== "boolean"
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

function inferencePeriod(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function exportBackoff(attempts: number): number {
  return Math.min(MAX_EXPORT_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 8));
}
