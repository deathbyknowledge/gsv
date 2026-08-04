import {
  parseSubscriptionSnapshot,
  type BillingCommerceProvider,
} from "./domain";
import { parseOpaqueId } from "../domain";
import type { BillingReconciler } from "./reconciler";

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 20;
const INITIAL_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type BillingTerminationState =
  | "requested"
  | "processing"
  | "complete"
  | "cancelled"
  | "failed";

export type BillingTerminationOperation = {
  operationId: string;
  deletionOperationId: string;
  installationId: string;
  provider: string;
  providerSubscriptionId: string;
  state: BillingTerminationState;
  attempt: number;
  nextAttemptAt: number;
  leaseNonce: string | null;
  leaseUntil: number | null;
  providerObservedAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type TerminationRow = {
  operation_id: string;
  deletion_operation_id: string;
  installation_id: string;
  provider: string;
  provider_subscription_id: string;
  state: BillingTerminationState;
  attempt: number;
  next_attempt_at: number;
  lease_nonce: string | null;
  lease_until: number | null;
  provider_observed_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

const TERMINATION_SELECT = `SELECT
  operation_id, deletion_operation_id, installation_id, provider,
  provider_subscription_id, state, attempt, next_attempt_at,
  lease_nonce, lease_until, provider_observed_at, last_error_code,
  created_at, updated_at, completed_at
FROM billing_termination_operations`;

export class BillingTerminationStore {
  constructor(private readonly db: D1Database) {}

  async claimDue(
    nowValue = Date.now(),
    limitValue = 10,
  ): Promise<Array<BillingTerminationOperation & {
    leaseNonce: string;
    leaseUntil: number;
  }>> {
    const now = timestamp(nowValue, "billing termination timestamp");
    const limit = batchLimit(limitValue);
    await this.completeAlreadyCancelled(now);
    const candidates = await this.db.prepare(
      `SELECT operation_id
       FROM billing_termination_operations
       WHERE next_attempt_at <= ?
         AND (
           state = 'requested'
           OR (state = 'processing' AND lease_until <= ?)
         )
       ORDER BY next_attempt_at, operation_id
       LIMIT ?`,
    ).bind(now, now, limit).all<{ operation_id: string }>();
    const claimed: Array<BillingTerminationOperation & {
      leaseNonce: string;
      leaseUntil: number;
    }> = [];
    for (const candidate of candidates.results) {
      const leaseNonce = crypto.randomUUID();
      const leaseUntil = now + LEASE_MS;
      const row = await this.db.prepare(
        `UPDATE billing_termination_operations
         SET state = 'processing', attempt = attempt + 1,
             lease_nonce = ?, lease_until = ?, last_error_code = NULL,
             updated_at = ?
         WHERE operation_id = ? AND next_attempt_at <= ?
           AND (
             state = 'requested'
             OR (state = 'processing' AND lease_until <= ?)
           )
         RETURNING
           operation_id, deletion_operation_id, installation_id, provider,
           provider_subscription_id, state, attempt, next_attempt_at,
           lease_nonce, lease_until, provider_observed_at, last_error_code,
           created_at, updated_at, completed_at`,
      ).bind(
        leaseNonce,
        leaseUntil,
        now,
        candidate.operation_id,
        now,
        now,
      ).first<TerminationRow>();
      if (!row) continue;
      const operation = fromRow(row);
      if (!operation.leaseNonce || operation.leaseUntil === null) {
        throw new Error("billing termination lease is invalid");
      }
      claimed.push({
        ...operation,
        leaseNonce: operation.leaseNonce,
        leaseUntil: operation.leaseUntil,
      });
    }
    return claimed;
  }

  async markComplete(input: {
    operationId: string;
    leaseNonce: string;
    providerObservedAt: number;
    now?: number;
  }): Promise<void> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const leaseNonce = parseOpaqueId(input.leaseNonce, "leaseNonce");
    const observedAt = timestamp(
      input.providerObservedAt,
      "provider observation timestamp",
    );
    const now = timestamp(input.now ?? Date.now(), "billing termination timestamp");
    await this.db.prepare(
      `UPDATE billing_termination_operations
       SET state = 'complete', provider_observed_at = ?,
           lease_nonce = NULL, lease_until = NULL, last_error_code = NULL,
           completed_at = ?, updated_at = ?
       WHERE operation_id = ? AND state = 'processing' AND lease_nonce = ?`,
    ).bind(observedAt, now, now, operationId, leaseNonce).run();
  }

  async markFailed(input: {
    operationId: string;
    leaseNonce: string;
    errorCode: string;
    retryAt: number;
    permanent: boolean;
    now?: number;
  }): Promise<void> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const leaseNonce = parseOpaqueId(input.leaseNonce, "leaseNonce");
    const errorCode = parseErrorCode(input.errorCode);
    const retryAt = timestamp(input.retryAt, "billing termination retry timestamp");
    const now = timestamp(input.now ?? Date.now(), "billing termination timestamp");
    await this.db.prepare(
      `UPDATE billing_termination_operations
       SET state = CASE WHEN ? THEN 'failed' ELSE 'requested' END,
           next_attempt_at = ?, lease_nonce = NULL, lease_until = NULL,
           last_error_code = ?, completed_at = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?
       WHERE operation_id = ? AND state = 'processing' AND lease_nonce = ?`,
    ).bind(
      input.permanent ? 1 : 0,
      retryAt,
      errorCode,
      input.permanent ? 1 : 0,
      now,
      now,
      operationId,
      leaseNonce,
    ).run();
  }

  async get(operationIdValue: string): Promise<BillingTerminationOperation | null> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const row = await this.db.prepare(
      `${TERMINATION_SELECT} WHERE operation_id = ? LIMIT 1`,
    ).bind(operationId).first<TerminationRow>();
    return row ? fromRow(row) : null;
  }

  async getForDeletion(
    deletionOperationIdValue: string,
  ): Promise<BillingTerminationOperation | null> {
    const deletionOperationId = parseOpaqueId(
      deletionOperationIdValue,
      "deletionOperationId",
    );
    const row = await this.db.prepare(
      `${TERMINATION_SELECT} WHERE deletion_operation_id = ? LIMIT 1`,
    ).bind(deletionOperationId).first<TerminationRow>();
    return row ? fromRow(row) : null;
  }

  private async completeAlreadyCancelled(now: number): Promise<void> {
    await this.db.prepare(
      `UPDATE billing_termination_operations
       SET state = 'complete', provider_observed_at = (
             SELECT s.provider_observed_at FROM subscriptions s
             WHERE s.installation_id = billing_termination_operations.installation_id
               AND s.provider_subscription_id =
                 billing_termination_operations.provider_subscription_id
           ),
           lease_nonce = NULL, lease_until = NULL, last_error_code = NULL,
           completed_at = ?, updated_at = ?
       WHERE state IN ('requested', 'processing')
         AND (state = 'requested' OR lease_until <= ?)
         AND EXISTS (
           SELECT 1 FROM subscriptions s
           JOIN billing_accounts b ON b.id = s.billing_account_id
           WHERE s.installation_id = billing_termination_operations.installation_id
             AND s.provider_subscription_id =
               billing_termination_operations.provider_subscription_id
             AND b.provider = billing_termination_operations.provider
             AND s.provider_state = 'cancelled'
         )`,
    ).bind(now, now, now).run();
  }
}

export class BillingTerminationService {
  constructor(
    private readonly store: BillingTerminationStore,
    private readonly provider: BillingCommerceProvider,
    private readonly reconciler: BillingReconciler,
  ) {}

  async advanceDue(
    now = Date.now(),
    limit = 10,
  ): Promise<{ claimed: number; completed: number; failed: number }> {
    const claimed = await this.store.claimDue(now, limit);
    let completed = 0;
    let failed = 0;
    for (const operation of claimed) {
      try {
        if (operation.provider !== this.provider.name) {
          throw new PermanentBillingTerminationError(
            "billing termination provider mismatch",
          );
        }
        const snapshot = parseSubscriptionSnapshot(
          await this.provider.cancelSubscription({
            operationId: operation.operationId,
            subscriptionId: operation.providerSubscriptionId,
          }),
          now,
        );
        if (
          snapshot.subscriptionId !== operation.providerSubscriptionId
          || snapshot.installationId !== operation.installationId
          || snapshot.state !== "cancelled"
        ) {
          throw new PermanentBillingTerminationError(
            "billing termination provider response mismatch",
          );
        }
        await this.reconciler.reconcile(operation.provider, snapshot, now);
        await this.store.markComplete({
          operationId: operation.operationId,
          leaseNonce: operation.leaseNonce,
          providerObservedAt: snapshot.observedAt,
          now,
        });
        completed += 1;
      } catch (error) {
        failed += 1;
        const permanent = error instanceof PermanentBillingTerminationError
          || operation.attempt >= MAX_ATTEMPTS;
        await this.store.markFailed({
          operationId: operation.operationId,
          leaseNonce: operation.leaseNonce,
          errorCode: terminationErrorCode(error),
          retryAt: now + retryDelay(operation.attempt),
          permanent,
          now,
        }).catch(() => undefined);
      }
    }
    return { claimed: claimed.length, completed, failed };
  }
}

class PermanentBillingTerminationError extends Error {}

function fromRow(row: TerminationRow): BillingTerminationOperation {
  return {
    operationId: row.operation_id,
    deletionOperationId: row.deletion_operation_id,
    installationId: row.installation_id,
    provider: row.provider,
    providerSubscriptionId: row.provider_subscription_id,
    state: row.state,
    attempt: row.attempt,
    nextAttemptAt: row.next_attempt_at,
    leaseNonce: row.lease_nonce,
    leaseUntil: row.lease_until,
    providerObservedAt: row.provider_observed_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function terminationErrorCode(error: unknown): string {
  if (error instanceof PermanentBillingTerminationError) {
    return error.message.includes("provider mismatch")
      ? "provider_mismatch"
      : "provider_response_invalid";
  }
  return "provider_unavailable";
}

function retryDelay(attempt: number): number {
  return Math.min(
    MAX_RETRY_MS,
    INITIAL_RETRY_MS * 2 ** Math.min(Math.max(0, attempt - 1), 20),
  );
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function batchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("billing termination batch limit is invalid");
  }
  return value;
}

function parseErrorCode(value: string): string {
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw new Error("billing termination error code is invalid");
  }
  return value;
}
