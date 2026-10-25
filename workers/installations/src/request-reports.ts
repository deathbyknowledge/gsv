import { WorkerEntrypoint } from "cloudflare:workers";
import type { RequestReportCategory } from "@humansandmachines/gsv/protocol/syscalls/approach";
import {
  requestReportSubmissionSchema,
  type RequestReportReceipt,
  type RequestReportService,
  type RequestReportSubmission,
} from "@humansandmachines/gsv/services/reports";

const REPORT_PAGE_SIZE = 50;

export type RequestReportState = "open" | "closed";
export type RequestReportResolution = "dismissed" | "taken-down";

/** One report in the operator's queue. */
export type RequestReport = {
  id: string;
  installationId: string;
  /** The reporting Ship's handle. */
  handle: string | null;
  sender: { did: string; handle: string | null };
  category: RequestReportCategory;
  /** The sender's name and message as the person saw them, when they chose to include them. */
  message: { displayName: string; text: string } | null;
  receivedAt: number;
  reportedAt: number;
  /** The operator action that closed the report, by its audit event. */
  closed: { at: number; resolution: RequestReportResolution; eventId: string } | null;
};

export type RequestReportPage = {
  state: RequestReportState;
  reports: RequestReport[];
  page: number;
  totalPages: number;
  counts: Record<RequestReportState, number>;
};

type ReportRow = {
  id: string;
  installation_id: string;
  handle: string | null;
  sender_did: string;
  sender_handle: string | null;
  category: RequestReportCategory;
  received_at: number;
  reported_at: number;
} & (
  | { sender_name: string; message_text: string }
  | { sender_name: null; message_text: null }
) & (
  | { closed_at: number; resolution: RequestReportResolution; closed_by: string }
  | { closed_at: null; resolution: null; closed_by: null }
);

const REPORT_COLUMNS = `r.id, r.installation_id, i.handle, r.sender_did, r.sender_handle, r.sender_name, r.message_text,
  r.category, r.received_at, r.reported_at, r.closed_at, r.resolution, r.closed_by`;

/**
 * The operator's queue of message requests a Ship's person reported. The
 * Kernel files a report only when its person chooses Report; the operator
 * closes it by dismissing it or by taking the sender down.
 */
export class RequestReports {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Files a request's report once: filing it again returns the first report unchanged. */
  async submit(input: RequestReportSubmission): Promise<RequestReportReceipt> {
    const report = requestReportSubmissionSchema.parse(input);
    const [, filed] = await this.db.batch<{ id: string; reported_at: number }>([
      this.db.prepare(`INSERT INTO request_reports
        (id, installation_id, request_key, sender_did, sender_handle, sender_name, message_text, category, received_at, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (installation_id, request_key) DO NOTHING`)
        .bind(`report_${crypto.randomUUID()}`, report.installationId, report.requestKey, report.sender.did, report.sender.handle ?? null,
          report.message?.displayName ?? null, report.message?.text ?? null, report.category, report.receivedAtMs, this.clock()),
      this.db.prepare("SELECT id, reported_at FROM request_reports WHERE installation_id = ? AND request_key = ?")
        .bind(report.installationId, report.requestKey),
    ]);
    const row = filed?.results[0];
    if (!row) throw new Error("request report was not filed");
    return { reportId: row.id, reportedAtMs: row.reported_at };
  }

  async list(input: { state: RequestReportState; page: number; pageSize?: number }): Promise<RequestReportPage> {
    if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("page is invalid");
    const pageSize = input.pageSize ?? REPORT_PAGE_SIZE;
    const order = input.state === "open" ? "WHERE r.closed_at IS NULL ORDER BY r.reported_at DESC" : "WHERE r.closed_at IS NOT NULL ORDER BY r.closed_at DESC";
    const [counts, rows] = await Promise.all([
      this.db.prepare(`SELECT COALESCE(SUM(closed_at IS NULL), 0) AS open, COALESCE(SUM(closed_at IS NOT NULL), 0) AS closed
        FROM request_reports`).first<Record<RequestReportState, number>>(),
      this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM request_reports r LEFT JOIN installations i ON i.id = r.installation_id
        ${order}, r.rowid DESC LIMIT ? OFFSET ?`).bind(pageSize, (input.page - 1) * pageSize).all<ReportRow>(),
    ]);
    const total = counts ?? { open: 0, closed: 0 };
    return {
      state: input.state,
      reports: rows.results.map(requestReport),
      page: input.page,
      totalPages: Math.max(1, Math.ceil(total[input.state] / pageSize)),
      counts: total,
    };
  }

  async get(id: string): Promise<RequestReport | null> {
    const row = await this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM request_reports r
      LEFT JOIN installations i ON i.id = r.installation_id WHERE r.id = ?`).bind(id).first<ReportRow>();
    return row ? requestReport(row) : null;
  }

  /** How many open reports name a sender. */
  async openReportsOf(senderDid: string): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM request_reports WHERE sender_did = ? AND closed_at IS NULL")
      .bind(senderDid).first<{ count: number }>();
    return row?.count ?? 0;
  }

  /** Closes an open report the operator dismissed, under the audit event that records it. */
  async dismiss(id: string, eventId: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE request_reports SET closed_at = ?, resolution = 'dismissed', closed_by = ?
      WHERE id = ? AND closed_at IS NULL`).bind(this.clock(), eventId, id).run();
    if (result.meta.changes > 0) return;
    const exists = await this.db.prepare("SELECT 1 AS found FROM request_reports WHERE id = ?").bind(id).first();
    throw new Error(exists ? "request names a report that is already closed" : "request names no report");
  }

  /** Closes every open report of a sender the operator took down, under the takedown's audit event. */
  async closeTakenDown(senderDid: string, eventId: string): Promise<number> {
    const result = await this.db.prepare(`UPDATE request_reports SET closed_at = ?, resolution = 'taken-down', closed_by = ?
      WHERE sender_did = ? AND closed_at IS NULL`).bind(this.clock(), eventId, senderDid).run();
    return result.meta.changes;
  }
}

/** Only the Kernel's deployment-granted binding may file a person's report. */
export class RequestReportsEntrypoint extends WorkerEntrypoint<{ INSTALLATIONS_DB: D1Database }, { authority: "kernel-report" }>
  implements RequestReportService {
  async submitRequestReport(input: RequestReportSubmission): Promise<RequestReportReceipt> {
    if (this.ctx.props?.authority !== "kernel-report") throw new Error("Request report authority is required");
    return await new RequestReports(this.env.INSTALLATIONS_DB).submit(input);
  }
}

function requestReport(row: ReportRow): RequestReport {
  return {
    id: row.id,
    installationId: row.installation_id,
    handle: row.handle,
    sender: { did: row.sender_did, handle: row.sender_handle },
    category: row.category,
    message: row.sender_name === null ? null : { displayName: row.sender_name, text: row.message_text },
    receivedAt: row.received_at,
    reportedAt: row.reported_at,
    closed: row.closed_at === null ? null : { at: row.closed_at, resolution: row.resolution, eventId: row.closed_by },
  };
}
