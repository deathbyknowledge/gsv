import type { ManagedEntitlementProjection } from "@humansandmachines/gsv/protocol";
import type { InferencePrice, TokenUsage } from "./price-book";
import { normalizeUsage, tokenCostMicrounits } from "./price-book";

type AttemptState = "admitted" | "running" | "succeeded" | "failed" | "aborted" | "ambiguous";
type TerminalAttemptState = Extract<AttemptState, "succeeded" | "failed" | "aborted" | "ambiguous">;

type BudgetPeriodRow = {
  period_start: number;
  period_end: number;
  entitlement_version: number;
  budget_microunits: number;
  spent_microunits: number;
  reserved_microunits: number;
};

type DailyBudgetRow = {
  day_start: number;
  period_start: number;
  budget_microunits: number;
  spent_microunits: number;
  reserved_microunits: number;
};

type InferenceRequestRow = {
  logical_request_id: string;
  request_fingerprint: string;
  actor_uid: number;
  process_id: string | null;
  run_id: string | null;
  period_start: number;
  state: AttemptState;
  attempt_count: number;
  spent_microunits: number;
};

type ProviderAttemptRow = {
  attempt_id: string;
  logical_request_id: string;
  ordinal: number;
  day_start: number;
  state: AttemptState;
  reserved_microunits: number;
  settled_microunits: number | null;
  cache_hit_input_tokens: number | null;
  cache_miss_input_tokens: number | null;
  output_tokens: number | null;
  deadline_at: number;
};

export class BudgetAdmissionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export type BudgetAdmission = {
  attemptId: string;
  ordinal: number;
  reservationMicrounits: number;
  deadlineAt: number;
};

export type BudgetSettlement = {
  attemptId: string;
  state: TerminalAttemptState;
  settledMicrounits: number;
  usage: TokenUsage | null;
};

export type BudgetSnapshot = {
  periods: BudgetPeriodRow[];
  days: DailyBudgetRow[];
  requests: InferenceRequestRow[];
  attempts: ProviderAttemptRow[];
};

export type BudgetPeriodUsage = {
  periodStartsAt: number;
  periodEndsAt: number;
  budgetMicrounits: number;
  spentMicrounits: number;
  reservedMicrounits: number;
};

export class BudgetLedger {
  constructor(private readonly storage: DurableObjectStorage) {}

  beginAttempt(input: {
    entitlement: ManagedEntitlementProjection;
    logicalRequestId: string;
    requestFingerprint: string;
    actorUid: number;
    processId?: string;
    runId?: string;
    price: InferencePrice;
    reservationMicrounits: number;
    dailyBudgetMicrounits: number;
    maxConcurrent: number;
    maxAttempts: number;
    deadlineAt: number;
    now: number;
  }): BudgetAdmission {
    return this.storage.transactionSync(() => {
      const period = this.ensurePeriod(input.entitlement, input.now);
      const dayStart = utcDayStart(input.now);
      const day = this.ensureDay(
        dayStart,
        period.period_start,
        Math.min(period.budget_microunits, input.dailyBudgetMicrounits),
        input.now,
      );
      const existing = this.request(input.logicalRequestId);
      if (existing) {
        assertRequestMatches(existing, input, period.period_start);
        if (existing.state === "succeeded") {
          throw admissionError("Managed inference request already completed", 409, "request_complete");
        }
        if (existing.state === "admitted" || existing.state === "running") {
          throw admissionError("Managed inference request is already running", 409, "request_running");
        }
        if (existing.attempt_count >= input.maxAttempts) {
          throw admissionError("Managed inference retry limit reached", 409, "retry_limit");
        }
      }

      const concurrent = this.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM provider_attempts
         WHERE state IN ('admitted', 'running')`,
      ).one().count;
      if (concurrent >= input.maxConcurrent) {
        throw admissionError("Managed inference concurrency limit reached", 429, "concurrency_limit");
      }
      assertBudgetAvailable(
        period.budget_microunits,
        period.spent_microunits,
        period.reserved_microunits,
        input.reservationMicrounits,
        "monthly_budget",
      );
      assertBudgetAvailable(
        day.budget_microunits,
        day.spent_microunits,
        day.reserved_microunits,
        input.reservationMicrounits,
        "daily_budget",
      );

      const ordinal = (existing?.attempt_count ?? 0) + 1;
      const attemptId = `${input.logicalRequestId}:attempt:${ordinal}`;
      if (existing) {
        this.storage.sql.exec(
          `UPDATE inference_requests
           SET state = 'admitted', attempt_count = ?, updated_at = ?
           WHERE logical_request_id = ?`,
          ordinal,
          input.now,
          input.logicalRequestId,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO inference_requests (
             logical_request_id, request_fingerprint, actor_uid, process_id,
             run_id, period_start, state, attempt_count, spent_microunits,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'admitted', 1, 0, ?, ?)`,
          input.logicalRequestId,
          input.requestFingerprint,
          input.actorUid,
          input.processId ?? null,
          input.runId ?? null,
          period.period_start,
          input.now,
          input.now,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO provider_attempts (
           attempt_id, logical_request_id, ordinal, provider, model_revision,
           price_book_version, day_start, state, reserved_microunits,
           settled_microunits, cache_hit_input_tokens,
           cache_miss_input_tokens, output_tokens, started_at, deadline_at,
           finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
        attemptId,
        input.logicalRequestId,
        ordinal,
        input.price.provider,
        input.price.modelRevision,
        input.price.version,
        dayStart,
        input.reservationMicrounits,
        input.deadlineAt,
      );
      this.storage.sql.exec(
        `UPDATE budget_periods
         SET reserved_microunits = reserved_microunits + ?, updated_at = ?
         WHERE period_start = ?`,
        input.reservationMicrounits,
        input.now,
        period.period_start,
      );
      this.storage.sql.exec(
        `UPDATE daily_budgets
         SET reserved_microunits = reserved_microunits + ?, updated_at = ?
         WHERE day_start = ? AND period_start = ?`,
        input.reservationMicrounits,
        input.now,
        dayStart,
        period.period_start,
      );
      return {
        attemptId,
        ordinal,
        reservationMicrounits: input.reservationMicrounits,
        deadlineAt: input.deadlineAt,
      };
    });
  }

  markRunning(attemptId: string, now: number): void {
    this.storage.transactionSync(() => {
      const attempt = this.attempt(attemptId);
      if (!attempt) throw new Error("Managed inference attempt is unavailable");
      if (attempt.state === "running") return;
      if (attempt.state !== "admitted") {
        throw new Error("Managed inference attempt cannot start from its current state");
      }
      this.storage.sql.exec(
        `UPDATE provider_attempts
         SET state = 'running', started_at = ?
         WHERE attempt_id = ?`,
        now,
        attemptId,
      );
      this.storage.sql.exec(
        `UPDATE inference_requests
         SET state = 'running', updated_at = ?
         WHERE logical_request_id = ?`,
        now,
        attempt.logical_request_id,
      );
    });
  }

  settleAttempt(input: {
    attemptId: string;
    state: Exclude<TerminalAttemptState, "ambiguous">;
    usage: TokenUsage;
    price: InferencePrice;
    now: number;
  }): BudgetSettlement {
    const usage = normalizeUsage(input.usage);
    return this.settle(
      input.attemptId,
      input.state,
      tokenCostMicrounits(usage, input.price),
      usage,
      input.now,
    );
  }

  settleAmbiguous(attemptId: string, now: number): BudgetSettlement {
    const attempt = this.attempt(attemptId);
    if (!attempt) throw new Error("Managed inference attempt is unavailable");
    return this.settle(
      attemptId,
      "ambiguous",
      attempt.reserved_microunits,
      null,
      now,
    );
  }

  settleAborted(attemptId: string, now: number): BudgetSettlement {
    return this.settle(attemptId, "aborted", 0, {
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      outputTokens: 0,
    }, now);
  }

  settleAllActiveAmbiguous(now: number): BudgetSettlement[] {
    const attempts = this.storage.sql.exec<{ attempt_id: string }>(
      `SELECT attempt_id
       FROM provider_attempts
       WHERE state IN ('admitted', 'running')
       ORDER BY deadline_at, attempt_id`,
    ).toArray();
    return attempts.map((attempt) => this.settleAmbiguous(attempt.attempt_id, now));
  }

  settleExpired(now: number): BudgetSettlement[] {
    const attempts = this.storage.sql.exec<{ attempt_id: string }>(
      `SELECT attempt_id
       FROM provider_attempts
       WHERE state IN ('admitted', 'running') AND deadline_at <= ?
       ORDER BY deadline_at, attempt_id`,
      now,
    ).toArray();
    return attempts.map((attempt) => this.settleAmbiguous(attempt.attempt_id, now));
  }

  nextActiveDeadline(): number | null {
    return this.storage.sql.exec<{ deadline_at: number }>(
      `SELECT deadline_at
       FROM provider_attempts
       WHERE state IN ('admitted', 'running')
       ORDER BY deadline_at
       LIMIT 1`,
    ).toArray()[0]?.deadline_at ?? null;
  }

  activeAttempt(logicalRequestId: string): string | null {
    return this.storage.sql.exec<{ attempt_id: string }>(
      `SELECT attempt_id
       FROM provider_attempts
       WHERE logical_request_id = ? AND state IN ('admitted', 'running')
       ORDER BY ordinal DESC
       LIMIT 1`,
      logicalRequestId,
    ).toArray()[0]?.attempt_id ?? null;
  }

  snapshot(): BudgetSnapshot {
    return {
      periods: this.storage.sql.exec<BudgetPeriodRow>(
        "SELECT * FROM budget_periods ORDER BY period_start",
      ).toArray(),
      days: this.storage.sql.exec<DailyBudgetRow>(
        "SELECT * FROM daily_budgets ORDER BY period_start, day_start",
      ).toArray(),
      requests: this.storage.sql.exec<InferenceRequestRow>(
        "SELECT * FROM inference_requests ORDER BY created_at, logical_request_id",
      ).toArray(),
      attempts: this.storage.sql.exec<ProviderAttemptRow>(
        "SELECT * FROM provider_attempts ORDER BY logical_request_id, ordinal",
      ).toArray(),
    };
  }

  currentPeriodUsage(now = Date.now()): BudgetPeriodUsage | null {
    const period = this.storage.sql.exec<BudgetPeriodRow>(
      `SELECT period_start, period_end, entitlement_version,
              budget_microunits, spent_microunits, reserved_microunits
       FROM budget_periods
       WHERE period_start <= ? AND period_end > ?
       ORDER BY period_start DESC
       LIMIT 1`,
      now,
      now,
    ).toArray()[0];
    return period ? {
      periodStartsAt: period.period_start,
      periodEndsAt: period.period_end,
      budgetMicrounits: period.budget_microunits,
      spentMicrounits: period.spent_microunits,
      reservedMicrounits: period.reserved_microunits,
    } : null;
  }

  private settle(
    attemptId: string,
    state: TerminalAttemptState,
    settledMicrounits: number,
    usage: TokenUsage | null,
    now: number,
  ): BudgetSettlement {
    if (!Number.isSafeInteger(settledMicrounits) || settledMicrounits < 0) {
      throw new Error("Managed inference settlement is invalid");
    }
    return this.storage.transactionSync(() => {
      const attempt = this.attempt(attemptId);
      if (!attempt) throw new Error("Managed inference attempt is unavailable");
      if (isTerminal(attempt.state)) {
        return settlementFromRow(attempt);
      }
      if (settledMicrounits > attempt.reserved_microunits) {
        throw new Error("Managed inference usage exceeded its reservation");
      }
      const request = this.request(attempt.logical_request_id);
      if (!request) throw new Error("Managed inference request is unavailable");
      this.storage.sql.exec(
        `UPDATE provider_attempts
         SET state = ?, settled_microunits = ?,
             cache_hit_input_tokens = ?, cache_miss_input_tokens = ?,
             output_tokens = ?, finished_at = ?
         WHERE attempt_id = ?`,
        state,
        settledMicrounits,
        usage?.cacheHitInputTokens ?? null,
        usage?.cacheMissInputTokens ?? null,
        usage?.outputTokens ?? null,
        now,
        attemptId,
      );
      this.storage.sql.exec(
        `UPDATE inference_requests
         SET state = ?, spent_microunits = spent_microunits + ?, updated_at = ?
         WHERE logical_request_id = ?`,
        state,
        settledMicrounits,
        now,
        attempt.logical_request_id,
      );
      this.storage.sql.exec(
        `UPDATE budget_periods
         SET spent_microunits = spent_microunits + ?,
             reserved_microunits = reserved_microunits - ?, updated_at = ?
         WHERE period_start = ?`,
        settledMicrounits,
        attempt.reserved_microunits,
        now,
        request.period_start,
      );
      this.storage.sql.exec(
        `UPDATE daily_budgets
         SET spent_microunits = spent_microunits + ?,
             reserved_microunits = reserved_microunits - ?, updated_at = ?
         WHERE day_start = ? AND period_start = ?`,
        settledMicrounits,
        attempt.reserved_microunits,
        now,
        attempt.day_start,
        request.period_start,
      );
      return {
        attemptId,
        state,
        settledMicrounits,
        usage,
      };
    });
  }

  private ensurePeriod(
    entitlement: ManagedEntitlementProjection,
    now: number,
  ): BudgetPeriodRow {
    let period = this.storage.sql.exec<BudgetPeriodRow>(
      `SELECT period_start, period_end, entitlement_version,
              budget_microunits, spent_microunits, reserved_microunits
       FROM budget_periods
       WHERE period_start = ?`,
      entitlement.inferencePeriodStartsAt,
    ).toArray()[0];
    if (!period) {
      this.storage.sql.exec(
        `INSERT INTO budget_periods (
           period_start, period_end, entitlement_version, budget_microunits,
           spent_microunits, reserved_microunits, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
        entitlement.inferencePeriodStartsAt,
        entitlement.inferencePeriodEndsAt,
        entitlement.version,
        entitlement.inferenceBudgetMicrounits,
        now,
        now,
      );
      period = this.storage.sql.exec<BudgetPeriodRow>(
        `SELECT period_start, period_end, entitlement_version,
                budget_microunits, spent_microunits, reserved_microunits
         FROM budget_periods WHERE period_start = ?`,
        entitlement.inferencePeriodStartsAt,
      ).one();
      return period;
    }
    if (entitlement.version < period.entitlement_version) {
      throw admissionError("Managed inference entitlement is stale", 409, "stale_entitlement");
    }
    if (entitlement.version === period.entitlement_version) {
      if (
        entitlement.inferencePeriodEndsAt !== period.period_end
        || entitlement.inferenceBudgetMicrounits !== period.budget_microunits
      ) {
        throw admissionError("Managed inference entitlement conflicts", 409, "entitlement_conflict");
      }
      return period;
    }
    this.storage.sql.exec(
      `UPDATE budget_periods
       SET period_end = ?, entitlement_version = ?, budget_microunits = ?, updated_at = ?
       WHERE period_start = ?`,
      entitlement.inferencePeriodEndsAt,
      entitlement.version,
      entitlement.inferenceBudgetMicrounits,
      now,
      entitlement.inferencePeriodStartsAt,
    );
    return {
      ...period,
      period_end: entitlement.inferencePeriodEndsAt,
      entitlement_version: entitlement.version,
      budget_microunits: entitlement.inferenceBudgetMicrounits,
    };
  }

  private ensureDay(
    dayStart: number,
    periodStart: number,
    budgetMicrounits: number,
    now: number,
  ): DailyBudgetRow {
    const existing = this.storage.sql.exec<DailyBudgetRow>(
      `SELECT day_start, period_start, budget_microunits,
              spent_microunits, reserved_microunits
       FROM daily_budgets
       WHERE day_start = ? AND period_start = ?`,
      dayStart,
      periodStart,
    ).toArray()[0];
    if (!existing) {
      this.storage.sql.exec(
        `INSERT INTO daily_budgets (
           day_start, period_start, budget_microunits, spent_microunits,
           reserved_microunits, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 0, ?, ?)`,
        dayStart,
        periodStart,
        budgetMicrounits,
        now,
        now,
      );
      return {
        day_start: dayStart,
        period_start: periodStart,
        budget_microunits: budgetMicrounits,
        spent_microunits: 0,
        reserved_microunits: 0,
      };
    }
    if (existing.budget_microunits !== budgetMicrounits) {
      this.storage.sql.exec(
        `UPDATE daily_budgets SET budget_microunits = ?, updated_at = ?
         WHERE day_start = ? AND period_start = ?`,
        budgetMicrounits,
        now,
        dayStart,
        periodStart,
      );
      return { ...existing, budget_microunits: budgetMicrounits };
    }
    return existing;
  }

  private request(logicalRequestId: string): InferenceRequestRow | null {
    return this.storage.sql.exec<InferenceRequestRow>(
      `SELECT logical_request_id, request_fingerprint, actor_uid, process_id,
              run_id, period_start, state, attempt_count, spent_microunits
       FROM inference_requests
       WHERE logical_request_id = ?`,
      logicalRequestId,
    ).toArray()[0] ?? null;
  }

  private attempt(attemptId: string): ProviderAttemptRow | null {
    return this.storage.sql.exec<ProviderAttemptRow>(
      `SELECT attempt_id, logical_request_id, ordinal, day_start, state,
              reserved_microunits, settled_microunits,
              cache_hit_input_tokens, cache_miss_input_tokens, output_tokens,
              deadline_at
       FROM provider_attempts
       WHERE attempt_id = ?`,
      attemptId,
    ).toArray()[0] ?? null;
  }
}

function assertRequestMatches(
  row: InferenceRequestRow,
  input: {
    requestFingerprint: string;
    actorUid: number;
    processId?: string;
    runId?: string;
  },
  periodStart: number,
): void {
  if (
    row.request_fingerprint !== input.requestFingerprint
    || row.actor_uid !== input.actorUid
    || row.process_id !== (input.processId ?? null)
    || row.run_id !== (input.runId ?? null)
    || row.period_start !== periodStart
  ) {
    throw admissionError(
      "Managed inference request id was reused with different input",
      409,
      "request_conflict",
    );
  }
}

function assertBudgetAvailable(
  budget: number,
  spent: number,
  reserved: number,
  requested: number,
  code: "monthly_budget" | "daily_budget",
): void {
  if (requested > budget - spent - reserved) {
    throw admissionError(
      code === "monthly_budget"
        ? "Managed inference monthly budget reached"
        : "Managed inference daily budget reached",
      429,
      code,
    );
  }
}

function settlementFromRow(row: ProviderAttemptRow): BudgetSettlement {
  if (!isTerminal(row.state) || row.settled_microunits === null) {
    throw new Error("Managed inference settlement is incomplete");
  }
  const hasUsage = row.cache_hit_input_tokens !== null
    && row.cache_miss_input_tokens !== null
    && row.output_tokens !== null;
  return {
    attemptId: row.attempt_id,
    state: row.state,
    settledMicrounits: row.settled_microunits,
    usage: hasUsage
      ? {
          cacheHitInputTokens: row.cache_hit_input_tokens!,
          cacheMissInputTokens: row.cache_miss_input_tokens!,
          outputTokens: row.output_tokens!,
        }
      : null,
  };
}

function isTerminal(state: AttemptState): state is TerminalAttemptState {
  return state === "succeeded"
    || state === "failed"
    || state === "aborted"
    || state === "ambiguous";
}

function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function admissionError(message: string, status: number, code: string): BudgetAdmissionError {
  return new BudgetAdmissionError(message, status, code);
}
