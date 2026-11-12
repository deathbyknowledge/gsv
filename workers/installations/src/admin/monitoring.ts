import { z } from "zod";
import { operatorUsageSchema, type OperatorShipSnapshot } from "@humansandmachines/gsv/services/operator";
import { parseOpaqueId } from "../domain";

export const DAY_MS = 86_400_000;
export const SEGMENTS = ["never_used", "tried_once", "active", "inactive", "previously_active", "unknown"] as const;
export const OUTREACH_STATUSES = ["not_contacted", "emailed", "replied", "follow_up", "not_applicable"] as const;
export const outreachLabels = {
  not_contacted: "Not contacted", emailed: "Emailed", replied: "Replied", follow_up: "Follow-up needed", not_applicable: "Not applicable",
} satisfies Record<typeof OUTREACH_STATUSES[number], string>;
export const segmentLabels = {
  never_used: "Never used", tried_once: "Tried once", active: "Active", inactive: "Inactive", previously_active: "Previously active", unknown: "Unknown",
} satisfies Record<typeof SEGMENTS[number], string>;
export type UserSegment = typeof SEGMENTS[number];
export type ActivitySummary = {
  capturedAt: number | null; trackedFrom: number | null; firstActiveAt: number | null; lastActiveAt: number | null;
  messages: number | null; tasks: number | null; successfulTasks: number | null; failedTasks: number | null;
  availability: string;
};
export type Outreach = { status: typeof OUTREACH_STATUSES[number]; notes: string; lastContactedAt: number | null; revision: number };
export const outreachInputSchema = z.strictObject({
  status: z.enum(OUTREACH_STATUSES), notes: z.string().max(4000), lastContactedAt: z.number().int().nonnegative().nullable(),
  revision: z.number().int().nonnegative(),
});
export type OutreachUpdate = z.infer<typeof outreachInputSchema>;
export type OutreachEvent = Outreach & { id: string; actor: string; at: number };

export const SEGMENT_SQL = `CASE
  WHEN a.messages IS NULL THEN 'unknown'
  WHEN a.messages = 0 THEN CASE WHEN COALESCE(i.signup_at, i.created_at) >= a.tracked_from THEN 'never_used' ELSE 'unknown' END
  WHEN a.last_active_at >= CAST(strftime('%s','now') AS INTEGER) * 1000 - 604800000 THEN 'active'
  WHEN a.messages = 1 THEN 'tried_once'
  WHEN a.messages >= 5 THEN 'previously_active'
  ELSE 'inactive' END`;

export function userSegment(createdAt: number, activity?: ActivitySummary | null, now = Date.now()): UserSegment {
  if (activity?.messages === null || activity?.messages === undefined) return "unknown";
  if (activity.messages === 0) return activity.trackedFrom !== null && createdAt >= activity.trackedFrom ? "never_used" : "unknown";
  if (activity.lastActiveAt !== null && activity.lastActiveAt >= now - 7 * DAY_MS) return "active";
  if (activity.messages === 1) return "tried_once";
  return activity.messages >= 5 ? "previously_active" : "inactive";
}

export type GrowthOverview = {
  totalUsers: number; newToday: number; newWeek: number; dau: number; wau: number;
  activated: number; activationEligible: number; retained: number; retentionEligible: number;
  monitored: number; latestSync: number | null; days: { day: string; signups: number; activeUsers: number }[];
};

/** Materialized operational metadata, separate from personless product analytics. */
export class AdminMonitoring {
  constructor(private readonly db: Pick<D1Database, "prepare">) {}

  async capture(snapshot: OperatorShipSnapshot): Promise<void> {
    if (!snapshot.usage) return;
    const usage = operatorUsageSchema.parse(snapshot.usage);
    const id = parseOpaqueId(snapshot.installationId, "installationId");
    // Absolute daily counts and capture-time leases make retries and reordered responses safe.
    await this.db.prepare(`INSERT INTO installation_activity_days (installation_id, day, messages, captured_at)
      SELECT i.id, json_extract(d.value, '$.day'), json_extract(d.value, '$.messages'), ?
      FROM json_each(?) d JOIN installations i ON i.id = ? WHERE i.state NOT IN ('retained', 'deleting', 'deleted')
      ON CONFLICT (installation_id, day) DO UPDATE SET messages = excluded.messages, captured_at = excluded.captured_at
      WHERE excluded.captured_at > installation_activity_days.captured_at`)
      .bind(snapshot.capturedAt, JSON.stringify(usage.days), id).run();
    await this.db.prepare(`INSERT INTO installation_activity (installation_id, captured_at, attempted_at, tracked_from,
      first_active_at, last_active_at, messages, tasks, successful_tasks, failed_tasks, aborted_tasks, availability)
      SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok' FROM installations WHERE id = ? AND state NOT IN ('retained', 'deleting', 'deleted')
      ON CONFLICT (installation_id) DO UPDATE SET captured_at = excluded.captured_at, attempted_at = excluded.attempted_at,
      tracked_from = excluded.tracked_from, first_active_at = excluded.first_active_at, last_active_at = excluded.last_active_at,
      messages = excluded.messages, tasks = excluded.tasks, successful_tasks = excluded.successful_tasks,
      failed_tasks = excluded.failed_tasks, aborted_tasks = excluded.aborted_tasks, availability = 'ok'
      WHERE installation_activity.captured_at IS NULL OR excluded.captured_at > installation_activity.captured_at`)
      .bind(snapshot.capturedAt, Date.now(), usage.trackedFrom, usage.firstActiveAt, usage.lastActiveAt,
        usage.messages, usage.tasks, usage.successfulTasks, usage.failedTasks, usage.abortedTasks, id).run();
  }

  async refresh(read: (id: string) => Promise<OperatorShipSnapshot | null>, limit = 25): Promise<number> {
    const rows = await this.db.prepare(`SELECT i.id FROM installations i LEFT JOIN installation_activity a ON a.installation_id = i.id
      WHERE i.state IN ('active', 'restricted') ORDER BY COALESCE(a.attempted_at, 0), i.id LIMIT ?`).bind(limit).all<{ id: string }>();
    let captured = 0;
    for (let offset = 0; offset < rows.results.length; offset += 5) {
      await Promise.all(rows.results.slice(offset, offset + 5).map(async ({ id }) => {
        const snapshot = await read(id);
        if (snapshot?.usage) { await this.capture(snapshot); captured++; }
        else await this.db.prepare(`INSERT INTO installation_activity (installation_id, attempted_at, availability)
          SELECT id, ?, 'unavailable' FROM installations WHERE id = ? AND state IN ('active', 'restricted')
          ON CONFLICT (installation_id) DO UPDATE SET attempted_at = excluded.attempted_at, availability = 'unavailable'`)
          .bind(Date.now(), id).run();
      }));
    }
    return captured;
  }

  async outreach(id: string): Promise<Outreach> {
    return await this.db.prepare(`SELECT status, notes, last_contacted_at AS lastContactedAt, revision
      FROM installation_outreach WHERE installation_id = ?`).bind(id).first<Outreach>()
      ?? { status: "not_contacted", notes: "", lastContactedAt: null, revision: 0 };
  }

  async history(id: string): Promise<OutreachEvent[]> {
    return (await this.db.prepare(`SELECT id, actor, at, status, notes, last_contacted_at AS lastContactedAt, revision
      FROM installation_outreach_history WHERE installation_id = ? ORDER BY revision DESC LIMIT 50`).bind(id).all<OutreachEvent>()).results;
  }

  async saveOutreach(idValue: string, value: OutreachUpdate, actor: string): Promise<void> {
    const id = parseOpaqueId(idValue, "installationId");
    const input = outreachInputSchema.parse(value);
    const saved = await this.db.prepare(`INSERT INTO installation_outreach (installation_id, status, notes, last_contacted_at, revision, updated_at, updated_by)
      SELECT id, ?, ?, ?, 1, ?, ? FROM installations WHERE id = ? AND state IN ('active', 'restricted', 'reserved', 'provisioning') AND ? = 0
      UNION ALL SELECT installation_id, ?, ?, ?, revision + 1, ?, ? FROM installation_outreach WHERE installation_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_outreach.installation_id AND i.state IN ('active', 'restricted', 'reserved', 'provisioning'))
      ON CONFLICT (installation_id) DO UPDATE SET status = excluded.status, notes = excluded.notes,
      last_contacted_at = excluded.last_contacted_at, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      WHERE installation_outreach.revision = ? RETURNING revision`)
      .bind(input.status, input.notes, input.lastContactedAt, Date.now(), actor, id, input.revision,
        input.status, input.notes, input.lastContactedAt, Date.now(), actor, id, input.revision, input.revision).first<{ revision: number }>();
    if (!saved) throw new Error("installation outreach changed; reload before saving");
  }

  async overview(now = Date.now()): Promise<GrowthOverview> {
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    // Count current Ships, including activated operator-issued accounts, without counting retired reset copies.
    const population = `(i.owner_setup = 1 OR i.state IN ('active', 'restricted')) AND i.state NOT IN ('deleted', 'retained', 'deleting', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM installation_reset_operations r WHERE r.previous_installation_id = i.id)`;
    const totals = await this.db.prepare(`SELECT COUNT(*) AS totalUsers,
      COALESCE(SUM(COALESCE(i.signup_at, i.created_at) >= ?),0) AS newToday, COALESCE(SUM(COALESCE(i.signup_at, i.created_at) >= ?),0) AS newWeek,
      COALESCE(SUM(a.last_active_at >= ?),0) AS dau, COALESCE(SUM(a.last_active_at >= ?),0) AS wau,
      COALESCE(SUM(a.messages > 0),0) AS activated,
      COALESCE(SUM(a.messages > 0 OR COALESCE(i.signup_at, i.created_at) >= a.tracked_from),0) AS activationEligible,
      COALESCE(SUM(a.messages IS NOT NULL),0) AS monitored, MAX(a.captured_at) AS latestSync,
      COALESCE(SUM(COALESCE(i.signup_at, i.created_at) < ? AND COALESCE(i.signup_at, i.created_at) >= ? AND COALESCE(i.signup_at, i.created_at) >= a.tracked_from),0) AS retentionEligible,
      COALESCE(SUM(COALESCE(i.signup_at, i.created_at) < ? AND COALESCE(i.signup_at, i.created_at) >= ? AND COALESCE(i.signup_at, i.created_at) >= a.tracked_from AND EXISTS (
        SELECT 1 FROM installation_activity_days d WHERE d.installation_id = i.id AND d.messages > 0
          AND d.day = date(COALESCE(i.signup_at, i.created_at) / 1000, 'unixepoch', '+7 days'))),0) AS retained
      FROM installations i LEFT JOIN installation_activity a ON a.installation_id = i.id WHERE ${population}`)
      .bind(today, now - 7 * DAY_MS, now - DAY_MS, now - 7 * DAY_MS, today - 7 * DAY_MS, today - 90 * DAY_MS, today - 7 * DAY_MS, today - 90 * DAY_MS).first<Omit<GrowthOverview, "days">>();
    const signups = (await this.db.prepare(`SELECT date(COALESCE(i.signup_at, i.created_at) / 1000,'unixepoch') AS day, COUNT(*) AS count
      FROM installations i WHERE ${population} AND COALESCE(i.signup_at, i.created_at) >= ? GROUP BY day`).bind(today - 29 * DAY_MS).all<{ day: string; count: number }>()).results;
    const active = (await this.db.prepare(`SELECT d.day, COUNT(*) AS count FROM installation_activity_days d JOIN installations i ON i.id = d.installation_id
      WHERE ${population} AND d.messages > 0 AND d.day >= ? GROUP BY d.day`).bind(new Date(today - 29 * DAY_MS).toISOString().slice(0, 10)).all<{ day: string; count: number }>()).results;
    const days = Array.from({ length: 30 }, (_, index) => {
      const day = new Date(today - (29 - index) * DAY_MS).toISOString().slice(0, 10);
      return { day, signups: signups.find((row) => row.day === day)?.count ?? 0, activeUsers: active.find((row) => row.day === day)?.count ?? 0 };
    });
    return { ...totals!, days };
  }
}
