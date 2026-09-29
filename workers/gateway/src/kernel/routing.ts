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
  | { type: "kernel"; id: string };

export type RouteEntry = {
  id: string;
  call: SyscallName;
  origin: RouteOrigin;
  targetId: string;
  peerConnectionId: string | null;
  createdAt: number;
  expiresAt: number | null;
  scheduleId: string | null;
};

export type FailedTargetRoute = Pick<
  RouteEntry,
  "id" | "origin" | "targetId" | "scheduleId"
>;

const DEFAULT_TTL_MS = 60_000;

export class RoutingTable {
  constructor(private readonly sql: SqlStorage) {}

  register(
    id: string,
    call: SyscallName,
    origin: RouteOrigin,
    targetId: string,
    peerConnectionId: string,
    options?: { ttlMs?: number; scheduleId?: string },
  ): void {
    const now = Date.now();
    const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = now + ttl;
    const scheduleId = options?.scheduleId ?? null;

    this.sql.exec(
      `INSERT OR REPLACE INTO routing_table
       (id, call, origin_type, origin_id, target_id, peer_connection_id, created_at, expires_at, schedule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      call,
      origin.type,
      origin.id,
      targetId,
      peerConnectionId,
      now,
      expiresAt,
      scheduleId,
    );
  }

  remove(id: string): Pick<
    RouteEntry,
    "origin" | "call" | "targetId" | "peerConnectionId" | "scheduleId"
  > | null {
    const rows = [...this.sql.exec<{
      origin_type: string;
      origin_id: string;
      call: string;
      target_id: string;
      peer_connection_id: string | null;
      schedule_id: string | null;
    }>(
      `SELECT origin_type, origin_id, call, target_id, peer_connection_id, schedule_id
       FROM routing_table WHERE id = ?`,
      id,
    )];

    if (rows.length === 0) return null;

    this.sql.exec("DELETE FROM routing_table WHERE id = ?", id);

    const row = rows[0];
    return {
      // SAFETY: routing rows are written only with the RouteOrigin discriminator contract.
      origin: { type: row.origin_type as RouteOrigin["type"], id: row.origin_id },
      // SAFETY: routing rows are written only with the registered syscall contract.
      call: row.call as SyscallName,
      targetId: row.target_id,
      peerConnectionId: row.peer_connection_id,
      scheduleId: row.schedule_id,
    };
  }

  get(id: string): RouteEntry | null {
    const rows = [...this.sql.exec<{
      id: string;
      call: string;
      origin_type: string;
      origin_id: string;
      target_id: string;
      peer_connection_id: string | null;
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
      // SAFETY: routing rows are written only with the registered syscall contract.
      call: row.call as SyscallName,
      // SAFETY: routing rows are written only with the RouteOrigin discriminator contract.
      origin: { type: row.origin_type as RouteOrigin["type"], id: row.origin_id },
      targetId: row.target_id,
      peerConnectionId: row.peer_connection_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      scheduleId: row.schedule_id,
    };
  }

  failForDevice(targetId: string): FailedTargetRoute[] {
    const rows = [...this.sql.exec<{
      id: string;
      origin_type: string;
      origin_id: string;
      target_id: string;
      schedule_id: string | null;
    }>(
      `SELECT id, origin_type, origin_id, target_id, schedule_id
       FROM routing_table WHERE target_id = ?`,
      targetId,
    )];

    if (rows.length > 0) {
      this.sql.exec("DELETE FROM routing_table WHERE target_id = ?", targetId);
    }

    return rows.map((row) => ({
      id: row.id,
      // SAFETY: routing rows are written only with the RouteOrigin discriminator contract.
      origin: { type: row.origin_type as RouteOrigin["type"], id: row.origin_id },
      targetId: row.target_id,
      scheduleId: row.schedule_id,
    }));
  }

  failForDriverConnection(peerConnectionId: string): FailedTargetRoute[] {
    const rows = [...this.sql.exec<{
      id: string;
      origin_type: string;
      origin_id: string;
      target_id: string;
      schedule_id: string | null;
    }>(
      `SELECT id, origin_type, origin_id, target_id, schedule_id
       FROM routing_table WHERE peer_connection_id = ?`,
      peerConnectionId,
    )];

    if (rows.length > 0) {
      this.sql.exec(
        "DELETE FROM routing_table WHERE peer_connection_id = ?",
        peerConnectionId,
      );
    }

    return rows.map((row) => ({
      id: row.id,
      // SAFETY: routing rows are written only with the RouteOrigin discriminator contract.
      origin: { type: row.origin_type as RouteOrigin["type"], id: row.origin_id },
      targetId: row.target_id,
      scheduleId: row.schedule_id,
    }));
  }

  failForConnection(connectionId: string): {
    id: string;
    targetId: string;
    peerConnectionId: string | null;
    scheduleId: string | null;
  }[] {
    const rows = [...this.sql.exec<{
      id: string;
      target_id: string;
      peer_connection_id: string | null;
      schedule_id: string | null;
    }>(
      `SELECT id, target_id, peer_connection_id, schedule_id FROM routing_table
       WHERE origin_type = 'connection' AND origin_id = ?`,
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
      targetId: row.target_id,
      peerConnectionId: row.peer_connection_id,
      scheduleId: row.schedule_id,
    }));
  }
}
