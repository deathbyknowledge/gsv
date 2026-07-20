import type { GroupEntry } from "../auth/group";
import type { PasswdEntry } from "../auth/passwd";
import type { AccountIdentityKind } from "./auth-store";
import type { InstalledPackageRecord } from "./packages";

export type UserKernelLifecycle =
  | "legacy"
  | "provisioning"
  | "active"
  | "suspended"
  | "retired";

export type UserKernelRecord = {
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  generation: number;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
};

type UserKernelRow = {
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  generation: number;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
};

export type UserKernelDirectoryAccount = {
  entry: PasswdEntry;
  kind: AccountIdentityKind;
  locked: boolean;
};

export type UserKernelProvisioningSnapshot = {
  version: 1;
  username: string;
  uid: number;
  generation: number;
  /** Master-monotonic authority revision, independent of Kernel generation. */
  projectionRevision: number;
  accounts: UserKernelDirectoryAccount[];
  groups: GroupEntry[];
  personalAgentUid: number | null;
  capabilities: Array<{ gid: number; capability: string }>;
  config: Array<{ key: string; value: string }>;
  packages: InstalledPackageRecord[];
};

export type UserKernelInstanceMarker = {
  version: 1;
  kind: "user";
  username: string;
  uid: number;
  generation: number;
  lifecycle: Exclude<UserKernelLifecycle, "legacy">;
  updatedAt: number;
};

export const USER_KERNEL_INSTANCE_STORAGE_KEY = "gsv/kernel/instance";

export class UserKernelRegistry {
  constructor(private readonly sql: SqlStorage) {}

  get(username: string): UserKernelRecord | null {
    const row = this.sql.exec<UserKernelRow>(
      `SELECT username, uid, lifecycle, generation, created_at, updated_at, retired_at
       FROM user_kernels
       WHERE username = ?`,
      username,
    ).toArray()[0];
    return row ? mapUserKernelRow(row) : null;
  }

  getByUid(uid: number): UserKernelRecord | null {
    const row = this.sql.exec<UserKernelRow>(
      `SELECT username, uid, lifecycle, generation, created_at, updated_at, retired_at
       FROM user_kernels
       WHERE uid = ?`,
      uid,
    ).toArray()[0];
    return row ? mapUserKernelRow(row) : null;
  }

  list(lifecycle?: UserKernelLifecycle): UserKernelRecord[] {
    const rows = lifecycle
      ? this.sql.exec<UserKernelRow>(
          `SELECT username, uid, lifecycle, generation, created_at, updated_at, retired_at
           FROM user_kernels
           WHERE lifecycle = ?
           ORDER BY username`,
          lifecycle,
        ).toArray()
      : this.sql.exec<UserKernelRow>(
          `SELECT username, uid, lifecycle, generation, created_at, updated_at, retired_at
           FROM user_kernels
           ORDER BY username`,
        ).toArray();
    return rows.map(mapUserKernelRow);
  }

  reserve(username: string, uid: number): UserKernelRecord {
    const existing = this.get(username);
    if (existing) {
      if (existing.uid !== uid || existing.lifecycle === "retired") {
        throw new Error(`User Kernel reservation conflicts for ${username}`);
      }
      return existing;
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO user_kernels (
         username, uid, lifecycle, generation, created_at, updated_at, retired_at
       ) VALUES (?, ?, 'provisioning', 1, ?, ?, NULL)`,
      username,
      uid,
      now,
      now,
    );
    return this.get(username)!;
  }

  markActive(username: string, generation: number): UserKernelRecord {
    const existing = this.requireGeneration(username, generation);
    if (existing.lifecycle === "retired") {
      throw new Error(`User Kernel is retired: ${username}`);
    }
    if (existing.lifecycle !== "provisioning" && existing.lifecycle !== "active") {
      throw new Error(`User Kernel cannot activate from ${existing.lifecycle}`);
    }
    if (existing.lifecycle === "active") {
      return existing;
    }
    const row = this.sql.exec<UserKernelRow>(
      `UPDATE user_kernels
       SET lifecycle = 'active', updated_at = ?, retired_at = NULL
       WHERE username = ? AND lifecycle = 'provisioning' AND generation = ?
       RETURNING username, uid, lifecycle, generation, created_at, updated_at, retired_at`,
      Date.now(),
      username,
      generation,
    ).toArray()[0];
    if (!row) {
      throw new Error(`User Kernel activation failed for ${username}`);
    }
    return mapUserKernelRow(row);
  }

  suspend(username: string, expectedGeneration: number): UserKernelRecord {
    const existing = this.requireGeneration(username, expectedGeneration);
    if (existing.lifecycle === "suspended") {
      return existing;
    }
    if (existing.lifecycle !== "active") {
      throw new Error(`User Kernel cannot suspend from ${existing.lifecycle}`);
    }
    const nextGeneration = incrementGeneration(expectedGeneration, username);

    const row = this.sql.exec<UserKernelRow>(
      `UPDATE user_kernels
       SET lifecycle = 'suspended', generation = generation + 1,
           updated_at = ?, retired_at = NULL
       WHERE username = ? AND lifecycle = 'active' AND generation = ?
       RETURNING username, uid, lifecycle, generation, created_at, updated_at, retired_at`,
      Date.now(),
      username,
      expectedGeneration,
    ).toArray()[0];
    if (!row || row.generation !== nextGeneration) {
      throw new Error(`User Kernel suspension failed for ${username}`);
    }
    return mapUserKernelRow(row);
  }

  beginProvisioning(username: string, expectedGeneration: number): UserKernelRecord {
    const existing = this.requireGeneration(username, expectedGeneration);
    if (existing.lifecycle === "provisioning") {
      return existing;
    }
    if (existing.lifecycle !== "legacy" && existing.lifecycle !== "suspended") {
      throw new Error(`User Kernel cannot provision from ${existing.lifecycle}`);
    }

    const row = this.sql.exec<UserKernelRow>(
      `UPDATE user_kernels
       SET lifecycle = 'provisioning', updated_at = ?, retired_at = NULL
       WHERE username = ? AND lifecycle IN ('legacy', 'suspended') AND generation = ?
       RETURNING username, uid, lifecycle, generation, created_at, updated_at, retired_at`,
      Date.now(),
      username,
      expectedGeneration,
    ).toArray()[0];
    if (!row) {
      throw new Error(`User Kernel provisioning transition failed for ${username}`);
    }
    return mapUserKernelRow(row);
  }

  retire(username: string, expectedGeneration: number): UserKernelRecord {
    const existing = this.requireGeneration(username, expectedGeneration);
    if (existing.lifecycle === "retired") {
      return existing;
    }
    const nextGeneration = incrementGeneration(expectedGeneration, username);

    const now = Date.now();
    const row = this.sql.exec<UserKernelRow>(
      `UPDATE user_kernels
       SET lifecycle = 'retired', generation = generation + 1,
           updated_at = ?, retired_at = ?
       WHERE username = ? AND lifecycle <> 'retired' AND generation = ?
       RETURNING username, uid, lifecycle, generation, created_at, updated_at, retired_at`,
      now,
      now,
      username,
      expectedGeneration,
    ).toArray()[0];
    if (!row || row.generation !== nextGeneration || row.retired_at === null) {
      throw new Error(`User Kernel retirement failed for ${username}`);
    }
    return mapUserKernelRow(row);
  }

  private requireGeneration(
    username: string,
    expectedGeneration: number,
    current = this.get(username),
  ): UserKernelRecord {
    if (
      !Number.isSafeInteger(expectedGeneration)
      || expectedGeneration <= 0
      || !current
      || current.generation !== expectedGeneration
    ) {
      throw new Error(`User Kernel generation mismatch for ${username}`);
    }
    return current;
  }
}

function incrementGeneration(generation: number, username: string): number {
  if (
    !Number.isSafeInteger(generation)
    || generation <= 0
    || generation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`User Kernel generation mismatch for ${username}`);
  }
  return generation + 1;
}

function mapUserKernelRow(row: UserKernelRow): UserKernelRecord {
  return {
    username: row.username,
    uid: row.uid,
    lifecycle: row.lifecycle,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}
