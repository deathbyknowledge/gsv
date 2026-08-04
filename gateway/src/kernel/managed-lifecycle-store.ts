import type {
  PrepareManagedInstallationDeletionInput,
} from "@humansandmachines/gsv/protocol";

export type ManagedDeletionRecord = PrepareManagedInstallationDeletionInput & {
  state: "deleting";
  createdAt: number;
};

type ManagedDeletionRow = {
  installation_id: string;
  operation_id: string;
  recoverable_until: number;
  created_at: number;
};

export type ManagedResourceLifecycleKind =
  | "process_suspended"
  | "repository_deleted";

export class ManagedLifecycleStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly installationId: string,
  ) {}

  get(): ManagedDeletionRecord | null {
    const row = this.storage.sql.exec<ManagedDeletionRow>(
      `SELECT installation_id, operation_id, recoverable_until, created_at
       FROM managed_installation_lifecycle
       WHERE record_id = 1`,
    ).toArray()[0];
    return row ? {
      installationId: row.installation_id,
      operationId: row.operation_id,
      recoverableUntil: row.recoverable_until,
      state: "deleting",
      createdAt: row.created_at,
    } : null;
  }

  begin(input: PrepareManagedInstallationDeletionInput): ManagedDeletionRecord {
    assertDeletionInput(input, this.installationId);
    return this.storage.transactionSync(() => {
      const existing = this.get();
      if (existing) {
        if (
          existing.operationId !== input.operationId
          || existing.recoverableUntil !== input.recoverableUntil
        ) {
          throw new Error("managed deletion conflicts with the active operation");
        }
        return existing;
      }
      const createdAt = Date.now();
      this.storage.sql.exec(
        `INSERT INTO managed_installation_lifecycle (
           record_id, installation_id, state, operation_id,
           recoverable_until, created_at
         ) VALUES (1, ?, 'deleting', ?, ?, ?)`,
        this.installationId,
        input.operationId,
        input.recoverableUntil,
        createdAt,
      );
      return { ...input, state: "deleting", createdAt };
    });
  }

  recover(operationId: string): boolean {
    assertOperationId(operationId);
    return this.storage.transactionSync(() => {
      const existing = this.get();
      if (!existing) return false;
      if (existing.operationId !== operationId) {
        throw new Error("managed deletion operation does not match");
      }
      this.storage.sql.exec(
        "DELETE FROM managed_resource_lifecycle WHERE operation_id = ?",
        operationId,
      );
      this.storage.sql.exec(
        "DELETE FROM managed_installation_lifecycle WHERE record_id = 1",
      );
      return true;
    });
  }

  requireDeletion(operationId: string): ManagedDeletionRecord {
    assertOperationId(operationId);
    const record = this.get();
    if (!record || record.operationId !== operationId) {
      throw new Error("managed deletion operation is unavailable");
    }
    return record;
  }

  markResource(
    operationId: string,
    kind: ManagedResourceLifecycleKind,
    resourceId: string,
  ): void {
    this.requireDeletion(operationId);
    if (!resourceId) throw new Error("managed lifecycle resource is invalid");
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO managed_resource_lifecycle (
         operation_id, resource_kind, resource_id, completed_at
       ) VALUES (?, ?, ?, ?)`,
      operationId,
      kind,
      resourceId,
      Date.now(),
    );
  }

  completedResources(
    operationId: string,
    kind: ManagedResourceLifecycleKind,
  ): Set<string> {
    this.requireDeletion(operationId);
    return new Set(this.storage.sql.exec<{ resource_id: string }>(
      `SELECT resource_id
       FROM managed_resource_lifecycle
       WHERE operation_id = ? AND resource_kind = ?`,
      operationId,
      kind,
    ).toArray().map((row) => row.resource_id));
  }
}

function assertDeletionInput(
  input: PrepareManagedInstallationDeletionInput,
  installationId: string,
): void {
  if (input.installationId !== installationId) {
    throw new Error("managed deletion installation does not match Kernel");
  }
  assertOperationId(input.operationId);
  if (
    !Number.isSafeInteger(input.recoverableUntil)
    || input.recoverableUntil < 0
  ) {
    throw new Error("managed deletion recovery deadline is invalid");
  }
}

function assertOperationId(value: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(value)) {
    throw new Error("managed deletion operation is invalid");
  }
}
