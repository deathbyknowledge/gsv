import { migrateExecutor } from "./schema/migrations";

export type TerminalState = "completed" | "error" | "cancelled" | "timeout" | "interrupted";
export type RequestRow = {
  request_id: string;
  local_uid: number | null;
  state: "active" | TerminalState;
  accepted_at: number;
  deadline_at: number;
  expires_at: number;
  month: string | null;
  reserved_tokens: number;
  output_tokens: number;
};

export type ExecutorLimits = {
  monthlyRequests: number;
  monthlyOutputTokens: number;
  maxOutputTokens: number;
  maxDurationMs: number;
};

const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Stores metadata only. Provider input, credentials, and output never enter SQL. */
export class ExecutorStore {
  constructor(private readonly storage: DurableObjectStorage) {
    migrateExecutor(storage);
  }

  installationId(name?: string): string {
    const stored = this.storage.sql.exec<{ installation_id: string }>("SELECT installation_id FROM executor_identity WHERE singleton = 1").toArray()[0]?.installation_id;
    if (stored) {
      if (name && stored !== name) throw new Error("Inference executor identity is immutable");
      return stored;
    }
    if (!name) throw new Error("Inference executor requires a trusted installation route");
    this.storage.sql.exec("INSERT INTO executor_identity VALUES (1, ?)", name);
    return name;
  }

  retired(): boolean { return this.storage.sql.exec("SELECT 1 FROM inference_retirement").toArray().length !== 0; }

  get(id: string): RequestRow | undefined {
    return this.storage.sql.exec<RequestRow>(
      "SELECT * FROM executor_requests WHERE request_id = ?", id,
    ).toArray()[0];
  }

  admit(id: string, uid: number, deadline: number, tokens: number, limits: ExecutorLimits): void {
    this.storage.transactionSync(() => {
      if (this.retired()) throw new Error("Inference installation is retired");
      if (this.get(id)) throw new Error("Inference request identity has already been used");
      const now = Date.now();
      const month = new Date(now).toISOString().slice(0, 7);
      this.storage.sql.exec("INSERT OR IGNORE INTO executor_usage (month) VALUES (?)", month);
      const usage = this.storage.sql.exec<{ requests: number; output_tokens: number; reserved_tokens: number }>(
        "SELECT * FROM executor_usage WHERE month = ?", month,
      ).one();
      if (limits.monthlyRequests !== 0 && usage.requests >= limits.monthlyRequests) throw new Error("Monthly inference request limit reached");
      if (limits.monthlyOutputTokens !== 0 && usage.output_tokens + usage.reserved_tokens + tokens > limits.monthlyOutputTokens) {
        throw new Error("Monthly inference output token limit reached");
      }
      this.storage.sql.exec(
        `INSERT INTO executor_requests
          (request_id, local_uid, state, accepted_at, deadline_at, expires_at, month, reserved_tokens)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
        id, uid, now, deadline, deadline + RETENTION_MS, month, tokens,
      );
      this.storage.sql.exec(
        "UPDATE executor_usage SET requests = requests + 1, reserved_tokens = reserved_tokens + ? WHERE month = ?",
        tokens, month,
      );
    });
  }

  finish(id: string, state: TerminalState, outputTokens?: number): TerminalState {
    return this.storage.transactionSync(() => {
      if (this.retired()) return "cancelled";
      const row = this.get(id);
      if (!row) {
        const now = Date.now();
        this.storage.sql.exec(
          `INSERT INTO executor_requests (request_id, state, accepted_at, deadline_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`, id, state, now, now, now + RETENTION_MS,
        );
        return state;
      }
      if (row.state !== "active") return row.state;
      // Unknown usage after cancellation or restart cannot reopen spent capacity.
      const tokens = outputTokens !== undefined && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : row.reserved_tokens;
      this.storage.sql.exec(
        "UPDATE executor_requests SET state = ?, reserved_tokens = 0, output_tokens = ? WHERE request_id = ? AND state = 'active'",
        state, tokens, id,
      );
      this.storage.sql.exec(
        "UPDATE executor_usage SET reserved_tokens = reserved_tokens - ?, output_tokens = output_tokens + ? WHERE month = ?",
        row.reserved_tokens, tokens, row.month,
      );
      return state;
    });
  }

  recover(): void {
    if (this.retired()) return;
    for (const row of this.storage.sql.exec<RequestRow>("SELECT * FROM executor_requests WHERE state = 'active'").toArray()) {
      this.finish(row.request_id, Date.now() >= row.deadline_at ? "timeout" : "interrupted");
    }
  }

  expire(now: number): string[] {
    if (this.retired()) return [];
    const expired = this.storage.sql.exec<RequestRow>(
      "SELECT * FROM executor_requests WHERE state = 'active' AND deadline_at <= ?", now,
    ).toArray();
    for (const row of expired) this.finish(row.request_id, "timeout");
    this.storage.sql.exec("DELETE FROM executor_requests WHERE state != 'active' AND expires_at <= ?", now);
    const previousMonth = new Date(now);
    previousMonth.setUTCDate(1);
    previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
    this.storage.sql.exec("DELETE FROM executor_usage WHERE month < ? AND reserved_tokens = 0", previousMonth.toISOString().slice(0, 7));
    return expired.map((row) => row.request_id);
  }

  nextAlarm(): number | undefined {
    if (this.retired()) return undefined;
    return this.storage.sql.exec<{ at: number | null }>(
      "SELECT MIN(CASE WHEN state = 'active' THEN deadline_at ELSE expires_at END) AS at FROM executor_requests",
    ).one().at ?? undefined;
  }
}
