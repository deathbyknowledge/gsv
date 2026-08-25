export type UserKernelLifecycle = "provisioning" | "active";

export type UserKernelRecord = {
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  createdAt: number;
  updatedAt: number;
};

type UserKernelRow = {
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  created_at: number;
  updated_at: number;
};

export type UserKernelInstanceMarker = {
  version: 1;
  kind: "user";
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  updatedAt: number;
};

export const USER_KERNEL_INSTANCE_STORAGE_KEY = "gsv/kernel/instance";

/** Master-owned username-to-user-Kernel placement directory. */
export class UserKernelRegistry {
  constructor(private readonly sql: SqlStorage) {}

  get(username: string): UserKernelRecord | null {
    const row = this.sql.exec<UserKernelRow>(
      `SELECT username, uid, lifecycle, created_at, updated_at
       FROM user_kernels
       WHERE username = ?`,
      username,
    ).toArray()[0];
    return row ? mapUserKernelRow(row) : null;
  }

  getByUid(uid: number): UserKernelRecord | null {
    const row = this.sql.exec<UserKernelRow>(
      `SELECT username, uid, lifecycle, created_at, updated_at
       FROM user_kernels
       WHERE uid = ?`,
      uid,
    ).toArray()[0];
    return row ? mapUserKernelRow(row) : null;
  }

  list(lifecycle?: UserKernelLifecycle): UserKernelRecord[] {
    const rows = lifecycle
      ? this.sql.exec<UserKernelRow>(
          `SELECT username, uid, lifecycle, created_at, updated_at
           FROM user_kernels
           WHERE lifecycle = ?
           ORDER BY username`,
          lifecycle,
        ).toArray()
      : this.sql.exec<UserKernelRow>(
          `SELECT username, uid, lifecycle, created_at, updated_at
           FROM user_kernels
           ORDER BY username`,
        ).toArray();
    return rows.map(mapUserKernelRow);
  }

  reserve(username: string, uid: number): UserKernelRecord {
    const existing = this.get(username);
    if (existing) {
      if (existing.uid !== uid) {
        throw new Error(`User Kernel reservation conflicts for ${username}`);
      }
      return existing;
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO user_kernels (
         username, uid, lifecycle, created_at, updated_at
       ) VALUES (?, ?, 'provisioning', ?, ?)`,
      username,
      uid,
      now,
      now,
    );
    return this.get(username)!;
  }

  markActive(username: string): UserKernelRecord {
    const existing = this.get(username);
    if (!existing) {
      throw new Error(`User Kernel is not reserved: ${username}`);
    }
    if (existing.lifecycle === "active") return existing;

    const row = this.sql.exec<UserKernelRow>(
      `UPDATE user_kernels
       SET lifecycle = 'active', updated_at = ?
       WHERE username = ? AND lifecycle = 'provisioning'
       RETURNING username, uid, lifecycle, created_at, updated_at`,
      Date.now(),
      username,
    ).toArray()[0];
    if (!row) {
      throw new Error(`User Kernel activation failed for ${username}`);
    }
    return mapUserKernelRow(row);
  }
}

function mapUserKernelRow(row: UserKernelRow): UserKernelRecord {
  return {
    username: row.username,
    uid: row.uid,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
