import type {
  NotificationAction,
  NotificationCreateArgs,
  NotificationCreateResult,
  NotificationDismissArgs,
  NotificationDismissResult,
  NotificationLevel,
  NotificationListArgs,
  NotificationListResult,
  NotificationMarkReadArgs,
  NotificationMarkReadResult,
  NotificationRecord,
  NotificationSource,
} from "@gsv/protocol/syscalls/notification";
import type { KernelContext } from "./context";

const DEFAULT_UNREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DISMISSED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 100;

type RowShape = {
  notification_id: string;
  uid: number;
  title: string;
  body: string | null;
  level: NotificationLevel;
  source_json: string;
  actions_json: string;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
  expires_at: number | null;
};

export class NotificationStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        level TEXT NOT NULL,
        source_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        dismissed_at INTEGER,
        expires_at INTEGER
      )
    `);

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_notifications_uid_created ON notifications (uid, created_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_notifications_uid_expires ON notifications (uid, expires_at)",
    );
  }

  create(input: {
    uid: number;
    title: string;
    body?: string;
    level: NotificationLevel;
    source: NotificationSource;
    actions: NotificationAction[];
    expiresAt: number | null;
  }): NotificationRecord {
    this.pruneExpired();
    const now = Date.now();
    const record: NotificationRecord = {
      notificationId: crypto.randomUUID(),
      title: input.title,
      body: input.body?.trim() || undefined,
      level: input.level,
      createdAt: now,
      readAt: null,
      dismissedAt: null,
      expiresAt: input.expiresAt,
      source: input.source,
      actions: input.actions,
    };

    this.sql.exec(
      `INSERT INTO notifications (
        notification_id, uid, title, body, level, source_json, actions_json,
        created_at, read_at, dismissed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.notificationId,
      input.uid,
      record.title,
      record.body ?? null,
      record.level,
      JSON.stringify(record.source),
      JSON.stringify(record.actions),
      record.createdAt,
      record.readAt,
      record.dismissedAt,
      record.expiresAt,
    );

    return record;
  }

  list(uid: number, args: NotificationListArgs): NotificationRecord[] {
    this.pruneExpired();
    const includeRead = args.includeRead !== false;
    const includeDismissed = args.includeDismissed === true;
    const limit = clampListLimit(args.limit);
    const clauses = ["uid = ?"];
    const bindings: unknown[] = [uid];

    if (!includeRead) {
      clauses.push("read_at IS NULL");
    }
    if (!includeDismissed) {
      clauses.push("dismissed_at IS NULL");
    }

    const rows = [...this.sql.exec<RowShape>(
      `SELECT * FROM notifications
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
      ...bindings,
      limit,
    )];
    return rows.map(toNotificationRecord);
  }

  markRead(uid: number, notificationId: string): NotificationRecord | null {
    this.pruneExpired();
    const row = this.getRow(uid, notificationId);
    if (!row) {
      return null;
    }
    const now = Date.now();
    const readAt = row.read_at ?? now;
    const expiresAt = now + DEFAULT_READ_TTL_MS;
    this.sql.exec(
      `UPDATE notifications
         SET read_at = ?, expires_at = ?
       WHERE uid = ? AND notification_id = ?`,
      readAt,
      expiresAt,
      uid,
      notificationId,
    );
    return {
      ...toNotificationRecord(row),
      readAt,
      expiresAt,
    };
  }

  dismiss(uid: number, notificationId: string): NotificationRecord | null {
    this.pruneExpired();
    const row = this.getRow(uid, notificationId);
    if (!row) {
      return null;
    }
    const now = Date.now();
    const dismissedAt = now;
    const expiresAt = now + DEFAULT_DISMISSED_TTL_MS;
    this.sql.exec(
      `UPDATE notifications
         SET dismissed_at = ?, expires_at = ?
       WHERE uid = ? AND notification_id = ?`,
      dismissedAt,
      expiresAt,
      uid,
      notificationId,
    );
    return {
      ...toNotificationRecord(row),
      dismissedAt,
      expiresAt,
    };
  }

  private getRow(uid: number, notificationId: string): RowShape | null {
    const rows = [...this.sql.exec<RowShape>(
      "SELECT * FROM notifications WHERE uid = ? AND notification_id = ? LIMIT 1",
      uid,
      notificationId,
    )];
    return rows[0] ?? null;
  }

  private pruneExpired(): void {
    this.sql.exec(
      "DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at <= ?",
      Date.now(),
    );
  }
}

export function handleNotificationCreate(
  args: NotificationCreateArgs,
  ctx: KernelContext,
): NotificationCreateResult {
  const store = requireNotificationStore(ctx);
  const uid = ctx.identity!.process.uid;
  const title = args.title.trim();
  if (!title) {
    throw new Error("title is required");
  }
  const notification = store.create({
    uid,
    title,
    body: args.body,
    level: args.level ?? "info",
    source: deriveNotificationSource(ctx),
    actions: normalizeActions(args.actions),
    expiresAt: clampNotificationTtl(args.ttlMs),
  });
  ctx.broadcastToUid?.(uid, "notification.created", { notification });
  return { notification };
}

export function handleNotificationList(
  args: NotificationListArgs,
  ctx: KernelContext,
): NotificationListResult {
  const store = requireNotificationStore(ctx);
  return {
    notifications: store.list(ctx.identity!.process.uid, args),
  };
}

export function handleNotificationMarkRead(
  args: NotificationMarkReadArgs,
  ctx: KernelContext,
): NotificationMarkReadResult {
  const store = requireNotificationStore(ctx);
  const notification = store.markRead(ctx.identity!.process.uid, args.notificationId);
  if (notification) {
    ctx.broadcastToUid?.(ctx.identity!.process.uid, "notification.updated", { notification });
  }
  return { notification };
}

export function handleNotificationDismiss(
  args: NotificationDismissArgs,
  ctx: KernelContext,
): NotificationDismissResult {
  const store = requireNotificationStore(ctx);
  const notification = store.dismiss(ctx.identity!.process.uid, args.notificationId);
  if (notification) {
    ctx.broadcastToUid?.(ctx.identity!.process.uid, "notification.dismissed", { notification });
  }
  return { notification };
}

function requireNotificationStore(ctx: KernelContext): NotificationStore {
  if (!ctx.notifications) {
    throw new Error("Notification store is unavailable");
  }
  return ctx.notifications;
}

function deriveNotificationSource(ctx: KernelContext): NotificationSource {
  if (ctx.processId) {
    return {
      kind: "process",
      processId: ctx.processId,
    };
  }
  if (ctx.appFrame) {
    return {
      kind: "app",
      packageId: ctx.appFrame.packageId,
      packageName: ctx.appFrame.packageName,
      entrypointName: ctx.appFrame.entrypointName,
    };
  }
  return { kind: "user" };
}

function normalizeActions(actions: NotificationAction[] | undefined): NotificationAction[] {
  if (!actions || actions.length === 0) {
    return [];
  }
  return actions
    .filter((action) => action && typeof action.kind === "string" && typeof action.label === "string")
    .map((action) => ({
      kind: action.kind.trim(),
      label: action.label.trim(),
      ...(action.target ? { target: action.target } : {}),
      ...(action.args ? { args: action.args } : {}),
    }))
    .filter((action) => action.kind.length > 0 && action.label.length > 0);
}

function clampNotificationTtl(ttlMs: number | undefined): number | null {
  const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs)
    ? Math.trunc(ttlMs)
    : DEFAULT_UNREAD_TTL_MS;
  return Date.now() + Math.max(1_000, Math.min(MAX_NOTIFICATION_TTL_MS, ttl));
}

function clampListLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

function toNotificationRecord(row: RowShape): NotificationRecord {
  return {
    notificationId: row.notification_id,
    title: row.title,
    body: row.body ?? undefined,
    level: row.level,
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    expiresAt: row.expires_at,
    source: parseSource(row.source_json),
    actions: parseActions(row.actions_json),
  };
}

function parseSource(value: string): NotificationSource {
  try {
    const parsed = JSON.parse(value) as NotificationSource;
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
      return parsed;
    }
  } catch {}
  return { kind: "user" };
}

function parseActions(value: string): NotificationAction[] {
  try {
    const parsed = JSON.parse(value) as NotificationAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
