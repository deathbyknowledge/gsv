import type { OperatorUsage } from "@humansandmachines/gsv/services/operator";

export type OwnerRequestActivity = { messageId: string; runId: string; at: number };

/** Operational counts belong to this installation; no message text leaves the Kernel. */
export class OperatorActivityStore {
  constructor(private readonly sql: SqlStorage) {}

  receive(input: OwnerRequestActivity): void {
    this.sql.exec(`INSERT INTO operator_owner_requests (run_id, message_id, received_at) VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING`, input.runId, input.messageId, input.at);
  }

  finish(runId: string, outcome: "ok" | "error" | "aborted", at: number): void {
    this.sql.exec(`UPDATE operator_owner_requests SET finished_at = ?, outcome = ?
      WHERE run_id = ? AND finished_at IS NULL`, at, outcome, runId);
  }

  snapshot(now = Date.now()): OperatorUsage {
    const totals = this.sql.exec<{ firstActiveAt: number | null; lastActiveAt: number | null; messages: number;
      tasks: number; successfulTasks: number; failedTasks: number; abortedTasks: number }>(`SELECT
      MIN(received_at) AS firstActiveAt, MAX(received_at) AS lastActiveAt, COUNT(*) AS messages,
      COUNT(finished_at) AS tasks, COALESCE(SUM(outcome = 'ok'), 0) AS successfulTasks,
      COALESCE(SUM(outcome = 'error'), 0) AS failedTasks, COALESCE(SUM(outcome = 'aborted'), 0) AS abortedTasks
      FROM operator_owner_requests`).one();
    const trackedFrom = this.sql.exec<{ tracked_from: number }>("SELECT tracked_from FROM operator_activity_epoch WHERE id = 1").one().tracked_from;
    const days = this.sql.exec<{ day: string; messages: number }>(`SELECT date(received_at / 1000, 'unixepoch') AS day,
      COUNT(*) AS messages FROM operator_owner_requests WHERE received_at >= ? GROUP BY day ORDER BY day`, now - 90 * 86_400_000).toArray();
    return { trackedFrom, ...totals, days };
  }
}
