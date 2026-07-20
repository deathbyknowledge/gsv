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
  driverConnectionId: string | null;
  createdAt: number;
  expiresAt: number | null;
  scheduleId: string | null;
};

export type FailedDeviceRoute = Pick<
  RouteEntry,
  "id" | "origin" | "deviceId" | "scheduleId"
>;

const DEFAULT_TTL_MS = 60_000;
const MAX_DRAIN_ORIGINS = 256;

type RouteRow = {
  id: string;
  call: string;
  origin_type: string;
  origin_id: string;
  device_id: string;
  driver_connection_id: string | null;
  created_at: number;
  expires_at: number | null;
  schedule_id: string | null;
};

export class RoutingTable {
  constructor(private readonly sql: SqlStorage) {}

  register(
    id: string,
    call: SyscallName,
    origin: RouteOrigin,
    deviceId: string,
    driverConnectionId: string,
    options?: { ttlMs?: number; scheduleId?: string },
  ): void {
    const now = Date.now();
    const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = now + ttl;
    const scheduleId = options?.scheduleId ?? null;

    this.sql.exec(
      `INSERT OR REPLACE INTO routing_table
       (id, call, origin_type, origin_id, device_id, driver_connection_id, created_at, expires_at, schedule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      call,
      origin.type,
      origin.id,
      deviceId,
      driverConnectionId,
      now,
      expiresAt,
      scheduleId,
    );
  }

  remove(id: string): Pick<
    RouteEntry,
    "origin" | "call" | "deviceId" | "driverConnectionId" | "scheduleId"
  > | null {
    const rows = [...this.sql.exec<{
      origin_type: string;
      origin_id: string;
      call: string;
      device_id: string;
      driver_connection_id: string | null;
      schedule_id: string | null;
    }>(
      `SELECT origin_type, origin_id, call, device_id, driver_connection_id, schedule_id
       FROM routing_table WHERE id = ?`,
      id,
    )];

    if (rows.length === 0) return null;

    this.sql.exec("DELETE FROM routing_table WHERE id = ?", id);

    const row = rows[0];
    return {
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      call: row.call as SyscallName,
      deviceId: row.device_id,
      driverConnectionId: row.driver_connection_id,
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
      driver_connection_id: string | null;
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
      driverConnectionId: row.driver_connection_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      scheduleId: row.schedule_id,
    };
  }

  /**
   * Atomically remove every in-flight route.
   *
   * Lifecycle fencing uses this to make persisted routes unreachable before
   * their late device responses can be delivered into a suspended user
   * Kernel. The caller owns cancelling route wakes, bodies, and remote work.
   */
  drain(): RouteEntry[] {
    const rows = this.sql.exec<RouteRow>("SELECT * FROM routing_table").toArray();

    if (rows.length > 0) {
      this.sql.exec("DELETE FROM routing_table");
    }

    return rows.map(toRouteEntry);
  }

  /**
   * Atomically remove routes owned by any exact origin in a bounded batch.
   *
   * Origin values are always SQL bindings. Only the fixed placeholder shape is
   * assembled into the query, so caller-controlled ids cannot alter the match.
   */
  drainForOrigins(origins: Iterable<RouteOrigin>): RouteEntry[] {
    const uniqueOrigins = new Map<string, RouteOrigin>();
    let originCount = 0;

    for (const origin of origins) {
      originCount += 1;
      if (originCount > MAX_DRAIN_ORIGINS) {
        throw new RangeError(
          `Cannot drain routes for more than ${MAX_DRAIN_ORIGINS} origins`,
        );
      }
      if (
        (origin.type !== "connection"
          && origin.type !== "process"
          && origin.type !== "app")
        || typeof origin.id !== "string"
      ) {
        throw new TypeError("Invalid route origin");
      }
      uniqueOrigins.set(`${origin.type}\0${origin.id}`, origin);
    }

    if (uniqueOrigins.size === 0) return [];

    const bindings: string[] = [];
    const predicates: string[] = [];
    for (const origin of uniqueOrigins.values()) {
      predicates.push("(origin_type = ? AND origin_id = ?)");
      bindings.push(origin.type, origin.id);
    }

    return this.sql.exec<RouteRow>(
      `DELETE FROM routing_table
       WHERE ${predicates.join(" OR ")}
       RETURNING *`,
      ...bindings,
    ).toArray().map(toRouteEntry);
  }

  failForDevice(deviceId: string): FailedDeviceRoute[] {
    const rows = [...this.sql.exec<{
      id: string;
      origin_type: string;
      origin_id: string;
      device_id: string;
      schedule_id: string | null;
    }>(
      `SELECT id, origin_type, origin_id, device_id, schedule_id
       FROM routing_table WHERE device_id = ?`,
      deviceId,
    )];

    if (rows.length > 0) {
      this.sql.exec("DELETE FROM routing_table WHERE device_id = ?", deviceId);
    }

    return rows.map((row) => ({
      id: row.id,
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      deviceId: row.device_id,
      scheduleId: row.schedule_id,
    }));
  }

  failForDriverConnection(driverConnectionId: string): FailedDeviceRoute[] {
    const rows = [...this.sql.exec<{
      id: string;
      origin_type: string;
      origin_id: string;
      device_id: string;
      schedule_id: string | null;
    }>(
      `SELECT id, origin_type, origin_id, device_id, schedule_id
       FROM routing_table WHERE driver_connection_id = ?`,
      driverConnectionId,
    )];

    if (rows.length > 0) {
      this.sql.exec(
        "DELETE FROM routing_table WHERE driver_connection_id = ?",
        driverConnectionId,
      );
    }

    return rows.map((row) => ({
      id: row.id,
      origin: { type: row.origin_type as "connection" | "process" | "app", id: row.origin_id },
      deviceId: row.device_id,
      scheduleId: row.schedule_id,
    }));
  }

  failForConnection(connectionId: string): {
    id: string;
    deviceId: string;
    driverConnectionId: string | null;
    scheduleId: string | null;
  }[] {
    const rows = [...this.sql.exec<{
      id: string;
      device_id: string;
      driver_connection_id: string | null;
      schedule_id: string | null;
    }>(
      `SELECT id, device_id, driver_connection_id, schedule_id FROM routing_table
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
      deviceId: row.device_id,
      driverConnectionId: row.driver_connection_id,
      scheduleId: row.schedule_id,
    }));
  }
}

function toRouteEntry(row: RouteRow): RouteEntry {
  return {
    id: row.id,
    call: row.call as SyscallName,
    origin: {
      type: row.origin_type as "connection" | "process" | "app",
      id: row.origin_id,
    },
    deviceId: row.device_id,
    driverConnectionId: row.driver_connection_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    scheduleId: row.schedule_id,
  };
}
