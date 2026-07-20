import {
  buildAppDataRunnerName,
  buildAppRunnerName,
} from "../protocol/app-session";
import { canonicalizeLoginUsername } from "../auth/login";
import {
  SHIP_KERNEL_NAME,
  userKernelName,
} from "../shared/kernel-names";

const MAX_PACKAGE_ID_CHARACTERS = 512;
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type AppRuntimeRunnerRecord = {
  runnerName: string;
  ownerUid: number;
  ownerUsername: string;
  kernelOwnerUid: number;
  kernelOwnerUsername: string;
  packageId: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type AppRuntimeKernelOwner = {
  kernelOwnerUid: number;
  kernelOwnerUsername: string;
};

export type AppRuntimeLifecycleTarget = "provisioning" | "suspended" | "retired";

export type AppRuntimeLifecycleFence = {
  ownerUid: number;
  ownerUsername: string;
  sourceKernelName: string;
  generation: number;
  fenceId: string;
  targetLifecycle: AppRuntimeLifecycleTarget;
  createdAt: number;
};

type AppRuntimeRunnerRow = {
  runner_name: string;
  owner_uid: number;
  owner_username: string;
  kernel_owner_uid: number;
  kernel_owner_username: string;
  package_id: string;
  first_seen_at: number;
  last_seen_at: number;
};

type AppRuntimeLifecycleFenceRow = {
  owner_uid: number;
  owner_username: string;
  source_kernel_name: string;
  generation: number;
  fence_id: string;
  target_lifecycle: AppRuntimeLifecycleTarget;
  created_at: number;
};

/** Durable index of authority-bearing AppRunner objects owned by this Kernel. */
export class AppRuntimeRegistry {
  constructor(private readonly sql: SqlStorage) {}

  rememberRunner(input: {
    runnerName: string;
    ownerUid: number;
    ownerUsername: string;
    kernelOwnerUid: number;
    kernelOwnerUsername: string;
    packageId: string;
    seenAt?: number;
  }): AppRuntimeRunnerRecord {
    const identity = normalizeRunnerIdentity(input);
    const seenAt = requireTimestamp(input.seenAt ?? Date.now(), "AppRunner observation");
    this.sql.exec(
      `INSERT INTO app_runtime_runners (
         runner_name, owner_uid, owner_username,
         kernel_owner_uid, kernel_owner_username,
         package_id, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(runner_name) DO UPDATE SET
         last_seen_at = MAX(app_runtime_runners.last_seen_at, excluded.last_seen_at)
       WHERE app_runtime_runners.owner_uid = excluded.owner_uid
         AND app_runtime_runners.owner_username = excluded.owner_username
         AND app_runtime_runners.kernel_owner_uid = excluded.kernel_owner_uid
         AND app_runtime_runners.kernel_owner_username = excluded.kernel_owner_username
         AND app_runtime_runners.package_id = excluded.package_id`,
      identity.runnerName,
      identity.ownerUid,
      identity.ownerUsername,
      identity.kernelOwnerUid,
      identity.kernelOwnerUsername,
      identity.packageId,
      seenAt,
      seenAt,
    );
    const remembered = this.getRunner(identity.runnerName);
    if (
      !remembered
      || remembered.ownerUid !== identity.ownerUid
      || remembered.ownerUsername !== identity.ownerUsername
      || remembered.kernelOwnerUid !== identity.kernelOwnerUid
      || remembered.kernelOwnerUsername !== identity.kernelOwnerUsername
      || remembered.packageId !== identity.packageId
    ) {
      throw new Error("AppRunner registry identity conflict");
    }
    return remembered;
  }

  getRunner(runnerName: string): AppRuntimeRunnerRecord | null {
    const row = this.sql.exec<AppRuntimeRunnerRow>(
      `SELECT runner_name, owner_uid, owner_username,
              kernel_owner_uid, kernel_owner_username,
              package_id, first_seen_at, last_seen_at
       FROM app_runtime_runners
       WHERE runner_name = ?`,
      runnerName,
    ).toArray()[0];
    return row ? mapRunnerRow(row) : null;
  }

  listRunners(kernelOwner?: AppRuntimeKernelOwner): AppRuntimeRunnerRecord[] {
    const normalizedKernelOwner = kernelOwner
      ? normalizeKernelOwner(kernelOwner)
      : null;
    const rows = normalizedKernelOwner === null
      ? this.sql.exec<AppRuntimeRunnerRow>(
          `SELECT runner_name, owner_uid, owner_username,
                  kernel_owner_uid, kernel_owner_username,
                  package_id, first_seen_at, last_seen_at
           FROM app_runtime_runners
           ORDER BY kernel_owner_uid, kernel_owner_username, owner_uid, runner_name`,
        ).toArray()
      : this.sql.exec<AppRuntimeRunnerRow>(
          `SELECT runner_name, owner_uid, owner_username,
                  kernel_owner_uid, kernel_owner_username,
                  package_id, first_seen_at, last_seen_at
           FROM app_runtime_runners
           WHERE kernel_owner_uid = ? AND kernel_owner_username = ?
           ORDER BY owner_uid, runner_name`,
          normalizedKernelOwner.kernelOwnerUid,
          normalizedKernelOwner.kernelOwnerUsername,
        ).toArray();
    return rows.map(mapRunnerRow);
  }

  beginLifecycleFence(input: AppRuntimeLifecycleFence): AppRuntimeLifecycleFence {
    const fence = normalizeLifecycleFence(input);
    const existing = this.getLifecycleFence(fence.ownerUid);
    if (existing) {
      if (sameLifecycleFence(existing, fence)) return existing;
      throw new Error(`A different AppRunner lifecycle fence is active for ${fence.ownerUsername}`);
    }
    this.sql.exec(
      `INSERT INTO app_runtime_lifecycle_fences (
         owner_uid, owner_username, source_kernel_name, generation,
         fence_id, target_lifecycle, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fence.ownerUid,
      fence.ownerUsername,
      fence.sourceKernelName,
      fence.generation,
      fence.fenceId,
      fence.targetLifecycle,
      fence.createdAt,
    );
    const persisted = this.getLifecycleFence(fence.ownerUid);
    if (!persisted || !sameLifecycleFence(persisted, fence)) {
      throw new Error("AppRunner lifecycle fence persistence failed");
    }
    return persisted;
  }

  getLifecycleFence(ownerUid: number): AppRuntimeLifecycleFence | null {
    requireUid(ownerUid);
    const row = this.sql.exec<AppRuntimeLifecycleFenceRow>(
      `SELECT owner_uid, owner_username, source_kernel_name, generation,
              fence_id, target_lifecycle, created_at
       FROM app_runtime_lifecycle_fences
       WHERE owner_uid = ?`,
      ownerUid,
    ).toArray()[0];
    return row ? mapLifecycleFenceRow(row) : null;
  }

  listLifecycleFences(): AppRuntimeLifecycleFence[] {
    return this.sql.exec<AppRuntimeLifecycleFenceRow>(
      `SELECT owner_uid, owner_username, source_kernel_name, generation,
              fence_id, target_lifecycle, created_at
       FROM app_runtime_lifecycle_fences
       ORDER BY owner_uid`,
    ).toArray().map(mapLifecycleFenceRow);
  }

  clearLifecycleFence(expected: AppRuntimeLifecycleFence): boolean {
    const fence = normalizeLifecycleFence(expected);
    const rows = this.sql.exec<{ owner_uid: number }>(
      `DELETE FROM app_runtime_lifecycle_fences
       WHERE owner_uid = ? AND owner_username = ? AND source_kernel_name = ?
         AND generation = ? AND fence_id = ? AND target_lifecycle = ?
         AND created_at = ?
       RETURNING owner_uid`,
      fence.ownerUid,
      fence.ownerUsername,
      fence.sourceKernelName,
      fence.generation,
      fence.fenceId,
      fence.targetLifecycle,
      fence.createdAt,
    ).toArray();
    return rows.length === 1;
  }
}

export function isAppRuntimeRunnerName(
  runnerName: string,
  kernelOwnerUid: number,
  actorUid: number,
  packageId: string,
): boolean {
  try {
    const normalizedKernelOwnerUid = requireUid(kernelOwnerUid);
    const normalizedActorUid = requireUid(actorUid);
    const normalizedPackageId = requirePackageId(packageId);
    return runnerName === buildAppRunnerName(
      normalizedKernelOwnerUid,
      normalizedActorUid,
      normalizedPackageId,
    ) || runnerName === buildAppDataRunnerName(
      normalizedKernelOwnerUid,
      normalizedActorUid,
      normalizedPackageId,
    );
  } catch {
    return false;
  }
}

function normalizeRunnerIdentity(input: {
  runnerName: unknown;
  ownerUid: unknown;
  ownerUsername: unknown;
  kernelOwnerUid: unknown;
  kernelOwnerUsername: unknown;
  packageId: unknown;
}): Omit<AppRuntimeRunnerRecord, "firstSeenAt" | "lastSeenAt"> {
  if (typeof input.runnerName !== "string") {
    throw new Error("AppRunner name is invalid");
  }
  const ownerUid = requireUid(input.ownerUid);
  const ownerUsername = requireCanonicalUsername(input.ownerUsername, "owner");
  const kernelOwnerUid = requireUid(input.kernelOwnerUid);
  const kernelOwnerUsername = requireCanonicalUsername(
    input.kernelOwnerUsername,
    "Kernel owner",
  );
  const packageId = requirePackageId(input.packageId);
  const controlName = buildAppRunnerName(kernelOwnerUid, ownerUid, packageId);
  const dataName = buildAppDataRunnerName(kernelOwnerUid, ownerUid, packageId);
  if (input.runnerName !== controlName && input.runnerName !== dataName) {
    throw new Error("AppRunner name does not match its owner and package");
  }
  return {
    runnerName: input.runnerName,
    ownerUid,
    ownerUsername,
    kernelOwnerUid,
    kernelOwnerUsername,
    packageId,
  };
}

function normalizeKernelOwner(input: AppRuntimeKernelOwner): AppRuntimeKernelOwner {
  return {
    kernelOwnerUid: requireUid(input.kernelOwnerUid),
    kernelOwnerUsername: requireCanonicalUsername(
      input.kernelOwnerUsername,
      "Kernel owner",
    ),
  };
}

function normalizeLifecycleFence(input: AppRuntimeLifecycleFence): AppRuntimeLifecycleFence {
  const ownerUid = requireUid(input.ownerUid);
  const ownerUsername = typeof input.ownerUsername === "string" ? input.ownerUsername : "";
  let expectedKernelName = "";
  try {
    expectedKernelName = userKernelName(ownerUsername);
  } catch {
  }
  if (
    expectedKernelName !== `user:${ownerUsername}`
    || (input.sourceKernelName !== SHIP_KERNEL_NAME
      && input.sourceKernelName !== expectedKernelName)
    || !Number.isSafeInteger(input.generation)
    || input.generation <= 0
    || typeof input.fenceId !== "string"
    || !UUID_RE.test(input.fenceId)
    || !["provisioning", "suspended", "retired"].includes(input.targetLifecycle)
  ) {
    throw new Error("AppRunner lifecycle fence is invalid");
  }
  return {
    ownerUid,
    ownerUsername,
    sourceKernelName: input.sourceKernelName,
    generation: input.generation,
    fenceId: input.fenceId,
    targetLifecycle: input.targetLifecycle,
    createdAt: requireTimestamp(input.createdAt, "AppRunner lifecycle fence"),
  };
}

function requireUid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("AppRunner owner uid is invalid");
  }
  return value as number;
}

function requireCanonicalUsername(value: unknown, label: string): string {
  if (typeof value !== "string" || canonicalizeLoginUsername(value) !== value) {
    throw new Error(`AppRunner ${label} username is invalid`);
  }
  return value;
}

function requirePackageId(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > MAX_PACKAGE_ID_CHARACTERS
  ) {
    throw new Error("AppRunner package id is invalid");
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return value as number;
}

function mapRunnerRow(row: AppRuntimeRunnerRow): AppRuntimeRunnerRecord {
  const identity = normalizeRunnerIdentity({
    runnerName: row.runner_name,
    ownerUid: row.owner_uid,
    ownerUsername: row.owner_username,
    kernelOwnerUid: row.kernel_owner_uid,
    kernelOwnerUsername: row.kernel_owner_username,
    packageId: row.package_id,
  });
  const firstSeenAt = requireTimestamp(row.first_seen_at, "AppRunner first observation");
  const lastSeenAt = requireTimestamp(row.last_seen_at, "AppRunner last observation");
  if (lastSeenAt < firstSeenAt) {
    throw new Error("AppRunner registry timestamps are invalid");
  }
  return { ...identity, firstSeenAt, lastSeenAt };
}

function mapLifecycleFenceRow(row: AppRuntimeLifecycleFenceRow): AppRuntimeLifecycleFence {
  return normalizeLifecycleFence({
    ownerUid: row.owner_uid,
    ownerUsername: row.owner_username,
    sourceKernelName: row.source_kernel_name,
    generation: row.generation,
    fenceId: row.fence_id,
    targetLifecycle: row.target_lifecycle,
    createdAt: row.created_at,
  });
}

function sameLifecycleFence(
  left: AppRuntimeLifecycleFence,
  right: AppRuntimeLifecycleFence,
): boolean {
  return left.ownerUid === right.ownerUid
    && left.ownerUsername === right.ownerUsername
    && left.sourceKernelName === right.sourceKernelName
    && left.generation === right.generation
    && left.fenceId === right.fenceId
    && left.targetLifecycle === right.targetLifecycle
    && left.createdAt === right.createdAt;
}
