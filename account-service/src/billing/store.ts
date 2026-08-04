import type { ManagedEntitlementState } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import { sha256Hex } from "../security/tokens";
import {
  parseExternalId,
  parsePlanKey,
  parseProviderName,
  type BillingEntitlementTemplate,
  type BillingProviderSubscriptionState,
  type BillingSubscriptionSnapshot,
  type BillingSubscriptionState,
  type BillingWebhookEvent,
  type DerivedBillingLifecycle,
} from "./domain";

const EVENT_LEASE_MS = 30_000;
const CHECKOUT_RECONCILIATION_BUFFER_MS = 10 * 60_000;
const ABANDONED_CHECKOUT_MS = 40 * 60_000;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type BillingAccount = {
  id: string;
  principalId: string;
  provider: string;
  providerCustomerId: string;
  createdAt: number;
  updatedAt: number;
};

export type StoredBillingSubscription = {
  id: string;
  billingAccountId: string;
  principalId: string;
  provider: string;
  providerCustomerId: string;
  installationId: string;
  providerSubscriptionId: string;
  planKey: string;
  state: BillingSubscriptionState;
  providerState: BillingProviderSubscriptionState;
  providerObservedAt: number;
  providerSnapshotHash: string;
  currentPeriodStartsAt: number;
  currentPeriodEndsAt: number;
  cancelAtPeriodEnd: boolean;
  paidThrough: number | null;
  graceEndsAt: number | null;
  retentionEndsAt: number | null;
  entitlementVersion: number;
  entitlementEffectiveAt: number | null;
  entitlement: BillingEntitlementTemplate | null;
  lastReconciledAt: number;
  updatedAt: number;
};

export type BillingEventLease = {
  kind: "acquired";
  nonce: string;
  attempt: number;
} | {
  kind: "duplicate" | "in_progress";
};

export type BillingSessionOperation = {
  operationId: string;
  principalId: string;
  installationId: string;
  provider: string;
  kind: "checkout" | "portal";
  planKey: string | null;
  providerSessionId: string | null;
  providerSessionExpiresAt: number | null;
  state: "created" | "complete" | "failed" | "expired";
  attempt: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RetentionDeletionCandidate = {
  installationId: string;
  retentionEndsAt: number;
};

type BillingAccountRow = {
  id: string;
  principal_id: string;
  provider: string;
  provider_customer_id: string;
  created_at: number;
  updated_at: number | null;
};

type SubscriptionRow = {
  id: string;
  billing_account_id: string;
  principal_id: string;
  provider: string;
  provider_customer_id: string;
  installation_id: string;
  provider_subscription_id: string;
  price_key: string;
  state: string;
  provider_state: string;
  provider_observed_at: number;
  provider_snapshot_hash: string;
  current_period_starts_at: number;
  current_period_ends_at: number;
  cancel_at_period_end: number;
  paid_through: number | null;
  grace_ends_at: number | null;
  retention_ends_at: number | null;
  entitlement_version: number;
  entitlement_effective_at: number | null;
  entitlement_json: string | null;
  last_reconciled_at: number;
  updated_at: number;
};

type BillingEventRow = {
  body_hash: string;
  event_created_at: number;
  subject_kind: string;
  subject_id: string | null;
  state: string;
};

type BillingSessionOperationRow = {
  operation_id: string;
  principal_id: string;
  installation_id: string;
  provider: string;
  kind: string;
  plan_key: string | null;
  provider_session_id: string | null;
  provider_session_expires_at: number | null;
  state: string;
  attempt: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
};

export class BillingStore {
  constructor(private readonly db: D1Database) {}

  async registerBillingAccount(input: {
    principalId: string;
    provider: string;
    providerCustomerId: string;
    now?: number;
  }): Promise<BillingAccount> {
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const provider = parseProviderName(input.provider);
    const providerCustomerId = parseExternalId(
      input.providerCustomerId,
      "provider customer ID",
    );
    const now = timestamp(input.now ?? Date.now(), "billing account timestamp");
    const id = `billing_${await sha256Hex(
      `gsv-billing-account:${provider}:${providerCustomerId}`,
    )}`;
    await this.db.prepare(
      `INSERT OR IGNORE INTO billing_accounts (
         id, principal_id, provider, provider_customer_id, created_at, updated_at
       )
       SELECT ?, id, ?, ?, ?, ?
       FROM principals
       WHERE id = ? AND state IN ('active', 'recovery')`,
    ).bind(
      id,
      provider,
      providerCustomerId,
      now,
      now,
      principalId,
    ).run();
    const account = await this.findBillingAccountForPrincipal(
      principalId,
      provider,
    );
    if (!account) throw new Error("billing principal is unavailable");
    if (account.providerCustomerId !== providerCustomerId) {
      throw new Error("billing principal already has a different provider customer");
    }
    return account;
  }

  async findBillingAccountForPrincipal(
    principalIdValue: string,
    providerValue: string,
  ): Promise<BillingAccount | null> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const provider = parseProviderName(providerValue);
    const row = await this.db.prepare(
      `SELECT id, principal_id, provider, provider_customer_id, created_at, updated_at
       FROM billing_accounts
       WHERE principal_id = ? AND provider = ?
       LIMIT 1`,
    ).bind(principalId, provider).first<BillingAccountRow>();
    return row ? billingAccountFromRow(row) : null;
  }

  async requireBillingAccountByCustomer(
    providerValue: string,
    providerCustomerIdValue: string,
  ): Promise<BillingAccount> {
    const provider = parseProviderName(providerValue);
    const providerCustomerId = parseExternalId(
      providerCustomerIdValue,
      "provider customer ID",
    );
    const row = await this.db.prepare(
      `SELECT id, principal_id, provider, provider_customer_id, created_at, updated_at
       FROM billing_accounts
       WHERE provider = ? AND provider_customer_id = ?
       LIMIT 1`,
    ).bind(provider, providerCustomerId).first<BillingAccountRow>();
    if (!row) throw new Error("billing provider customer is unavailable");
    return billingAccountFromRow(row);
  }

  async getSubscriptionByInstallation(
    installationIdValue: string,
  ): Promise<StoredBillingSubscription | null> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const row = await this.subscriptionQuery(
      "s.installation_id = ?",
      installationId,
    );
    return row ? subscriptionFromRow(row) : null;
  }

  async getSubscriptionByProviderId(
    providerValue: string,
    providerSubscriptionIdValue: string,
  ): Promise<StoredBillingSubscription | null> {
    const provider = parseProviderName(providerValue);
    const providerSubscriptionId = parseExternalId(
      providerSubscriptionIdValue,
      "provider subscription ID",
    );
    const row = await this.subscriptionQuery(
      "b.provider = ? AND s.provider_subscription_id = ?",
      provider,
      providerSubscriptionId,
    );
    return row ? subscriptionFromRow(row) : null;
  }

  async reconcileSubscription(input: {
    account: BillingAccount;
    snapshot: BillingSubscriptionSnapshot;
    snapshotHash: string;
    lifecycle: DerivedBillingLifecycle;
    now?: number;
  }): Promise<StoredBillingSubscription> {
    const account = input.account;
    const snapshot = input.snapshot;
    const now = timestamp(input.now ?? Date.now(), "reconciliation timestamp");
    if (!/^[0-9a-f]{64}$/.test(input.snapshotHash)) {
      throw new Error("provider snapshot hash is invalid");
    }
    if (account.providerCustomerId !== snapshot.customerId) {
      throw new Error("provider subscription customer is mismatched");
    }
    const entitlementJson = input.lifecycle.entitlement
      ? JSON.stringify(input.lifecycle.entitlement)
      : null;
    const id = `subscription_${await sha256Hex(
      `gsv-subscription:${account.provider}:${snapshot.subscriptionId}`,
    )}`;
    const row = await this.db.prepare(
      `INSERT INTO subscriptions (
         id, billing_account_id, installation_id, provider_subscription_id,
         price_key, state, provider_state, provider_observed_at,
         provider_snapshot_hash, current_period_starts_at,
         current_period_ends_at, cancel_at_period_end, paid_through,
         grace_ends_at, retention_ends_at, entitlement_version,
         entitlement_effective_at, entitlement_json, last_reconciled_at, updated_at
       )
       SELECT ?, ?, i.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
              CASE WHEN ? IS NULL THEN NULL ELSE ? END,
              ?, ?, ?
       FROM installations i
       WHERE i.id = ?
         AND i.owner_principal_id = ?
         AND i.state NOT IN ('deleting', 'deleted')
       ON CONFLICT(installation_id) DO UPDATE SET
         price_key = excluded.price_key,
         state = excluded.state,
         provider_state = excluded.provider_state,
         provider_observed_at = excluded.provider_observed_at,
         provider_snapshot_hash = excluded.provider_snapshot_hash,
         current_period_starts_at = excluded.current_period_starts_at,
         current_period_ends_at = excluded.current_period_ends_at,
         cancel_at_period_end = excluded.cancel_at_period_end,
         paid_through = excluded.paid_through,
         grace_ends_at = excluded.grace_ends_at,
         retention_ends_at = excluded.retention_ends_at,
         entitlement_version = CASE
           WHEN subscriptions.entitlement_json IS excluded.entitlement_json
             THEN subscriptions.entitlement_version
           ELSE subscriptions.entitlement_version + 1
         END,
         entitlement_effective_at = CASE
           WHEN subscriptions.entitlement_json IS excluded.entitlement_json
             THEN subscriptions.entitlement_effective_at
           WHEN excluded.entitlement_json IS NULL THEN NULL
           ELSE excluded.last_reconciled_at
         END,
         entitlement_json = excluded.entitlement_json,
         last_reconciled_at = excluded.last_reconciled_at,
         updated_at = excluded.updated_at
       WHERE subscriptions.billing_account_id = excluded.billing_account_id
         AND subscriptions.provider_subscription_id = excluded.provider_subscription_id
         AND (
           excluded.provider_observed_at > subscriptions.provider_observed_at
           OR (
             excluded.provider_observed_at = subscriptions.provider_observed_at
             AND excluded.provider_snapshot_hash = subscriptions.provider_snapshot_hash
           )
         )
       RETURNING id`,
    ).bind(
      id,
      account.id,
      snapshot.subscriptionId,
      snapshot.planKey,
      input.lifecycle.state,
      snapshot.state,
      snapshot.observedAt,
      input.snapshotHash,
      snapshot.currentPeriodStartsAt,
      snapshot.currentPeriodEndsAt,
      snapshot.cancelAtPeriodEnd ? 1 : 0,
      input.lifecycle.paidThrough,
      input.lifecycle.graceEndsAt,
      input.lifecycle.retentionEndsAt,
      entitlementJson,
      entitlementJson,
      now,
      entitlementJson,
      now,
      now,
      snapshot.installationId,
      account.principalId,
    ).first<{ id: string }>();

    const stored = await this.getSubscriptionByInstallation(
      snapshot.installationId,
    );
    if (!stored) throw new Error("billing installation is unavailable");
    if (
      stored.billingAccountId !== account.id
      || stored.providerSubscriptionId !== snapshot.subscriptionId
    ) {
      throw new Error("installation already has a different subscription");
    }
    if (!row && stored.providerObservedAt <= snapshot.observedAt) {
      throw new Error("provider subscription snapshot conflicts with current state");
    }
    return stored;
  }

  async listLifecycleDue(nowValue = Date.now()): Promise<StoredBillingSubscription[]> {
    const now = timestamp(nowValue, "lifecycle timestamp");
    const rows = await this.db.prepare(
      `${SUBSCRIPTION_SELECT}
       WHERE (s.state = 'past_due' AND s.grace_ends_at <= ?)
          OR (s.state = 'cancelled' AND s.paid_through <= ?)
       ORDER BY s.updated_at ASC
       LIMIT 100`,
    ).bind(now, now).all<SubscriptionRow>();
    return rows.results.map(subscriptionFromRow);
  }

  async listRetentionDeletionDue(
    nowValue = Date.now(),
    limitValue = 100,
  ): Promise<RetentionDeletionCandidate[]> {
    const now = timestamp(nowValue, "retention timestamp");
    const limit = listLimit(limitValue);
    const rows = await this.db.prepare(
      `SELECT s.installation_id, s.retention_ends_at
       FROM subscriptions s
       JOIN installations i ON i.id = s.installation_id
       WHERE s.state = 'retained'
         AND s.retention_ends_at IS NOT NULL
         AND s.retention_ends_at <= ?
         AND i.state = 'retained'
         AND 3 = (
           SELECT COUNT(DISTINCT n.kind)
           FROM lifecycle_notification_outbox n
           WHERE n.source_id = s.id
             AND n.lifecycle_key = CAST(s.retention_ends_at AS TEXT)
             AND n.kind IN (
               'retention_started', 'retention_7_days', 'retention_1_day'
             )
             AND n.state IN ('sent', 'permanent_failure')
         )
       ORDER BY s.retention_ends_at, s.installation_id
       LIMIT ?`,
    ).bind(now, limit).all<{
      installation_id: string;
      retention_ends_at: number;
    }>();
    return rows.results.map((row) => ({
      installationId: row.installation_id,
      retentionEndsAt: row.retention_ends_at,
    }));
  }

  async beginSessionOperation(input: {
    operationId: string;
    principalId: string;
    installationId: string;
    provider: string;
    kind: "checkout" | "portal";
    planKey?: string;
    now?: number;
  }): Promise<BillingSessionOperation> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const installationId = parseOpaqueId(
      input.installationId,
      "installationId",
    );
    const provider = parseProviderName(input.provider);
    const planKey = input.kind === "checkout"
      ? parsePlanKey(input.planKey)
      : null;
    if (input.kind === "portal" && input.planKey !== undefined) {
      throw new Error("portal operation cannot select a billing plan");
    }
    const now = timestamp(input.now ?? Date.now(), "billing operation timestamp");
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO billing_session_operations (
         operation_id, principal_id, installation_id, provider, kind,
         plan_key, provider_session_id, provider_session_expires_at, state,
         attempt, last_error_code, created_at, updated_at
       )
       SELECT ?, ?, id, ?, ?, ?, NULL, NULL, 'created', 0, NULL, ?, ?
       FROM installations
       WHERE id = ? AND owner_principal_id = ?
         AND state NOT IN ('deleting', 'deleted')`,
    ).bind(
      operationId,
      principalId,
      provider,
      input.kind,
      planKey,
      now,
      now,
      installationId,
      principalId,
    );
    if (input.kind === "checkout") {
      await this.db.batch([
        this.db.prepare(
          `UPDATE billing_session_operations
           SET state = 'expired', last_error_code = 'checkout_expired',
               updated_at = ?
           WHERE installation_id = ? AND kind = 'checkout'
             AND state = 'complete'
             AND provider_session_expires_at <= ?`,
        ).bind(
          now,
          installationId,
          now - CHECKOUT_RECONCILIATION_BUFFER_MS,
        ),
        this.db.prepare(
          `UPDATE billing_session_operations
           SET state = 'failed', last_error_code = 'checkout_abandoned',
               updated_at = ?
           WHERE installation_id = ? AND kind = 'checkout'
             AND state = 'created' AND updated_at <= ?`,
        ).bind(now, installationId, now - ABANDONED_CHECKOUT_MS),
        insert,
      ]);
    } else {
      await insert.run();
    }
    const operation = await this.getSessionOperation(operationId);
    if (!operation) {
      if (
        input.kind === "checkout"
        && await this.getActiveCheckoutOperation(installationId)
      ) {
        throw new Error("billing checkout is already in progress");
      }
      throw new Error("billing installation is unavailable");
    }
    if (
      operation.principalId !== principalId
      || operation.installationId !== installationId
      || operation.provider !== provider
      || operation.kind !== input.kind
      || operation.planKey !== planKey
    ) {
      throw new Error("billing idempotency key conflicts with an earlier request");
    }
    if (operation.state === "expired") {
      throw new Error("billing checkout session expired");
    }
    try {
      await this.db.prepare(
        `UPDATE billing_session_operations
         SET state = CASE WHEN state = 'failed' THEN 'created' ELSE state END,
             attempt = attempt + 1, updated_at = ?, last_error_code = NULL
         WHERE operation_id = ?`,
      ).bind(now, operationId).run();
    } catch (error) {
      if (input.kind === "checkout") {
        const active = await this.getActiveCheckoutOperation(installationId)
          .catch(() => null);
        if (active && active.operationId !== operationId) {
          throw new Error("billing checkout is already in progress");
        }
      }
      throw error;
    }
    return (await this.getSessionOperation(operationId))!;
  }

  async completeSessionOperation(input: {
    operationId: string;
    providerSessionId: string;
    providerSessionExpiresAt?: number;
    now?: number;
  }): Promise<BillingSessionOperation> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const providerSessionId = parseExternalId(
      input.providerSessionId,
      "provider session ID",
    );
    const operation = await this.getSessionOperation(operationId);
    if (!operation) throw new Error("billing operation is unavailable");
    const providerSessionExpiresAt = input.providerSessionExpiresAt === undefined
      ? null
      : timestamp(input.providerSessionExpiresAt, "billing session expiry");
    if (
      operation.kind === "checkout"
      && providerSessionExpiresAt === null
    ) {
      throw new Error("billing checkout session expiry is required");
    }
    if (operation.kind === "portal" && providerSessionExpiresAt !== null) {
      throw new Error("billing portal session cannot have an expiry");
    }
    await this.db.prepare(
      `UPDATE billing_session_operations
       SET provider_session_id = ?, provider_session_expires_at = ?,
           state = 'complete',
           last_error_code = NULL, updated_at = ?
       WHERE operation_id = ?
         AND (provider_session_id IS NULL OR provider_session_id = ?)
         AND (
           provider_session_expires_at IS NULL
           OR provider_session_expires_at = ?
         )`,
    ).bind(
      providerSessionId,
      providerSessionExpiresAt,
      timestamp(input.now ?? Date.now(), "billing operation timestamp"),
      operationId,
      providerSessionId,
      providerSessionExpiresAt,
    ).run();
    const completed = await this.getSessionOperation(operationId);
    if (
      !completed
      || completed.providerSessionId !== providerSessionId
      || completed.providerSessionExpiresAt !== providerSessionExpiresAt
    ) {
      throw new Error("billing provider session conflicts with an earlier response");
    }
    return completed;
  }

  async failSessionOperation(input: {
    operationId: string;
    errorCode: string;
    now?: number;
  }): Promise<void> {
    if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
      throw new Error("billing operation error code is invalid");
    }
    await this.db.prepare(
      `UPDATE billing_session_operations
       SET state = CASE WHEN provider_session_id IS NULL THEN 'failed' ELSE state END,
           last_error_code = ?, updated_at = ?
       WHERE operation_id = ?`,
    ).bind(
      input.errorCode,
      timestamp(input.now ?? Date.now(), "billing operation timestamp"),
      parseOpaqueId(input.operationId, "operationId"),
    ).run();
  }

  async beginEvent(input: {
    provider: string;
    event: BillingWebhookEvent;
    bodyHash: string;
    now?: number;
  }): Promise<BillingEventLease> {
    const provider = parseProviderName(input.provider);
    const eventId = parseExternalId(input.event.eventId, "provider event ID");
    if (!/^[0-9a-f]{64}$/.test(input.bodyHash)) {
      throw new Error("billing event body hash is invalid");
    }
    const now = timestamp(input.now ?? Date.now(), "billing event timestamp");
    const subjectKind = input.event.subject.kind;
    const subjectId = subjectKind === "subscription"
      ? parseExternalId(input.event.subject.id, "provider subscription ID")
      : null;
    await this.db.prepare(
      `INSERT OR IGNORE INTO billing_events (
         provider, provider_event_id, body_hash, event_created_at,
         subject_kind, subject_id, state, attempt, lease_nonce, lease_until,
         received_at, processed_at, outcome, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'received', 0, NULL, NULL, ?, NULL, NULL, NULL)`,
    ).bind(
      provider,
      eventId,
      input.bodyHash,
      input.event.createdAt,
      subjectKind,
      subjectId,
      now,
    ).run();
    const existing = await this.db.prepare(
      `SELECT body_hash, event_created_at, subject_kind, subject_id, state
       FROM billing_events
       WHERE provider = ? AND provider_event_id = ?`,
    ).bind(provider, eventId).first<BillingEventRow>();
    if (!existing) throw new Error("billing event was not recorded");
    if (
      existing.body_hash !== input.bodyHash
      || existing.event_created_at !== input.event.createdAt
      || existing.subject_kind !== subjectKind
      || existing.subject_id !== subjectId
    ) {
      throw new Error("provider event ID was reused with different content");
    }
    if (existing.state === "processed") return { kind: "duplicate" };

    const nonce = crypto.randomUUID();
    const lease = await this.db.prepare(
      `UPDATE billing_events
       SET state = 'processing', attempt = attempt + 1,
           lease_nonce = ?, lease_until = ?, last_error_code = NULL
       WHERE provider = ? AND provider_event_id = ?
         AND state != 'processed'
         AND (state != 'processing' OR lease_until <= ?)
       RETURNING attempt`,
    ).bind(
      nonce,
      now + EVENT_LEASE_MS,
      provider,
      eventId,
      now,
    ).first<{ attempt: number }>();
    return lease
      ? { kind: "acquired", nonce, attempt: lease.attempt }
      : { kind: "in_progress" };
  }

  async completeEvent(input: {
    provider: string;
    eventId: string;
    leaseNonce: string;
    outcome: "reconciled" | "ignored";
    now?: number;
  }): Promise<void> {
    const result = await this.db.prepare(
      `UPDATE billing_events
       SET state = 'processed', processed_at = ?, outcome = ?,
           lease_nonce = NULL, lease_until = NULL, last_error_code = NULL
       WHERE provider = ? AND provider_event_id = ?
         AND state = 'processing' AND lease_nonce = ?`,
    ).bind(
      timestamp(input.now ?? Date.now(), "billing event completion timestamp"),
      input.outcome,
      parseProviderName(input.provider),
      parseExternalId(input.eventId, "provider event ID"),
      parseOpaqueId(input.leaseNonce, "billing event lease"),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error("billing event lease is unavailable");
    }
  }

  async failEvent(input: {
    provider: string;
    eventId: string;
    leaseNonce: string;
    errorCode: string;
  }): Promise<void> {
    if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
      throw new Error("billing event error code is invalid");
    }
    await this.db.prepare(
      `UPDATE billing_events
       SET state = 'failed', lease_nonce = NULL, lease_until = NULL,
           last_error_code = ?
       WHERE provider = ? AND provider_event_id = ?
         AND state = 'processing' AND lease_nonce = ?`,
    ).bind(
      input.errorCode,
      parseProviderName(input.provider),
      parseExternalId(input.eventId, "provider event ID"),
      parseOpaqueId(input.leaseNonce, "billing event lease"),
    ).run();
  }

  private async subscriptionQuery(
    where: string,
    ...bindings: unknown[]
  ): Promise<SubscriptionRow | null> {
    return await this.db.prepare(
      `${SUBSCRIPTION_SELECT} WHERE ${where} LIMIT 1`,
    ).bind(...bindings).first<SubscriptionRow>();
  }

  private async getSessionOperation(
    operationId: string,
  ): Promise<BillingSessionOperation | null> {
    const row = await this.db.prepare(
      `SELECT operation_id, principal_id, installation_id, provider, kind,
              plan_key, provider_session_id, provider_session_expires_at,
              state, attempt, last_error_code, created_at, updated_at
       FROM billing_session_operations
       WHERE operation_id = ?
       LIMIT 1`,
    ).bind(operationId).first<BillingSessionOperationRow>();
    return row ? sessionOperationFromRow(row) : null;
  }

  private async getActiveCheckoutOperation(
    installationId: string,
  ): Promise<BillingSessionOperation | null> {
    const row = await this.db.prepare(
      `SELECT operation_id, principal_id, installation_id, provider, kind,
              plan_key, provider_session_id, provider_session_expires_at,
              state, attempt, last_error_code, created_at, updated_at
       FROM billing_session_operations
       WHERE installation_id = ? AND kind = 'checkout'
         AND state IN ('created', 'complete')
       LIMIT 1`,
    ).bind(installationId).first<BillingSessionOperationRow>();
    return row ? sessionOperationFromRow(row) : null;
  }
}

const SUBSCRIPTION_SELECT = `SELECT
  s.id, s.billing_account_id, b.principal_id, b.provider,
  b.provider_customer_id, s.installation_id, s.provider_subscription_id,
  s.price_key, s.state, s.provider_state, s.provider_observed_at,
  s.provider_snapshot_hash, s.current_period_starts_at,
  s.current_period_ends_at, s.cancel_at_period_end, s.paid_through,
  s.grace_ends_at, s.retention_ends_at, s.entitlement_version,
  s.entitlement_effective_at, s.entitlement_json,
  s.last_reconciled_at, s.updated_at
FROM subscriptions s
JOIN billing_accounts b ON b.id = s.billing_account_id`;

function billingAccountFromRow(row: BillingAccountRow): BillingAccount {
  return {
    id: row.id,
    principalId: row.principal_id,
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function subscriptionFromRow(row: SubscriptionRow): StoredBillingSubscription {
  if (!isSubscriptionState(row.state) || !isProviderState(row.provider_state)) {
    throw new Error("stored billing subscription state is invalid");
  }
  const entitlement = row.entitlement_json === null
    ? null
    : parseEntitlementJson(row.entitlement_json);
  if (
    (entitlement === null) !== (row.entitlement_effective_at === null)
    || (entitlement === null && row.entitlement_version !== 0)
    || (entitlement !== null && row.entitlement_version < 1)
  ) {
    throw new Error("stored billing entitlement is invalid");
  }
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    principalId: row.principal_id,
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    installationId: row.installation_id,
    providerSubscriptionId: row.provider_subscription_id,
    planKey: row.price_key,
    state: row.state,
    providerState: row.provider_state,
    providerObservedAt: row.provider_observed_at,
    providerSnapshotHash: row.provider_snapshot_hash,
    currentPeriodStartsAt: row.current_period_starts_at,
    currentPeriodEndsAt: row.current_period_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    paidThrough: row.paid_through,
    graceEndsAt: row.grace_ends_at,
    retentionEndsAt: row.retention_ends_at,
    entitlementVersion: row.entitlement_version,
    entitlementEffectiveAt: row.entitlement_effective_at,
    entitlement,
    lastReconciledAt: row.last_reconciled_at,
    updatedAt: row.updated_at,
  };
}

function parseEntitlementJson(value: string): BillingEntitlementTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("stored billing entitlement is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored billing entitlement is invalid");
  }
  const input = parsed as Record<string, unknown>;
  if (!isEntitlementState(input.state)) {
    throw new Error("stored billing entitlement state is invalid");
  }
  return {
    state: input.state,
    planKey: parsePlanKey(input.planKey),
    inferenceBudgetMicrounits: nonNegativeInteger(
      input.inferenceBudgetMicrounits,
      "stored inference budget",
    ),
    inferencePeriodStartsAt: nonNegativeInteger(
      input.inferencePeriodStartsAt,
      "stored inference period start",
    ),
    inferencePeriodEndsAt: nonNegativeInteger(
      input.inferencePeriodEndsAt,
      "stored inference period end",
    ),
    storageLimitBytes: nonNegativeInteger(
      input.storageLimitBytes,
      "stored storage limit",
    ),
  };
}

function sessionOperationFromRow(
  row: BillingSessionOperationRow,
): BillingSessionOperation {
  if (
    (row.kind !== "checkout" && row.kind !== "portal")
    || (
      row.state !== "created"
      && row.state !== "complete"
      && row.state !== "failed"
      && row.state !== "expired"
    )
    || (row.kind === "checkout") !== (row.plan_key !== null)
    || (row.state === "complete" || row.state === "expired")
      !== (row.provider_session_id !== null)
    || (row.provider_session_expires_at !== null && row.provider_session_id === null)
    || (
      row.kind === "checkout"
      && (row.state === "complete" || row.state === "expired")
      && row.provider_session_expires_at === null
    )
  ) {
    throw new Error("stored billing session operation is invalid");
  }
  return {
    operationId: row.operation_id,
    principalId: row.principal_id,
    installationId: row.installation_id,
    provider: row.provider,
    kind: row.kind,
    planKey: row.plan_key,
    providerSessionId: row.provider_session_id,
    providerSessionExpiresAt: row.provider_session_expires_at,
    state: row.state,
    attempt: row.attempt,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function listLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("billing list limit is invalid");
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value as number;
}

function isSubscriptionState(value: unknown): value is BillingSubscriptionState {
  return isProviderState(value) || value === "restricted" || value === "retained";
}

function isProviderState(value: unknown): value is BillingProviderSubscriptionState {
  return value === "pending"
    || value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "cancelled";
}

function isEntitlementState(value: unknown): value is ManagedEntitlementState {
  return value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "restricted"
    || value === "cancelled"
    || value === "retained";
}
