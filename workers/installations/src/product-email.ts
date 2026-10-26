import { z } from "zod";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { PrincipalRecord } from "./store";

export const productEmailChoice = z.strictObject({
  wordingVersion: z.literal("ship-product-updates-2026-10-26"),
  locale: z.enum(["en", "es", "pt-BR"]),
});
export type ProductEmailChoice = z.infer<typeof productEmailChoice>;
export type ProductEmailEnvironment = { GSV_PRODUCT_EMAIL_ENABLED?: string; BUTTONDOWN_API_KEY?: string };
type Signup = { email: string; request_id: string; wording_version: string; locale: string; requested_at: number; ip: string | null };

/** Signup has already authorized this verified owner. Replays never create another subscription request. */
export async function queueProductEmail(db: D1Database, owner: PrincipalRecord, choice: ProductEmailChoice, ip?: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`INSERT INTO product_email_signups(email,principal_id,request_id,wording_version,locale,requested_at,verified_at,ip,due_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING`)
    .bind(owner.email, owner.id, crypto.randomUUID(), choice.wordingVersion, choice.locale, now, owner.emailVerifiedAt, ip ?? null, now).run();
}

/** Buttondown owns subscriber status and unsubscribe handling; Accounts only delivers explicit signup requests. */
export async function runProductEmailJobs(db: D1Database, env: ProductEmailEnvironment, fetcher: typeof fetch = fetch): Promise<void> {
  if (env.GSV_PRODUCT_EMAIL_ENABLED !== "true" || !env.BUTTONDOWN_API_KEY) return;
  // Discard unsent requests whose verified owner or address no longer exists.
  await db.prepare(`DELETE FROM product_email_signups WHERE completed_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id=principal_id AND p.state='active'
      AND p.primary_email_normalized=product_email_signups.email AND p.email_verified_at IS NOT NULL)`).run();
  const now = Date.now();
  const pending = await db.prepare("SELECT * FROM product_email_signups WHERE completed_at IS NULL AND due_at<=? ORDER BY due_at LIMIT 30")
    .bind(now).all<Signup>();
  for (const row of pending.results) {
    const claim = await db.prepare(`UPDATE product_email_signups SET attempts=attempts+1,due_at=?
      WHERE email=? AND request_id=? AND completed_at IS NULL AND due_at<=? AND EXISTS (
        SELECT 1 FROM principals p WHERE p.id=principal_id AND p.state='active'
          AND p.primary_email_normalized=product_email_signups.email AND p.email_verified_at IS NOT NULL) RETURNING attempts`)
      .bind(Date.now() + 120_000, row.email, row.request_id, now).first<{ attempts: number }>();
    if (!claim) continue;
    try {
      const headers = { Authorization: `Token ${env.BUTTONDOWN_API_KEY}`, "Content-Type": "application/json",
        "X-API-Version": "2026-04-01" };
      const endpoint = "https://api.buttondown.com/v1/subscribers";
      const existing = await fetcher(`${endpoint}/${encodeURIComponent(row.email)}`, { headers, signal: AbortSignal.timeout(15_000) });
      await existing.body?.cancel();
      if (existing.status === 404) {
        const response = await fetcher(endpoint, { method: "POST", headers: { ...headers, "X-Idempotency-Key": row.request_id }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ email_address: row.email, type: "regular", ip_address: row.ip ?? undefined,
            metadata: { source: "ship-signup", wording_version: row.wording_version, locale: row.locale, requested_at: row.requested_at } }) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`buttondown_http_${response.status}`);
      } else if (!existing.ok) throw new Error(`buttondown_http_${existing.status}`);
      // Existing subscribers, including unsubscribed/blocked addresses, are never changed.
      await db.prepare(`UPDATE product_email_signups SET completed_at=?,ip=NULL,last_error=NULL WHERE email=? AND request_id=? AND attempts=?`)
        .bind(Date.now(), row.email, row.request_id, claim.attempts).run();
    } catch (cause) {
      await db.prepare("UPDATE product_email_signups SET due_at=?,last_error=? WHERE email=? AND request_id=? AND attempts=?")
        .bind(Date.now() + Math.min(86_400_000, 30_000 * 2 ** Math.min(claim.attempts - 1, 11)),
          JSON.stringify({ diagnosticId: crypto.randomUUID(), ...exceptionDiagnostics(cause) }), row.email, row.request_id, claim.attempts).run();
    }
  }
}
