import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionReceipt } from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";

type RetirementRow = { installation_id: string; operation_id: string; phase: "quiescing" | "quiesced" | "erasing" | "erased"; updated_at: number };

/** Created by each owner's versioned migration; survives deletion of user state. */
export const INFERENCE_RETIREMENT_SCHEMA = `CREATE TABLE inference_retirement (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('quiescing', 'quiesced', 'erasing', 'erased')),
  updated_at INTEGER NOT NULL
)`;

export class InferenceRetirement {
  constructor(private readonly storage: DurableObjectStorage, private readonly installationId: string) {}
  get(): RetirementRow | undefined {
    return this.storage.sql.exec<RetirementRow>("SELECT * FROM inference_retirement WHERE singleton = 1").toArray()[0];
  }
  requireLive(): void { if (this.get()) throw new Error("Inference installation is retired"); }
  validate(value: InstallationDeletionRequest): InstallationDeletionRequest {
    const input = installationDeletionRequestSchema.parse(value);
    if (input.installationId !== this.installationId) throw new Error("Inference deletion scope mismatch");
    const existing = this.get();
    if (existing && (existing.operation_id !== input.operationId || existing.installation_id !== input.installationId)) throw new Error("Inference deletion operation is immutable");
    return input;
  }
  begin(value: InstallationDeletionRequest): void {
    const input = this.validate(value);
    this.storage.sql.exec("INSERT OR IGNORE INTO inference_retirement VALUES (1, ?, ?, 'quiescing', ?)", input.installationId, input.operationId, Date.now());
  }
  phase(phase: RetirementRow["phase"]): void {
    this.storage.sql.exec("UPDATE inference_retirement SET phase = ?, updated_at = ? WHERE singleton = 1 AND phase != 'erased'", phase, Date.now());
  }
  receipt(input: InstallationDeletionRequest, pendingResources: number): InstallationDeletionReceipt {
    this.validate(input);
    const row = this.get();
    return { ...input, phase: row?.phase ?? "pending", updatedAt: row?.updated_at ?? Date.now(), pendingResources,
      outcome: row?.phase === "erased" ? "complete" : "progress", retainedCopies: [] };
  }
}

/** Binding props grant deletion; inactive routing alone does not grant authority. */
export async function authorizeInferenceDeletion(
  directory: InstallationDirectoryService,
  props: { authority?: string },
  value: InstallationDeletionRequest,
): Promise<InstallationDeletionRequest> {
  if (props.authority !== "installation-deletion") throw new Error("Inference deletion authority is required");
  const input = installationDeletionRequestSchema.parse(value);
  const identity = await directory.resolveInstallation(input.installationId);
  if (!identity.found || identity.installationId !== input.installationId || !["retained", "deleting", "deleted"].includes(identity.state)) {
    throw new Error("Inference deletion requires a retired installation");
  }
  return input;
}
