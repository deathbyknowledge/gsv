/**
 * Device registry backed by kernel DO SQLite.
 *
 * Devices are physical machines (laptops, servers) that connect as drivers
 * and implement syscall interfaces. Think /dev/ in Linux.
 *
 * Tables:
 *   devices        — persistent device catalog (survives disconnects)
 *   device_access  — ACL: which groups can use which devices
 */

import { hasCapability, isValidCapability } from "./capabilities";

export type DeviceRecord = {
  device_id: string;
  owner_uid: number;
  implements: string[];
  platform: string;
  version: string;
  online: boolean;
  first_seen_at: number;
  last_seen_at: number;
  connected_at: number | null;
  disconnected_at: number | null;
};

export class DeviceRegistry {
  constructor(private sql: SqlStorage) { }

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id        TEXT    PRIMARY KEY,
        owner_uid        INTEGER NOT NULL,
        implements       TEXT    NOT NULL DEFAULT '[]',
        platform         TEXT    NOT NULL DEFAULT '',
        version          TEXT    NOT NULL DEFAULT '',
        online           INTEGER NOT NULL DEFAULT 0,
        first_seen_at    INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        connected_at     INTEGER,
        disconnected_at  INTEGER
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS device_access (
        device_id TEXT    NOT NULL,
        gid       INTEGER NOT NULL,
        PRIMARY KEY (device_id, gid)
      )
    `);
  }

  register(
    deviceId: string,
    ownerUid: number,
    ownerGid: number,
    impl: string[],
    platform: string,
    version: string,
  ): { ok: boolean; error?: string } {
    for (const pattern of impl) {
      if (!isValidCapability(pattern)) {
        return { ok: false, error: `Invalid implements pattern: ${pattern}` };
      }
    }

    const now = Date.now();
    const existing = this.get(deviceId);

    if (existing) {
      this.sql.exec(
        `UPDATE devices SET
          owner_uid = ?, implements = ?, platform = ?, version = ?,
          online = 1, last_seen_at = ?, connected_at = ?, disconnected_at = NULL
        WHERE device_id = ?`,
        ownerUid,
        JSON.stringify(impl),
        platform,
        version,
        now,
        now,
        deviceId,
      );
    } else {
      this.sql.exec(
        `INSERT INTO devices
          (device_id, owner_uid, implements, platform, version, online, first_seen_at, last_seen_at, connected_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        deviceId,
        ownerUid,
        JSON.stringify(impl),
        platform,
        version,
        now,
        now,
        now,
      );

      this.sql.exec(
        `INSERT OR IGNORE INTO device_access (device_id, gid) VALUES (?, ?)`,
        deviceId,
        ownerGid,
      );
    }

    return { ok: true };
  }

  setOnline(deviceId: string, online: boolean): void {
    const now = Date.now();
    if (online) {
      this.sql.exec(
        `UPDATE devices SET online = 1, connected_at = ?, disconnected_at = NULL, last_seen_at = ? WHERE device_id = ?`,
        now,
        now,
        deviceId,
      );
    } else {
      this.sql.exec(
        `UPDATE devices SET online = 0, disconnected_at = ?, last_seen_at = ? WHERE device_id = ?`,
        now,
        now,
        deviceId,
      );
    }
  }

  get(deviceId: string): DeviceRecord | null {
    const rows = this.sql.exec<{
      device_id: string;
      owner_uid: number;
      implements: string;
      platform: string;
      version: string;
      online: number;
      first_seen_at: number;
      last_seen_at: number;
      connected_at: number | null;
      disconnected_at: number | null;
    }>(
      `SELECT * FROM devices WHERE device_id = ?`,
      deviceId,
    ).toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      ...row,
      implements: JSON.parse(row.implements),
      online: row.online === 1,
    };
  }

  listOnline(): DeviceRecord[] {
    const rows = this.sql.exec<{
      device_id: string;
      owner_uid: number;
      implements: string;
      platform: string;
      version: string;
      online: number;
      first_seen_at: number;
      last_seen_at: number;
      connected_at: number | null;
      disconnected_at: number | null;
    }>(
      `SELECT * FROM devices WHERE online = 1 ORDER BY device_id`,
    ).toArray();

    return rows.map((row) => ({
      ...row,
      implements: JSON.parse(row.implements),
      online: true,
    }));
  }

  /**
   * List all devices accessible to a user.
   * uid 0 sees everything. Others see devices they own or have group access to.
   */
  listForUser(uid: number, gids: number[]): DeviceRecord[] {
    type RawRow = {
      device_id: string;
      owner_uid: number;
      implements: string;
      platform: string;
      version: string;
      online: number;
      first_seen_at: number;
      last_seen_at: number;
      connected_at: number | null;
      disconnected_at: number | null;
    };

    let rows: RawRow[];

    if (uid === 0) {
      rows = this.sql.exec<RawRow>(
        `SELECT * FROM devices ORDER BY device_id`,
      ).toArray();
    } else if (gids.length > 0) {
      const placeholders = gids.map(() => "?").join(", ");
      rows = this.sql.exec<RawRow>(
        `SELECT DISTINCT d.* FROM devices d
         LEFT JOIN device_access da ON d.device_id = da.device_id
         WHERE d.owner_uid = ? OR da.gid IN (${placeholders})
         ORDER BY d.device_id`,
        uid,
        ...gids,
      ).toArray();
    } else {
      rows = this.sql.exec<RawRow>(
        `SELECT * FROM devices WHERE owner_uid = ? ORDER BY device_id`,
        uid,
      ).toArray();
    }

    return rows.map((row) => ({
      ...row,
      implements: JSON.parse(row.implements),
      online: row.online === 1,
    }));
  }

  /**
   * Check whether a user (by gids) is allowed to use a device.
   * uid 0 always has access.
   */
  canAccess(deviceId: string, uid: number, gids: number[]): boolean {
    if (uid === 0) return true;

    const device = this.get(deviceId);
    if (!device) return false;

    if (device.owner_uid === uid) return true;

    if (gids.length === 0) return false;

    const placeholders = gids.map(() => "?").join(", ");
    const rows = this.sql.exec<{ gid: number }>(
      `SELECT gid FROM device_access WHERE device_id = ? AND gid IN (${placeholders})`,
      deviceId,
      ...gids,
    ).toArray();

    return rows.length > 0;
  }

  /**
   * Check whether a device implements a given syscall.
   * Reuses the same matching logic as capabilities.
   */
  canHandle(deviceId: string, syscall: string): boolean {
    const device = this.get(deviceId);
    if (!device) return false;
    return hasCapability(device.implements, syscall);
  }

  /**
   * Find an online device that implements a syscall and is accessible to the user.
   * Returns null if no suitable device is found.
   */
  findDevice(
    syscall: string,
    uid: number,
    gids: number[],
  ): DeviceRecord | null {
    const online = this.listOnline();
    for (const device of online) {
      if (
        hasCapability(device.implements, syscall) &&
        this.canAccess(device.device_id, uid, gids)
      ) {
        return device;
      }
    }
    return null;
  }

  grantAccess(deviceId: string, gid: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO device_access (device_id, gid) VALUES (?, ?)`,
      deviceId,
      gid,
    );
  }

  revokeAccess(deviceId: string, gid: number): void {
    this.sql.exec(
      `DELETE FROM device_access WHERE device_id = ? AND gid = ?`,
      deviceId,
      gid,
    );
  }

  listAccess(deviceId: string): number[] {
    const rows = this.sql.exec<{ gid: number }>(
      `SELECT gid FROM device_access WHERE device_id = ? ORDER BY gid`,
      deviceId,
    ).toArray();
    return rows.map((r) => r.gid);
  }
}
