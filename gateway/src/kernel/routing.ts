/**
 * RoutingTable — hibernate-safe routing for in-flight device-routed syscalls.
 *
 * Every forwarded request is persisted in kernel SQLite with an origin
 * (who to send the response back to) and a device (who is handling it).
 * Per-entry expiry is handled via the agents SDK `schedule()`.
 */

import type { SyscallName } from "../syscalls";

export type RouteOrigin =
  | { type: "connection"; id: string }
  | { type: "process"; id: string }
  | { type: "app"; id: string };

export type RouteEntry = {
  id: string;
  call: SyscallName;
  origin: RouteOrigin;
  deviceId: string;
  createdAt: number;
  expiresAt: number | null;
  scheduleId: string | null;
};

const DEFAULT_TTL_MS = 60_000;

export class RoutingTable {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS routing_table (
        id TEXT PRIMARY KEY,
        call TEXT NOT NULL,
        origin_type TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        schedule_id TEXT
      )
    `);
  }

  register(
    id: string,
    call: SyscallName,
    origin: RouteOrigin,
    deviceId: string,
    options?: { ttlMs?: number; scheduleId?: string },
  ): void {
    const now = Date.now();
    const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = now + ttl;
    const scheduleId = options?.scheduleId ?? null;

    this.sql.exec(
      `INSERT OR REPLACE INTO routing_table (id, call, origin_type, origin_id, device_id, created_at, expires_at, schedule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      call,
      origin.type,
      origin.id,
      deviceId,
      now,
      expiresAt,
      scheduleId,
    );
  }

  consume(id: string): { origin: RouteOrigin; call: SyscallName; deviceId: string; scheduleId: string | null } | null {
    const rows = [...this.sql.exec<{
      origin_type: string;
      origin_id: string;
      call: string;
      device_id: string;
      schedule_id: string | null;
    }>(
      "SELECT origin_type, origin_id, call, device_id, schedule_id FROM routing_table WHERE id = ?",
      id,
    )];

    if (rows.length === 0) return null;

    this.sql.exec("DELETE FROM routing_table WHERE id = ?", id);

    const row = rows[0];
    return {
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      call: row.call as SyscallName,
      deviceId: row.device_id,
      scheduleId: row.schedule_id,
    };
  }

  get(id: string): RouteEntry | null {
    const rows = [...this.sql.exec<{
      id: string;
      call: string;
      origin_type: string;
      origin_id: string;
      device_id: string;
      created_at: number;
      expires_at: number | null;
      schedule_id: string | null;
    }>(
      "SELECT * FROM routing_table WHERE id = ?",
      id,
    )];

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      call: row.call as SyscallName,
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      deviceId: row.device_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      scheduleId: row.schedule_id,
    };
  }

  failForDevice(deviceId: string): { id: string; origin: RouteOrigin; call: SyscallName; scheduleId: string | null }[] {
    const rows = [...this.sql.exec<{
      id: string;
      origin_type: string;
      origin_id: string;
      call: string;
      schedule_id: string | null;
    }>(
      "SELECT id, origin_type, origin_id, call, schedule_id FROM routing_table WHERE device_id = ?",
      deviceId,
    )];

    if (rows.length > 0) {
      this.sql.exec("DELETE FROM routing_table WHERE device_id = ?", deviceId);
    }

    return rows.map((row) => ({
      id: row.id,
      origin: { type: row.origin_type as "connection" | "process", id: row.origin_id },
      call: row.call as SyscallName,
      scheduleId: row.schedule_id,
    }));
  }

  failForConnection(connectionId: string): { id: string; deviceId: string; scheduleId: string | null }[] {
    const rows = [...this.sql.exec<{
      id: string;
      device_id: string;
      schedule_id: string | null;
    }>(
      "SELECT id, device_id, schedule_id FROM routing_table WHERE origin_type = 'connection' AND origin_id = ?",
      connectionId,
    )];

    if (rows.length > 0) {
      this.sql.exec(
        "DELETE FROM routing_table WHERE origin_type = 'connection' AND origin_id = ?",
        connectionId,
      );
    }

    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      scheduleId: row.schedule_id,
    }));
  }

  failForProcess(processId: string): { id: string; deviceId: string; scheduleId: string | null }[] {
    const rows = [...this.sql.exec<{
      id: string;
      device_id: string;
      schedule_id: string | null;
    }>(
      "SELECT id, device_id, schedule_id FROM routing_table WHERE origin_type = 'process' AND origin_id = ?",
      processId,
    )];

    if (rows.length > 0) {
      this.sql.exec(
        "DELETE FROM routing_table WHERE origin_type = 'process' AND origin_id = ?",
        processId,
      );
    }

    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      scheduleId: row.schedule_id,
    }));
  }

  /**
   * Expire a single route entry. Called by the schedule callback when a
   * per-entry timer fires. Returns the origin so the kernel can deliver
   * a timeout error.
   */
  expire(id: string): { origin: RouteOrigin; call: SyscallName; deviceId: string } | null {
    const rows = [...this.sql.exec<{
      origin_type: string;
      origin_id: string;
      call: string;
      device_id: string;
    }>(
      "SELECT origin_type, origin_id, call, device_id FROM routing_table WHERE id = ?",
      id,
    )];

    if (rows.length === 0) return null;

    this.sql.exec("DELETE FROM routing_table WHERE id = ?", id);

    const row = rows[0];
    return {
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      call: row.call as SyscallName,
      deviceId: row.device_id,
    };
  }

  count(): number {
    const rows = [...this.sql.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM routing_table")];
    return rows[0]?.cnt ?? 0;
  }
}
