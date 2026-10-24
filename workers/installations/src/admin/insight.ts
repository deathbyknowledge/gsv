import {
  operatorShipSnapshotSchema,
  type OperatorGatewayService,
  type OperatorShipSnapshot,
} from "@humansandmachines/gsv/services/operator";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";

/** Optional operator bindings; without them the Ship page still renders from Accounts alone. */
export type OperatorEnvironment = {
  OPERATOR_GATEWAY?: OperatorGatewayService;
  GSV_MAIL_DOMAIN?: string;
};

export const SHIP_TIMELINE_RUNS = 20;
const HEALTH_TIMEOUT_MS = 3_000;
export const AUDIT_PAGE_SIZE = 50;
const REASON_MAX_LENGTH = 500;

export type ShipOwner = {
  /** Shown in full: operators contact owners from the Ship page. */
  email: string | null;
  operatorIssued: boolean;
  signIn: string[];
};

export type ShipHostname = { hostname: string; kind: "canonical" | "alias"; state: string };

export type ShipContext = {
  owner: ShipOwner;
  mailAddress: string | null;
  hostnames: ShipHostname[];
  audit: OperatorAuditEvent[];
};

export type ShipHealth =
  | { kind: "ok"; snapshot: OperatorShipSnapshot }
  | { kind: "unavailable"; reason: "not connected" | "timed out" | "failed" | "not found" };

export type OperatorAuditEvent = {
  id: string;
  at: number;
  actor: string;
  action: string;
  installationId: string | null;
  handle: string | null;
  detail: Record<string, string> | null;
  reason: string | null;
  outcome: OperatorAuditOutcome;
};

export type OperatorAuditOutcome = "pending" | "completed" | "error";

/** What an audited action reports once it has run. `refused` marks an action that answered with an error. */
export type OperatorAuditResult = { installationId?: string; detail?: Record<string, string>; refused?: boolean };

/**
 * Runs an operator mutation under its audit row; the actor comes from the
 * request's admission. Call it only after the request is admitted.
 */
export type AdminAuditRecorder = <T>(
  request: Request,
  action: { name: string; installationId?: string; reason?: string | null },
  mutation: () => Promise<T>,
  describe?: (result: T) => OperatorAuditResult,
) => Promise<T>;

export type OperatorAuditPage = { events: OperatorAuditEvent[]; page: number; totalPages: number };

type ShipSnapshotSource = Pick<OperatorGatewayService, "operatorShipSnapshot">;

/** Everything the Ship page shows beyond the installation record. */
export class ShipInsight {
  readonly audit: OperatorAuditLog;
  private readonly gateway: ShipSnapshotSource | undefined;
  private readonly mailDomain: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Pick<D1Database, "prepare">,
    options: { gateway?: ShipSnapshotSource; mailDomain?: string; timeoutMs?: number } = {},
  ) {
    this.audit = new OperatorAuditLog(db);
    this.gateway = options.gateway;
    this.mailDomain = options.mailDomain?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  }

  async context(installation: { installationId: string; handle: string }): Promise<ShipContext> {
    const { installationId } = installation;
    const [owner, signIn, hostnames, audit] = await Promise.all([
      this.db.prepare(
        `SELECT p.id, p.primary_email FROM installations i
         JOIN principals p ON p.id = COALESCE((
           SELECT m.principal_id FROM memberships m
           WHERE m.installation_id = i.id AND m.role = 'owner' AND m.state = 'active'
           ORDER BY m.created_at LIMIT 1), i.owner_principal_id)
         WHERE i.id = ?`,
      ).bind(installationId).first<{ id: string; primary_email: string }>(),
      this.db.prepare(
        `SELECT 'email' AS method FROM principal_email_credentials c
         WHERE c.revoked_at IS NULL AND c.principal_id = COALESCE((
           SELECT m.principal_id FROM memberships m
           WHERE m.installation_id = ? AND m.role = 'owner' AND m.state = 'active' ORDER BY m.created_at LIMIT 1),
           (SELECT owner_principal_id FROM installations WHERE id = ?))
         UNION ALL
         SELECT e.issuer AS method FROM principal_external_identities e
         WHERE e.principal_id = COALESCE((
           SELECT m.principal_id FROM memberships m
           WHERE m.installation_id = ? AND m.role = 'owner' AND m.state = 'active' ORDER BY m.created_at LIMIT 1),
           (SELECT owner_principal_id FROM installations WHERE id = ?))`,
      ).bind(installationId, installationId, installationId, installationId).all<{ method: string }>(),
      this.db.prepare(
        `SELECT normalized_hostname, kind, state FROM hostnames
         WHERE installation_id = ? AND state != 'retired'
         ORDER BY kind = 'canonical' DESC, normalized_hostname`,
      ).bind(installationId).all<{ normalized_hostname: string; kind: ShipHostname["kind"]; state: string }>(),
      this.audit.list({ installationId, page: 1, pageSize: 10 }),
    ]);
    // Operator registry principals use reserved addresses until an owner links the Ship.
    const operatorIssued = !owner || owner.primary_email.endsWith("@gsv.invalid");
    return {
      owner: {
        email: owner && !operatorIssued ? owner.primary_email : null,
        operatorIssued,
        signIn: signIn.results.map((row) => signInLabel(row.method)),
      },
      mailAddress: this.mailDomain ? `${installation.handle}@${this.mailDomain}` : null,
      hostnames: hostnames.results.map((row) => ({ hostname: row.normalized_hostname, kind: row.kind, state: row.state })),
      audit: audit.events,
    };
  }

  async health(installationId: string): Promise<ShipHealth> {
    if (!this.gateway) return { kind: "unavailable", reason: "not connected" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.gateway.operatorShipSnapshot({ version: 1, installationId, runLimit: SHIP_TIMELINE_RUNS }),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.timeoutMs); }),
      ]);
      if (result === "timeout") return { kind: "unavailable", reason: "timed out" };
      if (!result.found) return { kind: "unavailable", reason: "not found" };
      const snapshot = operatorShipSnapshotSchema.safeParse(result.snapshot);
      if (!snapshot.success || snapshot.data.installationId !== installationId) {
        return { kind: "unavailable", reason: "failed" };
      }
      return { kind: "ok", snapshot: snapshot.data };
    } catch (error) {
      console.warn("[Operator] Ship snapshot failed:", exceptionDiagnostics(error));
      return { kind: "unavailable", reason: "failed" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Append-only record of operator actions. */
export class OperatorAuditLog {
  constructor(private readonly db: Pick<D1Database, "prepare">) {}

  /**
   * Writes the row before the mutation runs: if it cannot be written, nothing
   * changes. A committed mutation is reported as done even when its outcome
   * cannot be written afterwards; its row then stays `pending`.
   */
  async run<T>(
    input: { actor: string; action: string; installationId?: string; reason?: string | null },
    mutation: () => Promise<T>,
    describe?: (result: T) => OperatorAuditResult,
  ): Promise<T> {
    const id = `audit_${crypto.randomUUID()}`;
    const reason = input.reason?.trim().slice(0, REASON_MAX_LENGTH) || null;
    await this.db.prepare(
      `INSERT INTO operator_audit_events (id, at, actor, action, installation_id, reason, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).bind(id, Date.now(), input.actor.slice(0, 256), input.action, input.installationId ?? null, reason).run();
    let result: T;
    try {
      result = await mutation();
    } catch (error) {
      await this.finish(id, { refused: true });
      throw error;
    }
    await this.finish(id, describe?.(result) ?? {});
    return result;
  }

  private async finish(id: string, result: OperatorAuditResult): Promise<void> {
    try {
      await this.db.prepare(
        `UPDATE operator_audit_events
         SET outcome = ?, installation_id = COALESCE(installation_id, ?), detail_json = ?
         WHERE id = ?`,
      ).bind(result.refused ? "error" : "completed", result.installationId ?? null,
        result.detail ? JSON.stringify(result.detail) : null, id).run();
    } catch (error) {
      // The row already records the action; it stays `pending` and the page says so.
      console.warn("[Operator] Audit outcome not recorded:", id, exceptionDiagnostics(error));
    }
  }

  async list(input: { installationId?: string; page: number; pageSize?: number }): Promise<OperatorAuditPage> {
    if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("page is invalid");
    const pageSize = input.pageSize ?? AUDIT_PAGE_SIZE;
    const where = input.installationId ? "WHERE a.installation_id = ?" : "";
    const bindings = input.installationId ? [input.installationId] : [];
    const [count, rows] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) AS total FROM operator_audit_events a ${where}`)
        .bind(...bindings).first<{ total: number }>(),
      this.db.prepare(
        `SELECT a.id, a.at, a.actor, a.action, a.installation_id, a.detail_json, a.reason, a.outcome, i.handle
         FROM operator_audit_events a LEFT JOIN installations i ON i.id = a.installation_id
         ${where} ORDER BY a.at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      ).bind(...bindings, pageSize, (input.page - 1) * pageSize).all<{
        id: string; at: number; actor: string; action: string; installation_id: string | null;
        detail_json: string | null; reason: string | null; outcome: OperatorAuditOutcome; handle: string | null;
      }>(),
    ]);
    // SAFETY: detail_json is only written by finish() from a Record<string, string>.
    return {
      page: input.page,
      totalPages: Math.max(1, Math.ceil((count?.total ?? 0) / pageSize)),
      events: rows.results.map((row) => ({
        id: row.id, at: row.at, actor: row.actor, action: row.action, installationId: row.installation_id,
        handle: row.handle, detail: row.detail_json ? JSON.parse(row.detail_json) as Record<string, string> : null,
        reason: row.reason, outcome: row.outcome,
      })),
    };
  }
}

function signInLabel(method: string): string {
  if (method === "email") return "email";
  try { return new URL(method).hostname; }
  catch { return method; }
}
