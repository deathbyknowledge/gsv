/**
 * Device registry backed by kernel DO SQLite.
 *
 * Devices are physical machines (laptops, servers) that connect as drivers
 * and implement syscall interfaces. Think /dev/ in Linux.
 *
 * Tables:
 *   targets        — device catalog (survives disconnects)
 *   target_access  — ACL: which groups can use which targets
 */

import { hasCapability, isValidCapability } from "./capabilities";

export type TargetRegisterOptions = {
  label?: string;
  description?: string;
};

export type TargetRecord = {
  target_id: string;
  owner_uid: number;
  label: string;
  description: string;
  implements: string[];
  platform: string;
  version: string;
  online: boolean;
  first_seen_at: number;
  last_seen_at: number;
  connected_at: number | null;
  disconnected_at: number | null;
};

type RawTargetRow = Omit<TargetRecord, "implements" | "online" | "label" | "description"> & {
  implements: string;
  online: number;
  label?: string | null;
  description?: string | null;
};
type TargetMutationResult =
  | { ok: true; created: boolean; device: TargetRecord }
  | { ok: false; error: string };

export class TargetRegistry {
  constructor(private sql: SqlStorage) { }

  register(
    targetId: string,
    ownerUid: number,
    ownerGid: number,
    impl: string[],
    platform: string,
    version: string,
    options: TargetRegisterOptions = {},
  ): TargetMutationResult {
    for (const pattern of impl) {
      if (!isValidCapability(pattern)) {
        return { ok: false, error: `Invalid implements pattern: ${pattern}` };
      }
    }

    const now = Date.now();
    const existing = this.get(targetId);
    const sameOwner = existing?.owner_uid === ownerUid;
    if (existing && !sameOwner) {
      return { ok: false, error: `Device id already belongs to another user: ${targetId}` };
    }
    const label = normalizeDeviceLabel(
      options.label ?? (sameOwner ? existing?.label : undefined),
      targetId,
    );
    const description = normalizeDeviceDescription(
      options.description ?? (sameOwner ? existing?.description : undefined) ?? "",
    );
    if (existing) {
      this.sql.exec(
        `UPDATE targets SET
          owner_uid = ?, label = ?, description = ?, implements = ?, platform = ?, version = ?,
          online = 1, last_seen_at = ?, connected_at = ?, disconnected_at = NULL
        WHERE target_id = ?`,
        ownerUid,
        label,
        description,
        JSON.stringify(impl),
        platform,
        version,
        now,
        now,
        targetId,
      );
    } else {
      this.sql.exec(
        `INSERT INTO targets
          (target_id, owner_uid, label, description, implements, platform, version, online, first_seen_at, last_seen_at, connected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        targetId,
        ownerUid,
        label,
        description,
        JSON.stringify(impl),
        platform,
        version,
        now,
        now,
        now,
      );

      this.sql.exec(
        `INSERT OR IGNORE INTO target_access (target_id, gid) VALUES (?, ?)`,
        targetId,
        ownerGid,
      );
    }

    const device = this.get(targetId);
    if (!device) throw new Error(`Device registration disappeared: ${targetId}`);
    return { ok: true, created: existing === null, device };
  }

  setOnline(targetId: string, online: boolean): void {
    const now = Date.now();
    if (online) {
      this.sql.exec(
        `UPDATE targets SET online = 1, connected_at = ?, disconnected_at = NULL, last_seen_at = ? WHERE target_id = ?`,
        now,
        now,
        targetId,
      );
    } else {
      this.sql.exec(
        `UPDATE targets SET online = 0, disconnected_at = ?, last_seen_at = ? WHERE target_id = ?`,
        now,
        now,
        targetId,
      );
    }
  }

  remove(targetId: string): boolean {
    const existing = this.get(targetId);
    if (!existing) {
      return false;
    }

    this.sql.exec(`DELETE FROM target_access WHERE target_id = ?`, targetId);
    this.sql.exec(`DELETE FROM targets WHERE target_id = ?`, targetId);
    return true;
  }

  get(targetId: string): TargetRecord | null {
    const rows = this.sql.exec<RawTargetRow>(
      `SELECT * FROM targets WHERE target_id = ?`,
      targetId,
    ).toArray();

    if (rows.length === 0) return null;

    return toDeviceRecord(rows[0]);
  }

  listOnline(): TargetRecord[] {
    const rows = this.sql.exec<RawTargetRow>(
      `SELECT * FROM targets WHERE online = 1 ORDER BY target_id`,
    ).toArray();

    return rows.map(toDeviceRecord);
  }

  /**
   * List all targets accessible to a user.
   * uid 0 sees everything. Others see targets they own or have group access to.
   */
  listForUser(uid: number, gids: number[]): TargetRecord[] {
    let rows: RawTargetRow[];

    if (uid === 0) {
      rows = this.sql.exec<RawTargetRow>(
        `SELECT * FROM targets ORDER BY target_id`,
      ).toArray();
    } else if (gids.length > 0) {
      const placeholders = gids.map(() => "?").join(", ");
      rows = this.sql.exec<RawTargetRow>(
        `SELECT DISTINCT d.* FROM targets d
         LEFT JOIN target_access da ON d.target_id = da.target_id
         WHERE d.owner_uid = ? OR da.gid IN (${placeholders})
         ORDER BY d.target_id`,
        uid,
        ...gids,
      ).toArray();
    } else {
      rows = this.sql.exec<RawTargetRow>(
        `SELECT * FROM targets WHERE owner_uid = ? ORDER BY target_id`,
        uid,
      ).toArray();
    }

    return rows.map(toDeviceRecord);
  }

  setDescription(targetId: string, description: string): boolean {
    return this.setMetadata(targetId, { description });
  }

  setMetadata(
    targetId: string,
    patch: { label?: string; description?: string },
  ): boolean {
    const existing = this.get(targetId);
    if (!existing) {
      return false;
    }
    const label = patch.label === undefined
      ? existing.label
      : normalizeDeviceLabel(patch.label, existing.target_id);
    const description = patch.description === undefined
      ? existing.description
      : normalizeDeviceDescription(patch.description);
    this.sql.exec(
      `UPDATE targets SET label = ?, description = ?, last_seen_at = ? WHERE target_id = ?`,
      label,
      description,
      Date.now(),
      targetId,
    );
    return true;
  }

  /**
   * Check whether a user (by gids) is allowed to use a device.
   * uid 0 always has access.
   */
  canAccess(targetId: string, uid: number, gids: number[]): boolean {
    if (uid === 0) return true;

    const device = this.get(targetId);
    if (!device) return false;

    if (device.owner_uid === uid) return true;

    if (gids.length === 0) return false;

    const placeholders = gids.map(() => "?").join(", ");
    const rows = this.sql.exec<{ gid: number }>(
      `SELECT gid FROM target_access WHERE target_id = ? AND gid IN (${placeholders})`,
      targetId,
      ...gids,
    ).toArray();

    return rows.length > 0;
  }

  /**
   * Check whether a device implements a given syscall.
   * Reuses the same matching logic as capabilities.
   */
  canHandle(targetId: string, syscall: string): boolean {
    const device = this.get(targetId);
    if (!device) return false;
    return hasCapability(device.implements, syscall);
  }

  /**
   * Find an online device that implements a syscall and is accessible to the user.
   * Returns null if no suitable device is found.
   */
  findTarget(
    syscall: string,
    uid: number,
    gids: number[],
  ): TargetRecord | null {
    const online = this.listOnline();
    for (const device of online) {
      if (
        hasCapability(device.implements, syscall) &&
        this.canAccess(device.target_id, uid, gids)
      ) {
        return device;
      }
    }
    return null;
  }

  grantAccess(targetId: string, gid: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO target_access (target_id, gid) VALUES (?, ?)`,
      targetId,
      gid,
    );
  }

  revokeAccess(targetId: string, gid: number): void {
    this.sql.exec(
      `DELETE FROM target_access WHERE target_id = ? AND gid = ?`,
      targetId,
      gid,
    );
  }

  listAccess(targetId: string): number[] {
    const rows = this.sql.exec<{ gid: number }>(
      `SELECT gid FROM target_access WHERE target_id = ? ORDER BY gid`,
      targetId,
    ).toArray();
    return rows.map((r) => r.gid);
  }
}

function toDeviceRecord(row: RawTargetRow): TargetRecord {
  return {
    ...row,
    label: normalizeDeviceLabel(row.label ?? "", row.target_id),
    description: row.description ?? "",
    implements: JSON.parse(row.implements),
    online: row.online === 1,
  };
}

function normalizeDeviceLabel(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return (trimmed || fallback).slice(0, 120);
}

function normalizeDeviceDescription(value: string): string {
  return value.trim().slice(0, 500);
}
