import type {
  CommandExecutionRecord,
  CommandManifest,
  IssuedCommandRecord,
} from "../syscalls/system";

type CommandRow = {
  command_id: string;
  issuer_uid: number;
  created_at: number;
  manifest_json: string;
  digest_alg: string;
  digest_value: string;
  signature_alg: string | null;
  signature_key_id: string | null;
  signature_value: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  claimed_by_uid: number | null;
  claim_count: number;
  last_executed_at: number | null;
};

type ExecutionRow = {
  execution_id: string;
  command_id: string;
  executor_uid: number;
  invoked_at: number;
  pid: string;
  run_id: string | null;
  route_kind: "connection" | "adapter" | "none";
  route_ref_json: string | null;
  status: "started" | "completed" | "failed";
  error: string | null;
};

export class CommandStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        command_id        TEXT PRIMARY KEY,
        issuer_uid        INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        manifest_json     TEXT NOT NULL,
        digest_alg        TEXT NOT NULL,
        digest_value      TEXT NOT NULL,
        signature_alg     TEXT,
        signature_key_id  TEXT,
        signature_value   TEXT,
        revoked_at        INTEGER,
        revoked_reason    TEXT,
        claimed_by_uid    INTEGER,
        claim_count       INTEGER NOT NULL DEFAULT 0,
        last_executed_at  INTEGER
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_commands_issuer
      ON commands(issuer_uid, created_at)
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS command_executions (
        execution_id    TEXT PRIMARY KEY,
        command_id      TEXT NOT NULL,
        executor_uid    INTEGER NOT NULL,
        invoked_at      INTEGER NOT NULL,
        pid             TEXT NOT NULL,
        run_id          TEXT,
        route_kind      TEXT NOT NULL,
        route_ref_json  TEXT,
        status          TEXT NOT NULL,
        error           TEXT
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_command_executions_command
      ON command_executions(command_id, invoked_at)
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_command_executions_run_id
      ON command_executions(run_id)
    `);
  }

  async issue(issuerUid: number, manifest: CommandManifest): Promise<IssuedCommandRecord> {
    const commandId = crypto.randomUUID();
    const createdAt = Date.now();
    const canonicalManifest = canonicalizeManifest(manifest);
    const manifestJson = stableStringify(canonicalManifest);
    const digestValue = await sha256Hex(manifestJson);

    this.sql.exec(
      `INSERT INTO commands
       (command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
        signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
        claimed_by_uid, claim_count, last_executed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
      commandId,
      issuerUid,
      createdAt,
      manifestJson,
      "sha256",
      digestValue,
    );

    const record = this.get(commandId);
    if (!record) {
      throw new Error(`Failed to read issued command: ${commandId}`);
    }
    return record;
  }

  get(commandId: string): IssuedCommandRecord | null {
    const row = this.sql.exec<CommandRow>(
      `SELECT command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
              signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
              claimed_by_uid, claim_count, last_executed_at
       FROM commands
       WHERE command_id = ?
       LIMIT 1`,
      commandId,
    ).toArray()[0];

    return row ? toIssuedCommand(row) : null;
  }

  list(options?: { issuerUid?: number; includeRevoked?: boolean }): IssuedCommandRecord[] {
    const includeRevoked = options?.includeRevoked === true;
    const issuerUid = options?.issuerUid;

    let rows: CommandRow[];
    if (typeof issuerUid === "number") {
      rows = this.sql.exec<CommandRow>(
        includeRevoked
          ? `SELECT command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
                    signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
                    claimed_by_uid, claim_count, last_executed_at
             FROM commands
             WHERE issuer_uid = ?
             ORDER BY created_at DESC`
          : `SELECT command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
                    signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
                    claimed_by_uid, claim_count, last_executed_at
             FROM commands
             WHERE issuer_uid = ? AND revoked_at IS NULL
             ORDER BY created_at DESC`,
        issuerUid,
      ).toArray();
    } else {
      rows = this.sql.exec<CommandRow>(
        includeRevoked
          ? `SELECT command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
                    signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
                    claimed_by_uid, claim_count, last_executed_at
             FROM commands
             ORDER BY created_at DESC`
          : `SELECT command_id, issuer_uid, created_at, manifest_json, digest_alg, digest_value,
                    signature_alg, signature_key_id, signature_value, revoked_at, revoked_reason,
                    claimed_by_uid, claim_count, last_executed_at
             FROM commands
             WHERE revoked_at IS NULL
             ORDER BY created_at DESC`,
      ).toArray();
    }

    return rows.map(toIssuedCommand);
  }

  revoke(commandId: string, reason?: string): boolean {
    const existing = this.get(commandId);
    if (!existing || existing.revokedAt !== null) {
      return false;
    }

    this.sql.exec(
      `UPDATE commands
       SET revoked_at = ?, revoked_reason = ?
       WHERE command_id = ?`,
      Date.now(),
      reason?.trim() || null,
      commandId,
    );
    return true;
  }

  markClaim(commandId: string, uid: number): void {
    const record = this.get(commandId);
    if (!record) {
      throw new Error(`Command not found: ${commandId}`);
    }

    this.sql.exec(
      `UPDATE commands
       SET claimed_by_uid = ?, claim_count = ?
       WHERE command_id = ?`,
      record.claimedByUid ?? uid,
      record.claimCount + 1,
      commandId,
    );
  }

  markExecuted(commandId: string, at = Date.now()): void {
    this.sql.exec(
      `UPDATE commands SET last_executed_at = ? WHERE command_id = ?`,
      at,
      commandId,
    );
  }

  addExecution(input: {
    commandId: string;
    executorUid: number;
    pid: string;
    runId: string | null;
    routeKind: "connection" | "adapter" | "none";
    routeRef?: Record<string, string>;
    status: "started" | "completed" | "failed";
    error?: string;
  }): CommandExecutionRecord {
    const executionId = crypto.randomUUID();
    const invokedAt = Date.now();
    this.sql.exec(
      `INSERT INTO command_executions
       (execution_id, command_id, executor_uid, invoked_at, pid, run_id, route_kind, route_ref_json, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      executionId,
      input.commandId,
      input.executorUid,
      invokedAt,
      input.pid,
      input.runId,
      input.routeKind,
      input.routeRef ? JSON.stringify(input.routeRef) : null,
      input.status,
      input.error ?? null,
    );

    return {
      executionId,
      commandId: input.commandId,
      executorUid: input.executorUid,
      invokedAt,
      pid: input.pid,
      runId: input.runId,
      routeKind: input.routeKind,
      routeRef: input.routeRef,
      status: input.status,
      error: input.error,
    };
  }

  completeExecutionByRunId(runId: string, error?: string): boolean {
    const existing = this.sql.exec<{ execution_id: string }>(
      `SELECT execution_id FROM command_executions
       WHERE run_id = ?
       ORDER BY invoked_at DESC
       LIMIT 1`,
      runId,
    ).toArray()[0];

    if (!existing) {
      return false;
    }

    this.sql.exec(
      `UPDATE command_executions
       SET status = ?, error = ?
       WHERE execution_id = ?`,
      error ? "failed" : "completed",
      error ?? null,
      existing.execution_id,
    );
    return true;
  }
}

function toIssuedCommand(row: CommandRow): IssuedCommandRecord {
  const manifest = JSON.parse(row.manifest_json) as CommandManifest;
  const signature =
    row.signature_alg && row.signature_key_id && row.signature_value
      ? {
          alg: row.signature_alg as "ed25519",
          keyId: row.signature_key_id,
          value: row.signature_value,
        }
      : undefined;

  return {
    commandId: row.command_id,
    issuerUid: row.issuer_uid,
    createdAt: row.created_at,
    manifest,
    digest: {
      alg: row.digest_alg as "sha256",
      value: row.digest_value,
    },
    signature,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    claimedByUid: row.claimed_by_uid,
    claimCount: row.claim_count,
    lastExecutedAt: row.last_executed_at,
  };
}

function canonicalizeManifest(manifest: CommandManifest): CommandManifest {
  return JSON.parse(stableStringify(manifest)) as CommandManifest;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      out[key] = sortValue(item);
    }
    return out;
  }

  return value;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(digest);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type { ExecutionRow };
