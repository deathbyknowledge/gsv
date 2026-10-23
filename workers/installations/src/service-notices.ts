import { z } from "zod";
import type { InstallationAdminAccess } from "./admin/access";
import { hasExpectedOrigin, readJsonObject } from "./http";
import { sha256Hex } from "./tokens";

const noticeInput = z.strictObject({ id: z.string().uuid(), kind: z.enum(["maintenance", "interruption", "security"]),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), installationIds: z.array(z.string().min(1).max(200)).min(1).max(100) });
type Notice = z.infer<typeof noticeInput>;
type Recipient = { principal_id: string; email: string };
export function serviceNoticeContent(notice: Pick<Notice, "kind" | "startsAt" | "endsAt">) {
  const subject = notice.kind === "maintenance" ? "Ship service maintenance" : notice.kind === "interruption" ? "Ship service interruption" : "Ship account security notice";
  const action = notice.kind === "security" ? "Sign in to your Ship and review account access. Contact support if you see activity you do not recognize."
    : "Your Ship is affected. Service may be unavailable during this period. You do not need to change your email preferences.";
  return { subject, text: `${subject}\n\nPeriod: ${notice.startsAt} to ${notice.endsAt}.\n\n${action}\n\nThis essential service notice concerns your account. It contains no product promotions.` };
}
export class ServiceNotices {
  constructor(private readonly db: D1Database) {}
  async audience(input: Notice): Promise<Recipient[]> {
    return (await this.db.prepare(`SELECT DISTINCT p.id AS principal_id,p.primary_email_normalized AS email
      FROM principals p JOIN installations i ON i.owner_principal_id=p.id
      WHERE i.id IN (${input.installationIds.map(() => "?").join(",")}) AND i.state IN ('active','restricted')
        AND p.state='active' AND p.email_verified_at IS NOT NULL ORDER BY p.id`).bind(...input.installationIds).all<Recipient>()).results;
  }
  async preview(input: Notice) {
    if (Date.parse(input.endsAt) < Date.parse(input.startsAt)) throw new Error("invalid_period");
    const recipients = await this.audience(input);
    return { ...serviceNoticeContent(input), recipients, audienceDigest: await sha256Hex(JSON.stringify(recipients)) };
  }
  async enqueue(input: Notice, audienceDigest: string): Promise<void> {
    const preview = await this.preview(input);
    if (preview.audienceDigest !== audienceDigest) throw new Error("audience_changed");
    const hash = await sha256Hex(JSON.stringify({ ...input, installationIds: [...new Set(input.installationIds)].sort() }));
    const existing = await this.db.prepare("SELECT payload_hash FROM service_notices WHERE id=?").bind(input.id).first<{ payload_hash: string }>();
    if (existing && existing.payload_hash !== hash) throw new Error("notice_id_reused");
    if (existing) return;
    const now = Date.now();
    await this.db.batch([
      this.db.prepare("INSERT INTO service_notices(id,kind,starts_at,ends_at,created_at,payload_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .bind(input.id, input.kind, input.startsAt, input.endsAt, now, hash),
      ...[...new Set(input.installationIds)].map(id => this.db.prepare(`INSERT INTO service_notice_targets(notice_id,installation_id)
        SELECT ?,? WHERE EXISTS(SELECT 1 FROM service_notices WHERE id=? AND payload_hash=?) ON CONFLICT DO NOTHING`)
        .bind(input.id, id, input.id, hash)),
      ...preview.recipients.map(row => this.db.prepare(`INSERT INTO service_notice_deliveries(notice_id,principal_id,email,updated_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM service_notices WHERE id=? AND payload_hash=?)
        ON CONFLICT(notice_id,principal_id) DO NOTHING`).bind(input.id, row.principal_id, row.email, now, input.id, hash)),
    ]);
  }
  async deliver(mail: SendEmail, from: string): Promise<void> {
    const rows = await this.db.prepare(`SELECT d.*,n.kind,n.starts_at,n.ends_at FROM service_notice_deliveries d
      JOIN service_notices n ON n.id=d.notice_id WHERE d.state='pending' LIMIT 30`)
      .all<{ notice_id: string; principal_id: string; email: string; kind: Notice["kind"]; starts_at: string; ends_at: string }>();
    for (const row of rows.results) {
      const claimed = await this.db.prepare(`UPDATE service_notice_deliveries SET state='sending',updated_at=? WHERE notice_id=? AND principal_id=? AND state='pending'
        AND EXISTS(SELECT 1 FROM principals p JOIN installations i ON i.owner_principal_id=p.id
          JOIN service_notice_targets t ON t.installation_id=i.id AND t.notice_id=service_notice_deliveries.notice_id
          WHERE p.id=? AND p.primary_email_normalized=? AND p.state='active' AND p.email_verified_at IS NOT NULL AND i.state IN ('active','restricted'))`)
        .bind(Date.now(), row.notice_id, row.principal_id, row.principal_id, row.email).run();
      if (!claimed.meta.changes) {
        await this.db.prepare("UPDATE service_notice_deliveries SET state='cancelled' WHERE notice_id=? AND principal_id=? AND state='pending'")
          .bind(row.notice_id, row.principal_id).run();
        continue;
      }
      let state = "unknown";
      try {
        await mail.send({ from: { email: from, name: "Ship" }, to: row.email,
          ...serviceNoticeContent({ kind: row.kind, startsAt: row.starts_at, endsAt: row.ends_at }) });
        state = "sent";
      } catch { /* The transport may have accepted it. Never automatically repeat an ambiguous send. */ }
      await this.db.prepare("UPDATE service_notice_deliveries SET state=?,updated_at=? WHERE notice_id=? AND principal_id=?")
        .bind(state, Date.now(), row.notice_id, row.principal_id).run();
    }
  }
}
export async function handleServiceNotices(request: Request, db: D1Database, access: InstallationAdminAccess, origin: string, enabled: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/service-notices/")) return null;
  const reply = (value: object, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (url.origin !== origin || !await access.allows(request) || !hasExpectedOrigin(request, origin)) return reply({ error: "forbidden" }, 403);
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  try {
    const body = await readJsonObject(request);
    const { audienceDigest, ...raw } = body;
    const input = noticeInput.parse(raw);
    const notices = new ServiceNotices(db);
    if (url.pathname === "/admin/service-notices/dry-run") return reply(await notices.preview(input));
    if (url.pathname !== "/admin/service-notices/queue") return reply({ error: "not_found" }, 404);
    if (!enabled) return reply({ error: "sending_disabled" }, 503);
    await notices.enqueue(input, z.string().regex(/^[a-f0-9]{64}$/).parse(audienceDigest));
    return reply({ queued: true }, 202);
  } catch { return reply({ error: "invalid_notice_or_changed_audience" }, 400); }
}
