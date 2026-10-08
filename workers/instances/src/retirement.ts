import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionReceipt } from "@humansandmachines/gsv/services/lifecycle";

type Retirement = { operation_id: string; phase: "quiescing" | "quiesced" | "erasing" | "erased"; updated_at: number };
const BACKUP_RETENTION_MS = 30 * 86400_000 + 60_000;

/** The deletion tombstone survives all browser, profile, and diagnostic records. */
export class InstanceRetirement {
  constructor(private readonly storage: DurableObjectStorage, private readonly installationId: string) {}
  get(): Retirement | undefined { return this.storage.sql.exec<Retirement>("SELECT * FROM retirement WHERE singleton = 1").toArray()[0]; }
  requireLive(): void { if (this.get()) throw new Error("Browser installation is retired"); }
  validate(raw: InstallationDeletionRequest): InstallationDeletionRequest {
    const input = installationDeletionRequestSchema.parse(raw);
    if (input.installationId !== this.installationId) throw new Error("Browser deletion scope mismatch");
    const previous = this.get();
    if (previous && previous.operation_id !== input.operationId) throw new Error("Browser deletion operation is immutable");
    return input;
  }
  begin(raw: InstallationDeletionRequest): void {
    const input = this.validate(raw);
    this.storage.sql.exec("INSERT OR IGNORE INTO retirement VALUES (1, ?, 'quiescing', ?)", input.operationId, Date.now());
  }
  phase(phase: Retirement["phase"]): void {
    this.storage.sql.exec("UPDATE retirement SET phase = ?, updated_at = ? WHERE singleton = 1 AND phase != 'erased'", phase, Date.now());
  }
  receipt(raw: InstallationDeletionRequest, pendingResources: number): InstallationDeletionReceipt {
    const input = this.validate(raw), row = this.get();
    const expiresAt = row?.phase === "erased" ? row.updated_at + BACKUP_RETENTION_MS : null;
    const retained = expiresAt !== null && Date.now() < expiresAt;
    return { ...input, phase: retained ? "live-erased" : row?.phase ?? "pending", updatedAt: row?.updated_at ?? Date.now(), pendingResources,
      outcome: retained ? "retention-pending" : row?.phase === "erased" ? "complete" : "progress",
      retainedCopies: retained ? [{ id: "browser-durable-object-backup", kind: "backup", expiresAt }] : [] };
  }
}
