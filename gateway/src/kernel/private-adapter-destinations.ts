import type { AdapterMessageDestination } from "@humansandmachines/gsv/protocol";

export type PrivateAdapterDestinationRecord = {
  uid: number;
  destination: AdapterMessageDestination;
  messageId: string;
  updatedAt: number;
};

export class PrivateAdapterDestinationStore {
  constructor(private readonly sql: SqlStorage) {}

  recordActivity(
    uid: number,
    destination: AdapterMessageDestination,
    messageId: string,
    activityAt: number,
  ): PrivateAdapterDestinationRecord {
    if (destination.kind !== "adapter" || destination.surface.kind !== "dm") {
      throw new Error("A preferred private adapter destination must be a DM");
    }
    if (!Number.isSafeInteger(activityAt) || activityAt <= 0) {
      throw new Error("Private adapter activity timestamp must be a positive integer");
    }
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      throw new Error("Private adapter activity message id is required");
    }
    this.sql.exec(
      `INSERT INTO private_adapter_destinations
       (uid, adapter, account_id, actor_id, surface_id, thread_id, message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         adapter = excluded.adapter,
         account_id = excluded.account_id,
         actor_id = excluded.actor_id,
         surface_id = excluded.surface_id,
         thread_id = excluded.thread_id,
         message_id = excluded.message_id,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= private_adapter_destinations.updated_at`,
      uid,
      destination.adapter,
      destination.accountId,
      destination.actorId,
      destination.surface.id,
      destination.surface.threadId?.trim() || "",
      normalizedMessageId,
      activityAt,
    );
    return this.get(uid)!;
  }

  get(uid: number): PrivateAdapterDestinationRecord | null {
    const rows = this.sql.exec<PrivateAdapterDestinationRow>(
      `SELECT uid, adapter, account_id, actor_id, surface_id, thread_id, message_id, updated_at
       FROM private_adapter_destinations
       WHERE uid = ?
       LIMIT 1`,
      uid,
    ).toArray();
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  clearIfMatches(uid: number, destination: AdapterMessageDestination): boolean {
    if (destination.kind !== "adapter" || destination.surface.kind !== "dm") {
      return false;
    }
    const cursor = this.sql.exec(
      `DELETE FROM private_adapter_destinations
       WHERE uid = ? AND adapter = ? AND account_id = ? AND actor_id = ?
         AND surface_id = ? AND thread_id = ?`,
      uid,
      destination.adapter,
      destination.accountId,
      destination.actorId,
      destination.surface.id,
      destination.surface.threadId?.trim() || "",
    );
    return cursor.rowsWritten > 0;
  }
}

type PrivateAdapterDestinationRow = {
  uid: number;
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_id: string;
  thread_id: string;
  message_id: string;
  updated_at: number;
};
type PrivateDmSurface = { kind: "dm"; id: string; threadId?: string };

function toRecord(row: PrivateAdapterDestinationRow): PrivateAdapterDestinationRecord {
  const surface: PrivateDmSurface = {
    kind: "dm",
    id: row.surface_id,
  };
  if (row.thread_id) surface.threadId = row.thread_id;
  return {
    uid: row.uid,
    destination: {
      kind: "adapter",
      adapter: row.adapter,
      accountId: row.account_id,
      actorId: row.actor_id,
      surface,
    },
    messageId: row.message_id,
    updatedAt: row.updated_at,
  };
}
