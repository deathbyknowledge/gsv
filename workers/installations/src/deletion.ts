import { z } from "zod";
export { InstallationDeletionInventories, installationDeletionManifestDigest, installationDeletionManifestSchema } from "./deletion-inventory";
export type { InstallationDeletionManifest, InstallationDeletionEvidence, InstallationDeletionInventoryResolver, InstallationDeletionInventoryVerification } from "./deletion-inventory";
export { AccountsDeletionOwner, DEFAULT_D1_BACKUP_RETENTION_MS } from "./deletion-owner";
export { AccountsDeletionRuntime, createAccountsDeletionRuntime } from "./deletion-runtime";
export type { AccountsDeletionEnvironment } from "./deletion-runtime";
export { InstallationDeletionHttp } from "./deletion-http";
import {
  installationDeletionReceiptSchema,
  installationDeletionRequestSchema,
  type InstallationDeletionReceipt,
  type InstallationDeletionRequest,
  type InstallationDeletionService,
} from "@humansandmachines/gsv/services/lifecycle";

const inventorySchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  owners: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(64),
});
type Operation = { operation_id: string; installation_id: string; inventory_sha256: string; owners_json: string; phase: "quiescing" | "erasing" | "live-erased" | "erased"; created_at: number; updated_at: number };
type Owner = { owner_id: string; receipt_json: string | null; outcome: string; updated_at: number };
export type InstallationDeletionProgress = {
  operationId: string;
  installationId: string;
  phase: Operation["phase"];
  owners: { id: string; outcome: string; receipt: InstallationDeletionReceipt | null }[];
};

/** Accounts retains the verified owner inventory until every owner confirms erasure. */
export class InstallationDeletionCoordinator {
  constructor(
    private readonly db: D1Database,
    private readonly owners: Readonly<Record<string, InstallationDeletionService>>,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 8_000,
  ) {}

  /** Called by operator administration after reviewing a complete historical inventory. */
  async begin(input: InstallationDeletionRequest, inventory: z.infer<typeof inventorySchema>): Promise<InstallationDeletionProgress> {
    const request = installationDeletionRequestSchema.parse(input);
    const reviewed = inventorySchema.parse(inventory);
    const ids = [...new Set(reviewed.owners)].sort();
    if (ids.length !== reviewed.owners.length || !ids.includes("accounts") || !ids.includes("gateway") || !ids.includes("inference")) {
      throw new Error("Deletion inventory must include each required owner exactly once");
    }
    const now = this.clock();
    await this.db.batch([
      this.db.prepare(`INSERT INTO installation_deletions (operation_id, installation_id, inventory_sha256, owners_json, phase, created_at, updated_at)
        SELECT ?, id, ?, ?, 'quiescing', ?, ? FROM installations
        WHERE id = ? AND state = 'retained'
          AND NOT EXISTS (SELECT 1 FROM installation_reset_participants p JOIN installation_reset_operations r USING(operation_id)
            WHERE r.previous_installation_id = installations.id AND p.state != 'prepared')
        ON CONFLICT DO NOTHING`).bind(request.operationId, reviewed.sha256, JSON.stringify(ids), now, now, request.installationId),
      ...ids.map((id) => this.db.prepare(`INSERT INTO installation_deletion_owners (operation_id, owner_id, updated_at)
        SELECT operation_id, ?, ? FROM installation_deletions WHERE operation_id = ? AND installation_id = ? AND inventory_sha256 = ? AND owners_json = ?
        ON CONFLICT DO NOTHING`).bind(id, now, request.operationId, request.installationId, reviewed.sha256, JSON.stringify(ids))),
    ]);
    const operation = await this.operation(request.operationId);
    if (!operation || operation.installation_id !== request.installationId || operation.inventory_sha256 !== reviewed.sha256 || operation.owners_json !== JSON.stringify(ids)) {
      throw new Error("Deletion requires a retired space with completed reset preparation and a matching operation");
    }
    const persisted = await this.participants(request.operationId);
    if (persisted.map((owner) => owner.owner_id).join("\n") !== ids.join("\n")) throw new Error("Deletion owner inventory changed");
    return this.status(request.operationId);
  }

  async status(operationId: string): Promise<InstallationDeletionProgress> {
    const operation = await this.operation(operationId);
    if (!operation) throw new Error("Deletion operation is unavailable");
    return { operationId, installationId: operation.installation_id, phase: operation.phase,
      owners: (await this.participants(operationId)).map((owner) => ({ id: owner.owner_id, outcome: owner.outcome,
        receipt: owner.receipt_json ? installationDeletionReceiptSchema.parse(JSON.parse(owner.receipt_json)) : null })) };
  }

  async advance(operationId: string): Promise<InstallationDeletionProgress> {
    const operation = await this.operation(operationId);
    if (!operation) throw new Error("Deletion operation is unavailable");
    if (operation.phase === "erased") return this.status(operationId);
    const lease = crypto.randomUUID();
    const now = this.clock();
    const acquired = await this.db.prepare(`UPDATE installation_deletions SET lease_id = ?, lease_until = ?
      WHERE operation_id = ? AND phase != 'erased' AND lease_until <= ?`)
      .bind(lease, now + this.timeoutMs + 30_000, operationId, now).run();
    if (acquired.meta.changes !== 1) return this.status(operationId);
    try {
      const input: InstallationDeletionRequest = { version: 1, operationId, installationId: operation.installation_id };
      const participants = await this.participants(operationId);
      await Promise.all(participants.map(async (participant) => {
        // Directory ownership survives until every external owner has erased its live data.
        if (participant.owner_id === "accounts" && operation.phase !== "quiescing"
          && participants.some((other) => other.owner_id !== "accounts" && (!other.receipt_json
            || phaseRank(installationDeletionReceiptSchema.parse(JSON.parse(other.receipt_json))) < 4))) return;
        const previous = participant.receipt_json ? installationDeletionReceiptSchema.parse(JSON.parse(participant.receipt_json)) : null;
        if (previous?.phase === "erased" || (operation.phase === "quiescing" && previous && isQuiesced(previous))) return;
        const owner = Object.hasOwn(this.owners, participant.owner_id) ? this.owners[participant.owner_id] : undefined;
        if (!owner) { await this.recordOutcome(operationId, participant.owner_id, lease, "missing-owner"); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const call = operation.phase === "quiescing" ? owner.quiesceInstallation(input)
            : previous?.phase === "live-erased" ? owner.installationDeletionStatus(input) : owner.eraseInstallation(input);
          const receipt = installationDeletionReceiptSchema.parse(await Promise.race([call, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Deletion owner timed out")), this.timeoutMs);
          })]));
          if (receipt.operationId !== input.operationId || receipt.installationId !== input.installationId) throw new Error("Deletion owner returned another operation");
          if (previous && phaseRank(receipt) < phaseRank(previous)) throw new Error("Deletion owner regressed its receipt");
          await this.db.prepare(`UPDATE installation_deletion_owners SET receipt_json = ?, outcome = ?, updated_at = ?
            WHERE operation_id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM installation_deletions WHERE operation_id = ? AND lease_id = ?)`)
            .bind(JSON.stringify(receipt), receipt.outcome, this.clock(), operationId, participant.owner_id, operationId, lease).run();
        } catch {
          await this.recordOutcome(operationId, participant.owner_id, lease, "retry");
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }));
      const receipts = (await this.participants(operationId)).map((owner) => owner.receipt_json ? installationDeletionReceiptSchema.parse(JSON.parse(owner.receipt_json)) : null);
      const next = receipts.every((receipt) => receipt?.phase === "erased") ? "erased"
        : receipts.every((receipt) => receipt && phaseRank(receipt) >= 4) ? "live-erased"
          : receipts.every((receipt) => receipt && isQuiesced(receipt)) ? "erasing" : "quiescing";
      await this.db.batch([
        this.db.prepare(`UPDATE installation_deletions SET phase = ?, updated_at = ? WHERE operation_id = ? AND lease_id = ?`)
          .bind(next, this.clock(), operationId, lease),
        this.db.prepare(`UPDATE installation_reset_operations SET data_deletion_state = ?, updated_at = ?, completed_at = ?
          WHERE previous_installation_id = ? AND EXISTS (SELECT 1 FROM installation_deletions WHERE operation_id = ? AND lease_id = ?)`)
          .bind(next === "erased" ? "complete" : "deleting", this.clock(), next === "erased" ? this.clock() : null, input.installationId, operationId, lease),
        this.db.prepare(`DELETE FROM installation_deletion_owners WHERE operation_id = ?
          AND EXISTS (SELECT 1 FROM installation_deletions WHERE operation_id = ? AND phase = 'erased' AND lease_id = ?)`)
          .bind(operationId, operationId, lease),
        this.db.prepare("UPDATE installation_deletions SET owners_json = '[]' WHERE operation_id = ? AND phase = 'erased' AND lease_id = ?")
          .bind(operationId, lease),
      ]);
    } finally {
      await this.db.prepare("UPDATE installation_deletions SET lease_id = NULL, lease_until = 0 WHERE operation_id = ? AND lease_id = ?")
        .bind(operationId, lease).run();
    }
    return this.status(operationId);
  }

  async resumePending(): Promise<void> {
    const pending = await this.db.prepare("SELECT operation_id FROM installation_deletions WHERE phase != 'erased' ORDER BY updated_at, operation_id LIMIT 10")
      .all<{ operation_id: string }>();
    for (const row of pending.results) await this.advance(row.operation_id);
  }

  private operation(operationId: string): Promise<Operation | null> {
    return this.db.prepare("SELECT operation_id, installation_id, inventory_sha256, owners_json, phase, created_at, updated_at FROM installation_deletions WHERE operation_id = ?")
      .bind(operationId).first<Operation>();
  }
  private async participants(operationId: string): Promise<Owner[]> {
    return (await this.db.prepare("SELECT owner_id, receipt_json, outcome, updated_at FROM installation_deletion_owners WHERE operation_id = ? ORDER BY owner_id")
      .bind(operationId).all<Owner>()).results;
  }
  private async recordOutcome(operationId: string, ownerId: string, lease: string, outcome: "retry" | "missing-owner"): Promise<void> {
    await this.db.prepare(`UPDATE installation_deletion_owners SET outcome = ?, updated_at = ? WHERE operation_id = ? AND owner_id = ?
      AND EXISTS (SELECT 1 FROM installation_deletions WHERE operation_id = ? AND lease_id = ?)`)
      .bind(outcome, this.clock(), operationId, ownerId, operationId, lease).run();
  }
}

function phaseRank(receipt: InstallationDeletionReceipt): number {
  return ["pending", "quiescing", "quiesced", "erasing", "live-erased", "erased"].indexOf(receipt.phase);
}
function isQuiesced(receipt: InstallationDeletionReceipt): boolean { return phaseRank(receipt) >= 2; }

export { AccountsDeletionInspections, type DeletionObservationRead, type DeletionInspectionEpoch } from "./deletion-inspections";
