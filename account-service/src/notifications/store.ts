import { parseOpaqueId } from "../domain";

const DAY_MS = 24 * 60 * 60_000;
const DELIVERY_LEASE_MS = 30_000;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$|^[a-z][a-z0-9_]{0,63}$/;

export type LifecycleNotificationKind =
  | "payment_past_due"
  | "service_restricted"
  | "retention_started"
  | "retention_7_days"
  | "retention_1_day"
  | "user_deletion_requested"
  | "user_deletion_recovered"
  | "installation_deleted";

export type LifecycleNotificationState =
  | "pending"
  | "sending"
  | "sent"
  | "permanent_failure"
  | "expired";

export type LifecycleNotification = {
  id: string;
  installationId: string;
  principalId: string;
  kind: LifecycleNotificationKind;
  sourceId: string;
  lifecycleKey: string;
  deadlineAt: number | null;
  scheduledAt: number;
  expiresAt: number | null;
  state: LifecycleNotificationState;
  attempt: number;
  nextAttemptAt: number;
  leaseNonce: string | null;
  leaseUntil: number | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
};

export type ClaimedLifecycleNotification = LifecycleNotification & {
  recipientEmail: string;
  installationHandle: string;
  canonicalOrigin: string;
  leaseNonce: string;
  leaseUntil: number;
};

type NotificationRow = {
  id: string;
  installation_id: string;
  principal_id: string;
  kind: LifecycleNotificationKind;
  source_id: string;
  lifecycle_key: string;
  deadline_at: number | null;
  scheduled_at: number;
  expires_at: number | null;
  state: LifecycleNotificationState;
  attempt: number;
  next_attempt_at: number;
  lease_nonce: string | null;
  lease_until: number | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
};

type ClaimedNotificationRow = NotificationRow & {
  primary_email: string;
  handle: string;
  canonical_origin: string;
};

const NOTIFICATION_SELECT = `SELECT
  id, installation_id, principal_id, kind, source_id, lifecycle_key,
  deadline_at, scheduled_at, expires_at, state, attempt, next_attempt_at,
  lease_nonce, lease_until, provider_message_id, last_error_code,
  created_at, updated_at, sent_at
FROM lifecycle_notification_outbox`;

export class LifecycleNotificationStore {
  constructor(private readonly db: D1Database) {}

  async enqueueDue(nowValue = Date.now()): Promise<void> {
    const now = timestamp(nowValue, "notification timestamp");
    await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO lifecycle_notification_outbox (
           id, installation_id, principal_id, kind, source_id, lifecycle_key,
           deadline_at, scheduled_at, expires_at, next_attempt_at,
           created_at, updated_at
         )
         SELECT
           'notification_payment_past_due_' || s.id || '_' || s.grace_ends_at,
           s.installation_id, i.owner_principal_id, 'payment_past_due', s.id,
           CAST(s.grace_ends_at AS TEXT), s.grace_ends_at, s.updated_at,
           s.grace_ends_at, s.updated_at, ?, ?
         FROM subscriptions s
         JOIN installations i ON i.id = s.installation_id
         WHERE s.state = 'past_due' AND s.grace_ends_at IS NOT NULL
           AND i.state = 'past_due'`,
      ).bind(now, now),
      this.db.prepare(
        `INSERT OR IGNORE INTO lifecycle_notification_outbox (
           id, installation_id, principal_id, kind, source_id, lifecycle_key,
           deadline_at, scheduled_at, expires_at, next_attempt_at,
           created_at, updated_at
         )
         SELECT
           'notification_service_restricted_' || s.id || '_' || s.grace_ends_at,
           s.installation_id, i.owner_principal_id, 'service_restricted', s.id,
           CAST(s.grace_ends_at AS TEXT), NULL, s.updated_at, NULL,
           s.updated_at, ?, ?
         FROM subscriptions s
         JOIN installations i ON i.id = s.installation_id
         WHERE s.state = 'restricted' AND s.grace_ends_at IS NOT NULL
           AND i.state = 'restricted'`,
      ).bind(now, now),
      this.retentionInsert(
        "retention_started",
        "s.updated_at",
        `s.retention_ends_at - ${7 * DAY_MS}`,
        now,
      ),
      this.retentionInsert(
        "retention_7_days",
        `s.retention_ends_at - ${7 * DAY_MS}`,
        `s.retention_ends_at - ${DAY_MS}`,
        now,
      ),
      this.retentionInsert(
        "retention_1_day",
        `s.retention_ends_at - ${DAY_MS}`,
        "s.retention_ends_at",
        now,
      ),
      this.db.prepare(
        `INSERT OR IGNORE INTO lifecycle_notification_outbox (
           id, installation_id, principal_id, kind, source_id, lifecycle_key,
           deadline_at, scheduled_at, expires_at, next_attempt_at,
           created_at, updated_at
         )
         SELECT
           'notification_user_deletion_requested_' || d.operation_id,
           d.installation_id, d.requested_by_principal_id,
           'user_deletion_requested', d.operation_id, d.operation_id,
           d.recoverable_until, d.created_at, d.recoverable_until,
           d.created_at, ?, ?
         FROM installation_deletion_operations d
         WHERE d.request_kind = 'user'
           AND d.requested_by_principal_id IS NOT NULL`,
      ).bind(now, now),
      this.db.prepare(
        `INSERT OR IGNORE INTO lifecycle_notification_outbox (
           id, installation_id, principal_id, kind, source_id, lifecycle_key,
           deadline_at, scheduled_at, expires_at, next_attempt_at,
           created_at, updated_at
         )
         SELECT
           'notification_user_deletion_recovered_' || d.operation_id,
           d.installation_id, d.requested_by_principal_id,
           'user_deletion_recovered', d.operation_id, d.operation_id,
           NULL, d.completed_at, NULL, d.completed_at, ?, ?
         FROM installation_deletion_operations d
         WHERE d.request_kind = 'user' AND d.state = 'recovered'
           AND d.requested_by_principal_id IS NOT NULL
           AND d.completed_at IS NOT NULL`,
      ).bind(now, now),
      this.db.prepare(
        `INSERT OR IGNORE INTO lifecycle_notification_outbox (
           id, installation_id, principal_id, kind, source_id, lifecycle_key,
           deadline_at, scheduled_at, expires_at, next_attempt_at,
           created_at, updated_at
         )
         SELECT
           'notification_installation_deleted_' || d.operation_id,
           d.installation_id, i.owner_principal_id, 'installation_deleted',
           d.operation_id, d.operation_id, NULL, d.completed_at, NULL,
           d.completed_at, ?, ?
         FROM installation_deletion_operations d
         JOIN installations i ON i.id = d.installation_id
         WHERE d.state = 'complete' AND d.completed_at IS NOT NULL`,
      ).bind(now, now),
    ]);
  }

  async claimDue(
    nowValue = Date.now(),
    limitValue = 10,
  ): Promise<ClaimedLifecycleNotification[]> {
    const now = timestamp(nowValue, "notification claim timestamp");
    const limit = batchLimit(limitValue);
    await this.expireStale(now);
    const candidates = await this.db.prepare(
      `SELECT id
       FROM lifecycle_notification_outbox
       WHERE next_attempt_at <= ?
         AND scheduled_at <= ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           state = 'pending'
           OR (state = 'sending' AND lease_until <= ?)
         )
       ORDER BY scheduled_at, id
       LIMIT ?`,
    ).bind(now, now, now, now, limit).all<{ id: string }>();
    const claimed: ClaimedLifecycleNotification[] = [];
    for (const candidate of candidates.results) {
      const leaseNonce = crypto.randomUUID();
      const leaseUntil = now + DELIVERY_LEASE_MS;
      const acquired = await this.db.prepare(
        `UPDATE lifecycle_notification_outbox
         SET state = 'sending', attempt = attempt + 1,
             lease_nonce = ?, lease_until = ?, last_error_code = NULL,
             updated_at = ?
         WHERE id = ? AND next_attempt_at <= ? AND scheduled_at <= ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (
             state = 'pending'
             OR (state = 'sending' AND lease_until <= ?)
           )
         RETURNING id`,
      ).bind(
        leaseNonce,
        leaseUntil,
        now,
        candidate.id,
        now,
        now,
        now,
        now,
      ).first<{ id: string }>();
      if (!acquired) continue;
      const row = await this.db.prepare(
        `SELECT
           n.id, n.installation_id, n.principal_id, n.kind, n.source_id,
           n.lifecycle_key, n.deadline_at, n.scheduled_at, n.expires_at,
           n.state, n.attempt, n.next_attempt_at, n.lease_nonce,
           n.lease_until, n.provider_message_id, n.last_error_code,
           n.created_at, n.updated_at, n.sent_at,
           p.primary_email, i.handle, i.canonical_origin
         FROM lifecycle_notification_outbox n
         JOIN principals p ON p.id = n.principal_id
         JOIN installations i ON i.id = n.installation_id
         WHERE n.id = ? AND n.state = 'sending' AND n.lease_nonce = ?
         LIMIT 1`,
      ).bind(candidate.id, leaseNonce).first<ClaimedNotificationRow>();
      if (row) claimed.push(claimedFromRow(row));
    }
    return claimed;
  }

  async markSent(input: {
    id: string;
    leaseNonce: string;
    providerMessageId: string;
    now?: number;
  }): Promise<void> {
    const id = parseOpaqueId(input.id, "notificationId");
    const leaseNonce = parseOpaqueId(input.leaseNonce, "leaseNonce");
    const providerMessageId = externalMessageId(input.providerMessageId);
    const now = timestamp(input.now ?? Date.now(), "notification sent timestamp");
    await this.db.batch([
      this.db.prepare(
        `UPDATE lifecycle_notification_outbox
         SET state = 'sent', provider_message_id = ?, sent_at = ?,
             lease_nonce = NULL, lease_until = NULL, last_error_code = NULL,
             updated_at = ?
         WHERE id = ? AND state = 'sending' AND lease_nonce = ?`,
      ).bind(providerMessageId, now, now, id, leaseNonce),
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, principal_id, installation_id, action, outcome,
           created_at, metadata_json
         )
         SELECT 'audit_' || n.id, n.principal_id, n.installation_id,
                'notification.sent', 'succeeded', ?,
                json_object('kind', n.kind)
         FROM lifecycle_notification_outbox n
         WHERE n.id = ? AND n.state = 'sent'
           AND n.provider_message_id = ?`,
      ).bind(now, id, providerMessageId),
    ]);
    const stored = await this.get(id);
    if (stored?.state !== "sent" || stored.providerMessageId !== providerMessageId) {
      throw new Error("notification delivery lease is unavailable");
    }
  }

  async markFailed(input: {
    id: string;
    leaseNonce: string;
    errorCode: string;
    retryAt: number;
    permanent: boolean;
    now?: number;
  }): Promise<void> {
    const id = parseOpaqueId(input.id, "notificationId");
    const leaseNonce = parseOpaqueId(input.leaseNonce, "leaseNonce");
    const errorCode = notificationErrorCode(input.errorCode);
    const now = timestamp(input.now ?? Date.now(), "notification failure timestamp");
    const retryAt = timestamp(input.retryAt, "notification retry timestamp");
    if (!input.permanent && retryAt <= now) {
      throw new Error("notification retry timestamp is invalid");
    }
    await this.db.prepare(
      `UPDATE lifecycle_notification_outbox
       SET state = CASE
             WHEN ? OR (expires_at IS NOT NULL AND expires_at <= ?)
               THEN 'permanent_failure'
             ELSE 'pending'
           END,
           next_attempt_at = ?, lease_nonce = NULL, lease_until = NULL,
           last_error_code = ?, updated_at = ?
       WHERE id = ? AND state = 'sending' AND lease_nonce = ?`,
    ).bind(
      input.permanent ? 1 : 0,
      retryAt,
      retryAt,
      errorCode,
      now,
      id,
      leaseNonce,
    ).run();
  }

  async get(idValue: string): Promise<LifecycleNotification | null> {
    const id = parseOpaqueId(idValue, "notificationId");
    const row = await this.db.prepare(
      `${NOTIFICATION_SELECT} WHERE id = ? LIMIT 1`,
    ).bind(id).first<NotificationRow>();
    return row ? notificationFromRow(row) : null;
  }

  async listForInstallation(
    installationIdValue: string,
  ): Promise<LifecycleNotification[]> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const rows = await this.db.prepare(
      `${NOTIFICATION_SELECT}
       WHERE installation_id = ?
       ORDER BY scheduled_at, id`,
    ).bind(installationId).all<NotificationRow>();
    return rows.results.map(notificationFromRow);
  }

  private retentionInsert(
    kind: "retention_started" | "retention_7_days" | "retention_1_day",
    scheduledExpression: string,
    expiresExpression: string,
    now: number,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT OR IGNORE INTO lifecycle_notification_outbox (
         id, installation_id, principal_id, kind, source_id, lifecycle_key,
         deadline_at, scheduled_at, expires_at, next_attempt_at,
         created_at, updated_at
       )
       SELECT
         'notification_${kind}_' || s.id || '_' || s.retention_ends_at,
         s.installation_id, i.owner_principal_id, '${kind}', s.id,
         CAST(s.retention_ends_at AS TEXT), s.retention_ends_at,
         ${scheduledExpression}, ${expiresExpression}, ${scheduledExpression},
         ?, ?
       FROM subscriptions s
       JOIN installations i ON i.id = s.installation_id
       WHERE s.state = 'retained' AND s.retention_ends_at IS NOT NULL
         AND i.state = 'retained'
         AND ${expiresExpression} > ${scheduledExpression}`,
    ).bind(now, now);
  }

  private async expireStale(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE lifecycle_notification_outbox
         SET state = CASE WHEN attempt > 0
               THEN 'permanent_failure' ELSE 'expired' END,
             lease_nonce = NULL, lease_until = NULL,
             last_error_code = CASE WHEN attempt > 0
               THEN 'delivery_window_elapsed' ELSE 'delivery_window_missed' END,
             updated_at = ?
         WHERE (state = 'pending' OR (state = 'sending' AND lease_until <= ?))
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      ).bind(now, now, now),
      this.db.prepare(
        `UPDATE lifecycle_notification_outbox
         SET state = 'expired', lease_nonce = NULL, lease_until = NULL,
             last_error_code = 'lifecycle_superseded', updated_at = ?
         WHERE (state = 'pending' OR (state = 'sending' AND lease_until <= ?))
           AND (
             (kind = 'payment_past_due' AND NOT EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.id = source_id AND s.state = 'past_due'
             ))
             OR (kind = 'service_restricted' AND NOT EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.id = source_id AND s.state = 'restricted'
             ))
             OR (kind IN ('retention_started', 'retention_7_days', 'retention_1_day')
               AND NOT EXISTS (
                 SELECT 1 FROM installations i
                 WHERE i.id = installation_id AND i.state = 'retained'
               ))
             OR (kind = 'user_deletion_requested' AND EXISTS (
               SELECT 1 FROM installation_deletion_operations d
               WHERE d.operation_id = source_id AND d.state = 'recovered'
             ))
           )`,
      ).bind(now, now),
    ]);
  }
}

function notificationFromRow(row: NotificationRow): LifecycleNotification {
  return {
    id: row.id,
    installationId: row.installation_id,
    principalId: row.principal_id,
    kind: row.kind,
    sourceId: row.source_id,
    lifecycleKey: row.lifecycle_key,
    deadlineAt: row.deadline_at,
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    state: row.state,
    attempt: row.attempt,
    nextAttemptAt: row.next_attempt_at,
    leaseNonce: row.lease_nonce,
    leaseUntil: row.lease_until,
    providerMessageId: row.provider_message_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function claimedFromRow(row: ClaimedNotificationRow): ClaimedLifecycleNotification {
  const notification = notificationFromRow(row);
  if (!notification.leaseNonce || notification.leaseUntil === null) {
    throw new Error("claimed notification lease is invalid");
  }
  return {
    ...notification,
    recipientEmail: row.primary_email,
    installationHandle: row.handle,
    canonicalOrigin: row.canonical_origin,
    leaseNonce: notification.leaseNonce,
    leaseUntil: notification.leaseUntil,
  };
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function batchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("notification batch limit is invalid");
  }
  return value;
}

function externalMessageId(value: string): string {
  if (!/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw new Error("provider message ID is invalid");
  }
  return value;
}

function notificationErrorCode(value: string): string {
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw new Error("notification error code is invalid");
  }
  return value;
}
