export type InstalledUserKernelProjection = {
  username: string;
  uid: number;
  kernelGeneration: number;
  revision: number;
  digest: string;
};

export type PackageProjectionFence = {
  fenceId: string;
  kernelGeneration: number;
  startedAt: number;
};

type ProjectionStateRow = {
  master_revision: number;
  pending_master_revision: number | null;
  installed_username: string | null;
  installed_uid: number | null;
  installed_kernel_generation: number | null;
  installed_revision: number | null;
  installed_digest: string | null;
  package_fence_id: string | null;
  package_fence_generation: number | null;
  package_fence_started_at: number | null;
};

/** Durable projection ordering/fence state shared by Master and user Kernels. */
export class KernelProjectionState {
  constructor(private readonly sql: SqlStorage) {}

  masterRevision(): number {
    const row = this.requireRow();
    return requirePositiveInteger(row.master_revision, "Master projection revision");
  }

  pendingMasterRevision(): number | null {
    const pending = this.requireRow().pending_master_revision;
    return pending === null
      ? null
      : requirePositiveInteger(pending, "Pending Master projection revision");
  }

  /**
   * A crash can leave authoritative mutations partially committed. Promoting
   * the reserved revision makes the resulting persisted state a new snapshot
   * rather than ever serving it under the preceding revision.
   */
  recoverPendingMasterRevision(): number {
    const row = this.requireRow();
    if (row.pending_master_revision === null) {
      return requirePositiveInteger(row.master_revision, "Master projection revision");
    }
    const pending = requirePositiveInteger(
      row.pending_master_revision,
      "Pending Master projection revision",
    );
    if (pending <= row.master_revision) {
      throw new Error("Pending Master projection revision is invalid");
    }
    this.sql.exec(
      `UPDATE kernel_projection_state
       SET master_revision = ?, pending_master_revision = NULL
       WHERE id = 1 AND master_revision = ? AND pending_master_revision = ?`,
      pending,
      row.master_revision,
      pending,
    );
    return this.masterRevision();
  }

  beginMasterMutation(): number {
    const row = this.requireRow();
    if (row.pending_master_revision !== null) {
      throw new Error("A Master projection mutation is already in progress");
    }
    const current = requirePositiveInteger(row.master_revision, "Master projection revision");
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Master projection revision is exhausted");
    }
    const next = current + 1;
    const updated = this.sql.exec<{ pending_master_revision: number }>(
      `UPDATE kernel_projection_state
       SET pending_master_revision = ?
       WHERE id = 1 AND master_revision = ? AND pending_master_revision IS NULL
       RETURNING pending_master_revision`,
      next,
      current,
    ).toArray()[0];
    if (updated?.pending_master_revision !== next) {
      throw new Error("Master projection mutation reservation failed");
    }
    return next;
  }

  commitMasterMutation(expectedRevision: number): number {
    requirePositiveInteger(expectedRevision, "Expected Master projection revision");
    const updated = this.sql.exec<{ master_revision: number }>(
      `UPDATE kernel_projection_state
       SET master_revision = pending_master_revision,
           pending_master_revision = NULL
       WHERE id = 1 AND pending_master_revision = ?
       RETURNING master_revision`,
      expectedRevision,
    ).toArray()[0];
    if (updated?.master_revision !== expectedRevision) {
      throw new Error("Master projection mutation commit failed");
    }
    return expectedRevision;
  }

  installed(): InstalledUserKernelProjection | null {
    const row = this.requireRow();
    const fields = [
      row.installed_username,
      row.installed_uid,
      row.installed_kernel_generation,
      row.installed_revision,
      row.installed_digest,
    ];
    if (fields.every((field) => field === null)) return null;
    if (
      typeof row.installed_username !== "string"
      || !row.installed_username
      || row.installed_uid === null
      || row.installed_kernel_generation === null
      || row.installed_revision === null
      || typeof row.installed_digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(row.installed_digest)
    ) {
      throw new Error("Installed user Kernel projection state is incomplete");
    }
    return {
      username: row.installed_username,
      uid: requireNonNegativeInteger(row.installed_uid, "Installed projection uid"),
      kernelGeneration: requirePositiveInteger(
        row.installed_kernel_generation,
        "Installed projection generation",
      ),
      revision: requirePositiveInteger(row.installed_revision, "Installed projection revision"),
      digest: row.installed_digest,
    };
  }

  recordInstalled(input: InstalledUserKernelProjection): void {
    requireNonNegativeInteger(input.uid, "Installed projection uid");
    requirePositiveInteger(input.kernelGeneration, "Installed projection generation");
    requirePositiveInteger(input.revision, "Installed projection revision");
    if (!/^sha256:[0-9a-f]{64}$/.test(input.digest)) {
      throw new Error("Installed projection digest is invalid");
    }
    if (!input.username) throw new Error("Installed projection username is required");
    this.sql.exec(
      `UPDATE kernel_projection_state
       SET installed_username = ?, installed_uid = ?,
           installed_kernel_generation = ?, installed_revision = ?,
           installed_digest = ?
       WHERE id = 1`,
      input.username,
      input.uid,
      input.kernelGeneration,
      input.revision,
      input.digest,
    );
  }

  packageFence(): PackageProjectionFence | null {
    const row = this.requireRow();
    const fields = [
      row.package_fence_id,
      row.package_fence_generation,
      row.package_fence_started_at,
    ];
    if (fields.every((field) => field === null)) return null;
    if (
      typeof row.package_fence_id !== "string"
      || !row.package_fence_id
      || row.package_fence_generation === null
      || row.package_fence_started_at === null
    ) {
      throw new Error("Package projection fence state is incomplete");
    }
    return {
      fenceId: row.package_fence_id,
      kernelGeneration: requirePositiveInteger(
        row.package_fence_generation,
        "Package projection fence generation",
      ),
      startedAt: requirePositiveInteger(
        row.package_fence_started_at,
        "Package projection fence timestamp",
      ),
    };
  }

  enterPackageFence(input: PackageProjectionFence): void {
    if (!input.fenceId) throw new Error("Package projection fence id is required");
    requirePositiveInteger(input.kernelGeneration, "Package projection fence generation");
    requirePositiveInteger(input.startedAt, "Package projection fence timestamp");
    const current = this.packageFence();
    if (current) {
      if (
        current.fenceId === input.fenceId
        && current.kernelGeneration === input.kernelGeneration
      ) {
        return;
      }
      throw new Error("A package projection fence is already active");
    }
    this.sql.exec(
      `UPDATE kernel_projection_state
       SET package_fence_id = ?, package_fence_generation = ?,
           package_fence_started_at = ?
       WHERE id = 1 AND package_fence_id IS NULL`,
      input.fenceId,
      input.kernelGeneration,
      input.startedAt,
    );
    const persisted = this.packageFence();
    if (
      persisted?.fenceId !== input.fenceId
      || persisted.kernelGeneration !== input.kernelGeneration
    ) {
      throw new Error("Package projection fence persistence failed");
    }
  }

  clearPackageFence(fenceId: string, kernelGeneration: number): boolean {
    const result = this.sql.exec(
      `UPDATE kernel_projection_state
       SET package_fence_id = NULL, package_fence_generation = NULL,
           package_fence_started_at = NULL
       WHERE id = 1 AND package_fence_id = ? AND package_fence_generation = ?`,
      fenceId,
      kernelGeneration,
    );
    return result.rowsWritten === 1;
  }

  private requireRow(): ProjectionStateRow {
    const row = this.sql.exec<ProjectionStateRow>(
      `SELECT master_revision, pending_master_revision,
              installed_username, installed_uid, installed_kernel_generation,
              installed_revision, installed_digest, package_fence_id, package_fence_generation,
              package_fence_started_at
       FROM kernel_projection_state WHERE id = 1`,
    ).toArray()[0];
    if (!row) throw new Error("Kernel projection state is missing");
    return row;
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
