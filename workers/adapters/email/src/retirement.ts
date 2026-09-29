import { installationDeletionRequestSchema, type InstallationDeletionReceipt, type InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

export const MAIL_OWNED_TABLES = ["mail_intake_chunks", "mail_intake_uploads", "mail_intakes", "mail_outbound_deliveries", "mail_daily_usage", "mail_installation_identity"] as const;
type Retirement = { installation_id: string; operation_id: string; phase: "quiescing" | "quiesced" | "erasing" | "live-erased"; updated_at: number };
const BACKUP_LIFETIME_MS = 30 * 24 * 60 * 60_000 + 60_000;

/** All continuations share this durable admission fence and abortable body owner. */
export class MailRetirement {
  private active = 0;
  readonly cancellation = new AbortController();
  constructor(private readonly storage: DurableObjectStorage, readonly installationId: string) {}
  get state(): Retirement | undefined { return this.storage.sql.exec<Retirement>("SELECT * FROM mail_retirement WHERE singleton = 1").toArray()[0]; }
  get retired(): boolean { return Boolean(this.state); }
  requireLive(): void { if (this.retired) throw new Error("Mail installation is retired"); }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.requireLive();
    this.active++;
    try { return await work(); } finally { this.active--; }
  }
  validate(value: InstallationDeletionRequest): InstallationDeletionRequest {
    const input = installationDeletionRequestSchema.parse(value);
    if (input.installationId !== this.installationId) throw new Error("Mail deletion identity mismatch");
    const row = this.state;
    if (row && row.operation_id !== input.operationId) throw new Error("Mail deletion operation is immutable");
    return input;
  }
  async quiesce(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    this.validate(input);
    this.storage.sql.exec("INSERT OR IGNORE INTO mail_retirement VALUES (1, ?, ?, 'quiescing', ?)", input.installationId, input.operationId, Date.now());
    this.cancellation.abort(new Error("Mail installation is retired"));
    await this.storage.deleteAlarm();
    if (this.active === 0) this.storage.sql.exec("UPDATE mail_retirement SET phase = 'quiesced', updated_at = ? WHERE singleton = 1 AND phase = 'quiescing'", Date.now());
    return this.status(input);
  }
  async erase(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    await this.quiesce(input);
    const state = this.state!;
    if (state.phase === "quiescing" || state.phase === "live-erased") return this.status(input);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("UPDATE mail_retirement SET phase = 'erasing', updated_at = ? WHERE singleton = 1", Date.now());
      let remaining = 500;
      for (const table of MAIL_OWNED_TABLES) {
        if (remaining <= 0) break;
        const removed = this.storage.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?) RETURNING 1`, remaining).toArray();
        remaining -= removed.length;
      }
      if (!this.countRows()) this.storage.sql.exec("UPDATE mail_retirement SET phase = 'live-erased', updated_at = ? WHERE singleton = 1", Date.now());
    });
    return this.status(input);
  }
  status(input: InstallationDeletionRequest): InstallationDeletionReceipt {
    this.validate(input);
    const row = this.state;
    const base = { ...input, phase: row?.phase ?? "pending", updatedAt: row?.updated_at ?? Date.now(), pendingResources: this.active + this.countRows(), outcome: "progress", retainedCopies: [] } satisfies InstallationDeletionReceipt;
    if (row?.phase === "live-erased") {
      const expiresAt = row.updated_at + BACKUP_LIFETIME_MS;
      return { ...base, phase: Date.now() >= expiresAt ? "erased" : "live-erased", outcome: Date.now() >= expiresAt ? "complete" : "retention-pending", retainedCopies: Date.now() >= expiresAt ? [] : [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }] };
    }
    return base;
  }
  private countRows(): number { return MAIL_OWNED_TABLES.reduce((count, table) => count + this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count, 0); }
}
