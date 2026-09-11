import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionReceipt, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";

type Tombstone = { installation_id: string; operation_id: string; phase: "quiesced" | "erasing" | "live-erased" | "erased"; updated_at: number; backup_expires_at: number | null };
const TABLES = ["installation_owner_attempts", "installation_onboarding_claims", "memberships", "hostnames", "provisioning_operations", "installation_deletion_inventories", "installation_deletion_observations", "installation_deletion_inspections"] as const;
export const DEFAULT_D1_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 + 60_000;

/** Accounts owns directory rows; shared principals and operator credentials survive. */
export class AccountsDeletionOwner implements InstallationDeletionService {
  constructor(
    private readonly db: D1Database,
    private readonly backupRetentionMs = DEFAULT_D1_BACKUP_RETENTION_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(backupRetentionMs) || backupRetentionMs <= 0) throw new Error("installation backup retention is invalid");
  }

  async quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const request = installationDeletionRequestSchema.parse(input);
    const previous = await this.tombstone(request);
    if (previous) return this.receipt(request, previous);
    const now = this.clock();
    try { await this.db.batch([
      this.db.prepare(`UPDATE installation_onboarding_claims SET revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND EXISTS (SELECT 1 FROM installations WHERE id = ? AND state = 'retained')`).bind(now, request.installationId, request.installationId),
      this.db.prepare(`UPDATE memberships SET state = 'revoked'
        WHERE installation_id = ? AND EXISTS (SELECT 1 FROM installations WHERE id = ? AND state = 'retained')`).bind(request.installationId, request.installationId),
      this.db.prepare(`UPDATE hostnames SET state = 'retired', retired_at = COALESCE(retired_at, ?)
        WHERE installation_id = ? AND EXISTS (SELECT 1 FROM installations WHERE id = ? AND state = 'retained')`).bind(now, request.installationId, request.installationId),
      this.db.prepare(`INSERT INTO installation_account_deletions (installation_id, operation_id, phase, updated_at)
        SELECT id, ?, 'quiesced', ? FROM installations WHERE id = ? AND state = 'retained'
          AND NOT EXISTS (SELECT 1 FROM installation_reset_operations r JOIN installation_reset_participants p USING(operation_id)
            WHERE (r.previous_installation_id = installations.id OR r.replacement_installation_id = installations.id) AND p.state != 'prepared')
        ON CONFLICT DO NOTHING`).bind(request.operationId, now, request.installationId),
    ]); } catch (error) {
      const concurrent = await this.tombstone(request);
      if (concurrent) return this.receipt(request, concurrent);
      throw error;
    }
    const saved = await this.tombstone(request);
    if (!saved) throw new Error("installation deletion requires retirement and completed reset preparation");
    return this.receipt(request, saved);
  }

  async eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const request = installationDeletionRequestSchema.parse(input);
    const previous = await this.tombstone(request);
    if (!previous) throw new Error("installation deletion requires quiescence");
    if (previous.phase === "live-erased" || previous.phase === "erased") return this.installationDeletionStatus(request);
    const external = await this.db.prepare(`SELECT COUNT(*) AS count FROM installation_deletion_owners
      WHERE operation_id = ? AND owner_id != 'accounts' AND (receipt_json IS NULL OR json_extract(receipt_json, '$.phase') NOT IN ('live-erased', 'erased'))`)
      .bind(request.operationId).first<{ count: number }>();
    const operation = await this.db.prepare("SELECT installation_id FROM installation_deletions WHERE operation_id = ?")
      .bind(request.operationId).first<{ installation_id: string }>();
    if (!operation || operation.installation_id !== request.installationId || external?.count !== 0) {
      throw new Error("installation external owner inventory is still required");
    }
    const now = this.clock();
    await this.db.batch([
      this.db.prepare("UPDATE installation_account_deletions SET phase = 'erasing', updated_at = ? WHERE installation_id = ? AND operation_id = ?")
        .bind(now, request.installationId, request.operationId),
      this.db.prepare(`INSERT INTO installation_deleted_operations (operation_id, installation_id)
        SELECT operation_id, installation_id FROM provisioning_operations WHERE installation_id = ? ORDER BY rowid LIMIT 100
        ON CONFLICT DO NOTHING`).bind(request.installationId),
      ...TABLES.map((table) => this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE installation_id = ? ${table === "installation_deletion_inspections"
          ? "AND NOT EXISTS (SELECT 1 FROM installation_deletion_observations WHERE inspection_id = installation_deletion_inspections.id)" : ""}
          ORDER BY rowid LIMIT 100)`)
        .bind(request.installationId)),
      this.db.prepare(`DELETE FROM installation_reset_participants WHERE rowid IN (SELECT p.rowid FROM installation_reset_participants p
        JOIN installation_reset_operations r USING(operation_id) WHERE r.previous_installation_id = ? LIMIT 100)`)
        .bind(request.installationId),
      this.db.prepare(`DELETE FROM installation_reset_operations WHERE rowid IN (SELECT r.rowid FROM installation_reset_operations r
        WHERE previous_installation_id = ?
          AND NOT EXISTS (SELECT 1 FROM installation_reset_participants p WHERE p.operation_id = r.operation_id) LIMIT 100)`)
        .bind(request.installationId),
      this.db.prepare(`UPDATE operator_bootstrap SET installation_id = NULL, handle = NULL, onboarding_token_prefix = NULL,
        onboarding_token_hash = NULL WHERE installation_id = ?`).bind(request.installationId),
    ]);
    if (await this.pendingResources(request.installationId) === 0) {
      await this.db.batch([
        this.db.prepare("DELETE FROM installations WHERE id = ? AND state = 'retained'").bind(request.installationId),
        this.db.prepare(`UPDATE installation_account_deletions SET phase = 'live-erased', updated_at = ?, backup_expires_at = ?
          WHERE installation_id = ? AND operation_id = ? AND NOT EXISTS (SELECT 1 FROM installations WHERE id = ?)`)
          .bind(now, now + this.backupRetentionMs, request.installationId, request.operationId, request.installationId),
      ]);
    }
    return this.installationDeletionStatus(request);
  }

  async installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const request = installationDeletionRequestSchema.parse(input);
    await this.db.prepare(`UPDATE installation_account_deletions SET phase = 'erased', updated_at = ?, backup_expires_at = NULL
      WHERE installation_id = ? AND operation_id = ? AND phase = 'live-erased' AND backup_expires_at <= ?`)
      .bind(this.clock(), request.installationId, request.operationId, this.clock()).run();
    const record = await this.tombstone(request);
    if (!record) throw new Error("installation deletion is unavailable");
    return this.receipt(request, record);
  }

  private async tombstone(input: InstallationDeletionRequest): Promise<Tombstone | null> {
    const record = await this.db.prepare("SELECT * FROM installation_account_deletions WHERE installation_id = ?")
      .bind(input.installationId).first<Tombstone>();
    if (record && record.operation_id !== input.operationId) throw new Error("installation deletion operation does not match");
    return record;
  }

  private async pendingResources(installationId: string): Promise<number> {
    const row = await this.db.prepare(`SELECT ${TABLES.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE installation_id = ?)`).join(" + ")}
      + (SELECT COUNT(*) FROM installation_reset_operations WHERE previous_installation_id = ?) AS count`)
      .bind(...TABLES.map(() => installationId), installationId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  private async receipt(request: InstallationDeletionRequest, record: Tombstone): Promise<InstallationDeletionReceipt> {
    const liveErased = record.phase === "live-erased" || record.phase === "erased";
    return { ...request, phase: record.phase, updatedAt: record.updated_at,
      pendingResources: liveErased ? 0 : 1 + await this.pendingResources(request.installationId),
      outcome: record.phase === "erased" ? "complete" : record.phase === "live-erased" ? "retention-pending" : "progress",
      retainedCopies: record.phase === "live-erased" ? [{ id: "accounts-d1-time-travel", kind: "backup", expiresAt: record.backup_expires_at }] : [],
    };
  }
}
