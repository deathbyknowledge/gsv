import type { ManagedInstallationState } from "@humansandmachines/gsv/protocol";
import { parseHandle, parseOpaqueId } from "../domain";

export type InstallationDeletionState =
  | "preparing"
  | "recoverable"
  | "deleting"
  | "complete"
  | "recovered";

export type InstallationDeletionOperation = {
  operationId: string;
  installationId: string;
  requestedByPrincipalId: string | null;
  requestKind: "user" | "retention";
  previousState: Exclude<
    ManagedInstallationState,
    "reserved" | "provisioning" | "deleting" | "deleted"
  >;
  state: InstallationDeletionState;
  recoverableUntil: number;
  gatewayPrepared: boolean;
  inferenceSuspended: boolean;
  telegramSuspended: boolean;
  gatewayDeleted: boolean;
  inferenceDeleted: boolean;
  telegramDeleted: boolean;
  attempt: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type DeletionRow = {
  operation_id: string;
  installation_id: string;
  requested_by_principal_id: string | null;
  request_kind: "user" | "retention";
  previous_state: InstallationDeletionOperation["previousState"];
  state: InstallationDeletionState;
  recoverable_until: number;
  gateway_prepared: number;
  inference_suspended: number;
  telegram_suspended: number;
  gateway_deleted: number;
  inference_deleted: number;
  telegram_deleted: number;
  attempt: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

const DELETION_SELECT = `SELECT
  operation_id, installation_id, requested_by_principal_id, request_kind,
  previous_state, state, recoverable_until, gateway_prepared,
  inference_suspended, telegram_suspended, gateway_deleted,
  inference_deleted, telegram_deleted, attempt, last_error_code,
  created_at, updated_at, completed_at
FROM installation_deletion_operations`;

export class InstallationLifecycleStore {
  constructor(private readonly db: D1Database) {}

  async beginUserDeletion(input: {
    operationId: string;
    principalId: string;
    installationId: string;
    confirmedHandle: string;
    recoverableUntil: number;
    now?: number;
  }): Promise<InstallationDeletionOperation> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const confirmedHandle = parseHandle(input.confirmedHandle);
    const now = timestamp(input.now ?? Date.now(), "deletion timestamp");
    const recoverableUntil = timestamp(
      input.recoverableUntil,
      "deletion recovery deadline",
    );
    if (recoverableUntil <= now) {
      throw new Error("deletion recovery deadline is invalid");
    }
    const replay = await this.get(operationId);
    if (replay) {
      assertUserDeletionReplay(replay, {
        principalId,
        installationId,
        recoverableUntil,
      });
      return replay;
    }
    if (await this.getActiveForInstallation(installationId)) {
      throw new Error("installation deletion is already in progress");
    }

    const installation = await this.db.prepare(
      `SELECT handle, state
       FROM installations
       WHERE id = ? AND owner_principal_id = ?
       LIMIT 1`,
    ).bind(installationId, principalId).first<{
      handle: string;
      state: ManagedInstallationState;
    }>();
    if (!installation || !isDeletableState(installation.state)) {
      throw new Error("installation is unavailable");
    }
    if (installation.handle !== confirmedHandle) {
      throw new Error("installation handle confirmation does not match");
    }

    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO installation_deletion_operations (
             operation_id, installation_id, requested_by_principal_id,
             request_kind, previous_state, state, recoverable_until,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'user', ?, 'preparing', ?, ?, ?)`,
        ).bind(
          operationId,
          installationId,
          principalId,
          installation.state,
          recoverableUntil,
          now,
          now,
        ),
        this.db.prepare(
          `UPDATE installations
           SET state = 'deleting'
           WHERE id = ? AND owner_principal_id = ? AND state = ?`,
        ).bind(installationId, principalId, installation.state),
        this.db.prepare(
          `INSERT INTO billing_termination_operations (
             operation_id, deletion_operation_id, installation_id,
             provider, provider_subscription_id, state, next_attempt_at,
             created_at, updated_at
           )
           SELECT 'billing_termination_' || ?, ?, s.installation_id,
                  b.provider, s.provider_subscription_id, 'requested', ?, ?, ?
           FROM subscriptions s
           JOIN billing_accounts b ON b.id = s.billing_account_id
           WHERE s.installation_id = ? AND s.provider_state != 'cancelled'`,
        ).bind(operationId, operationId, now, now, now, installationId),
        this.db.prepare(
          `UPDATE hostnames
           SET state = 'retired', retired_at = COALESCE(retired_at, ?)
           WHERE installation_id = ? AND state != 'retired'`,
        ).bind(now, installationId),
        this.db.prepare(
          "DELETE FROM login_handoffs WHERE installation_id = ?",
        ).bind(installationId),
        this.db.prepare(
          `INSERT INTO audit_events (
             id, principal_id, installation_id, action, outcome,
             created_at, metadata_json
           ) VALUES (?, ?, ?, 'installation.deletion_requested',
                     'succeeded', ?, '{}')`,
        ).bind(`audit_${crypto.randomUUID()}`, principalId, installationId, now),
      ]);
    } catch (error) {
      const existing = await this.get(operationId)
        ?? await this.getActiveForInstallation(installationId);
      if (existing) {
        if (existing.operationId !== operationId) {
          throw new Error("installation deletion is already in progress");
        }
        assertUserDeletionReplay(existing, {
          principalId,
          installationId,
          recoverableUntil,
        });
        return existing;
      }
      throw error;
    }
    return await this.require(operationId);
  }

  async beginRetentionDeletion(input: {
    operationId: string;
    installationId: string;
    now?: number;
  }): Promise<InstallationDeletionOperation> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const now = timestamp(input.now ?? Date.now(), "deletion timestamp");
    const replay = await this.get(operationId);
    if (replay) return replay;
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO installation_deletion_operations (
           operation_id, installation_id, requested_by_principal_id,
           request_kind, previous_state, state, recoverable_until,
           gateway_prepared, inference_suspended, telegram_suspended,
           created_at, updated_at
         )
         SELECT ?, id, NULL, 'retention', 'retained', 'deleting', ?,
                1, 1, 1, ?, ?
         FROM installations
         WHERE id = ? AND state = 'retained'`,
      ).bind(operationId, now, now, now, installationId),
      this.db.prepare(
        `UPDATE installations
         SET state = 'deleting'
         WHERE id = ? AND state = 'retained'`,
      ).bind(installationId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'retired', retired_at = COALESCE(retired_at, ?)
         WHERE installation_id = ? AND state != 'retired'`,
      ).bind(now, installationId),
    ]);
    const operation = await this.get(operationId);
    if (!operation) throw new Error("retained installation is unavailable");
    return operation;
  }

  async get(operationIdValue: string): Promise<InstallationDeletionOperation | null> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const row = await this.db.prepare(
      `${DELETION_SELECT} WHERE operation_id = ? LIMIT 1`,
    ).bind(operationId).first<DeletionRow>();
    return row ? fromRow(row) : null;
  }

  async getActiveForInstallation(
    installationIdValue: string,
  ): Promise<InstallationDeletionOperation | null> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const row = await this.db.prepare(
      `${DELETION_SELECT}
       WHERE installation_id = ? AND state IN ('preparing', 'recoverable', 'deleting')
       LIMIT 1`,
    ).bind(installationId).first<DeletionRow>();
    return row ? fromRow(row) : null;
  }

  async listActionable(
    nowValue = Date.now(),
    limitValue = 25,
  ): Promise<InstallationDeletionOperation[]> {
    const now = timestamp(nowValue, "lifecycle timestamp");
    const limit = batchLimit(limitValue);
    const rows = await this.db.prepare(
      `${DELETION_SELECT}
       WHERE state = 'preparing'
          OR state = 'deleting'
          OR (state = 'recoverable' AND recoverable_until <= ?)
       ORDER BY updated_at, operation_id
       LIMIT ?`,
    ).bind(now, limit).all<DeletionRow>();
    return rows.results.map(fromRow);
  }

  async recordAttempt(operationIdValue: string, now = Date.now()): Promise<void> {
    await this.db.prepare(
      `UPDATE installation_deletion_operations
       SET attempt = attempt + 1, last_error_code = NULL, updated_at = ?
       WHERE operation_id = ? AND state IN ('preparing', 'recoverable', 'deleting')`,
    ).bind(
      timestamp(now, "lifecycle timestamp"),
      parseOpaqueId(operationIdValue, "operationId"),
    ).run();
  }

  async markPreparationComponent(
    operationIdValue: string,
    component: "gateway" | "inference" | "telegram",
    now = Date.now(),
  ): Promise<InstallationDeletionOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const column = component === "gateway"
      ? "gateway_prepared"
      : component === "inference"
        ? "inference_suspended"
        : "telegram_suspended";
    const at = timestamp(now, "lifecycle timestamp");
    await this.db.batch([
      this.db.prepare(
        `UPDATE installation_deletion_operations
         SET ${column} = 1, last_error_code = NULL, updated_at = ?
         WHERE operation_id = ? AND state IN ('preparing', 'recoverable')`,
      ).bind(at, operationId),
      this.db.prepare(
        `UPDATE installation_deletion_operations
         SET state = 'recoverable', updated_at = ?
         WHERE operation_id = ? AND state = 'preparing'
           AND gateway_prepared = 1
           AND inference_suspended = 1
           AND telegram_suspended = 1`,
      ).bind(at, operationId),
    ]);
    return await this.require(operationId);
  }

  async advanceDue(operationIdValue: string, nowValue = Date.now()): Promise<void> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const now = timestamp(nowValue, "lifecycle timestamp");
    await this.db.prepare(
      `UPDATE installation_deletion_operations
       SET state = 'deleting', updated_at = ?
       WHERE operation_id = ? AND state IN ('preparing', 'recoverable')
         AND recoverable_until <= ?`,
    ).bind(now, operationId, now).run();
  }

  async markDeletionComponent(
    operationIdValue: string,
    component: "gateway" | "inference" | "telegram",
    now = Date.now(),
  ): Promise<InstallationDeletionOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const column = component === "gateway"
      ? "gateway_deleted"
      : component === "inference"
        ? "inference_deleted"
        : "telegram_deleted";
    await this.db.prepare(
      `UPDATE installation_deletion_operations
       SET ${column} = 1, last_error_code = NULL, updated_at = ?
       WHERE operation_id = ? AND state = 'deleting'`,
    ).bind(timestamp(now, "lifecycle timestamp"), operationId).run();
    return await this.require(operationId);
  }

  async recordFailure(
    operationIdValue: string,
    errorCode: string,
    now = Date.now(),
  ): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)) {
      throw new Error("lifecycle error code is invalid");
    }
    await this.db.prepare(
      `UPDATE installation_deletion_operations
       SET last_error_code = ?, updated_at = ?
       WHERE operation_id = ? AND state IN ('preparing', 'recoverable', 'deleting')`,
    ).bind(
      errorCode,
      timestamp(now, "lifecycle timestamp"),
      parseOpaqueId(operationIdValue, "operationId"),
    ).run();
  }

  async recover(
    operationIdValue: string,
    principalIdValue: string,
    nowValue = Date.now(),
  ): Promise<InstallationDeletionOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const now = timestamp(nowValue, "lifecycle timestamp");
    await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET state = COALESCE(
           (SELECT state FROM entitlements e
            WHERE e.installation_id = installations.id AND e.effective_at <= ?),
           (SELECT previous_state FROM installation_deletion_operations d
            WHERE d.operation_id = ?)
         )
         WHERE id = (
           SELECT installation_id FROM installation_deletion_operations
           WHERE operation_id = ? AND requested_by_principal_id = ?
             AND state IN ('preparing', 'recoverable')
             AND recoverable_until > ?
         )`,
      ).bind(now, operationId, operationId, principalId, now),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'active', retired_at = NULL
         WHERE installation_id = (
           SELECT installation_id FROM installation_deletion_operations
           WHERE operation_id = ? AND requested_by_principal_id = ?
             AND state IN ('preparing', 'recoverable')
             AND recoverable_until > ?
         ) AND kind = 'canonical'`,
      ).bind(operationId, principalId, now),
      this.db.prepare(
        `UPDATE installation_deletion_operations
         SET state = 'recovered', completed_at = ?, updated_at = ?,
             last_error_code = NULL
         WHERE operation_id = ? AND requested_by_principal_id = ?
           AND state IN ('preparing', 'recoverable')
           AND recoverable_until > ?`,
      ).bind(now, now, operationId, principalId, now),
      this.db.prepare(
        `UPDATE billing_termination_operations
         SET state = 'cancelled', lease_nonce = NULL, lease_until = NULL,
             last_error_code = NULL, completed_at = ?, updated_at = ?
         WHERE deletion_operation_id = ?
           AND state IN ('requested', 'processing', 'failed')`,
      ).bind(now, now, operationId),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome,
           created_at, metadata_json
         )
         SELECT ?, ?, installation_id, 'installation.deletion_recovered',
                'succeeded', ?, '{}'
         FROM installation_deletion_operations
         WHERE operation_id = ? AND state = 'recovered' AND completed_at = ?`,
      ).bind(`audit_${crypto.randomUUID()}`, principalId, now, operationId, now),
    ]);
    const operation = await this.require(operationId);
    if (operation.state !== "recovered") {
      throw new Error("installation deletion is no longer recoverable");
    }
    return operation;
  }

  async finalize(operationIdValue: string, nowValue = Date.now()): Promise<void> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const now = timestamp(nowValue, "lifecycle timestamp");
    const operation = await this.require(operationId);
    if (
      operation.state !== "deleting"
      || !operation.gatewayDeleted
      || !operation.inferenceDeleted
      || !operation.telegramDeleted
    ) {
      throw new Error("installation resource deletion is incomplete");
    }
    await this.db.batch([
      this.db.prepare(
        "DELETE FROM login_handoffs WHERE installation_id = ?",
      ).bind(operation.installationId),
      this.db.prepare(
        "DELETE FROM entitlements WHERE installation_id = ?",
      ).bind(operation.installationId),
      this.db.prepare(
        `DELETE FROM managed_telegram_link_operations
         WHERE target_installation_id = ? OR previous_installation_id = ?`,
      ).bind(operation.installationId, operation.installationId),
      this.db.prepare(
        "DELETE FROM memberships WHERE installation_id = ?",
      ).bind(operation.installationId),
      this.db.prepare(
        "DELETE FROM provisioning_operations WHERE installation_id = ?",
      ).bind(operation.installationId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'retired', retired_at = COALESCE(retired_at, ?)
         WHERE installation_id = ?`,
      ).bind(now, operation.installationId),
      this.db.prepare(
        `UPDATE installations
         SET state = 'deleted', deleted_at = ?, retained_until = NULL
         WHERE id = ? AND state = 'deleting'`,
      ).bind(now, operation.installationId),
      this.db.prepare(
        `UPDATE installation_deletion_operations
         SET state = 'complete', completed_at = ?, updated_at = ?,
             last_error_code = NULL
         WHERE operation_id = ? AND state = 'deleting'
           AND gateway_deleted = 1 AND inference_deleted = 1
           AND telegram_deleted = 1`,
      ).bind(now, now, operationId),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome,
           created_at, metadata_json
         ) VALUES (?, NULL, ?, 'installation.deleted', 'succeeded', ?, '{}')`,
      ).bind(`audit_${crypto.randomUUID()}`, operation.installationId, now),
    ]);
    const completed = await this.require(operationId);
    if (completed.state !== "complete") {
      throw new Error("installation deletion completion was not committed");
    }
  }

  private async require(operationId: string): Promise<InstallationDeletionOperation> {
    const operation = await this.get(operationId);
    if (!operation) throw new Error("installation deletion is unavailable");
    return operation;
  }
}

function fromRow(row: DeletionRow): InstallationDeletionOperation {
  return {
    operationId: row.operation_id,
    installationId: row.installation_id,
    requestedByPrincipalId: row.requested_by_principal_id,
    requestKind: row.request_kind,
    previousState: row.previous_state,
    state: row.state,
    recoverableUntil: row.recoverable_until,
    gatewayPrepared: row.gateway_prepared === 1,
    inferenceSuspended: row.inference_suspended === 1,
    telegramSuspended: row.telegram_suspended === 1,
    gatewayDeleted: row.gateway_deleted === 1,
    inferenceDeleted: row.inference_deleted === 1,
    telegramDeleted: row.telegram_deleted === 1,
    attempt: row.attempt,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function assertUserDeletionReplay(
  operation: InstallationDeletionOperation,
  input: {
    principalId: string;
    installationId: string;
    recoverableUntil: number;
  },
): void {
  if (
    operation.requestKind !== "user"
    || operation.requestedByPrincipalId !== input.principalId
    || operation.installationId !== input.installationId
    || operation.recoverableUntil !== input.recoverableUntil
  ) {
    throw new Error("deletion idempotency key conflicts with an earlier request");
  }
}

function isDeletableState(
  state: ManagedInstallationState,
): state is InstallationDeletionOperation["previousState"] {
  return state === "trialing"
    || state === "active"
    || state === "past_due"
    || state === "restricted"
    || state === "cancelled"
    || state === "retained";
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function batchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("lifecycle batch limit is invalid");
  }
  return value;
}
