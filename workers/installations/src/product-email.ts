import { z } from "zod";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { PrincipalRecord } from "./store";
import type { ProductEmailService } from "@humansandmachines/gsv/services/product-email";

export const productEmailChoice = z.strictObject({
  wordingVersion: z.literal("ship-product-updates-2026-10-26"),
  locale: z.enum(["en", "es", "pt-BR"]),
});
export type ProductEmailChoice = z.infer<typeof productEmailChoice>;
export type ProductEmailEnvironment = { PRODUCT_EMAIL?: ProductEmailService };
type Signup = {
  email: string; request_id: string; wording_version: string; locale: string; requested_at: number;
  ip: string | null; source: "ship-signup" | "ship-existing-user-backfill"; consented_at: number | null;
  consent_basis: "signup-checkbox" | "operator-confirmed-existing-opt-ins"; import_id: string | null;
};

/** Signup has already authorized this verified owner. An address already queued keeps its first request, so replays never create another. */
export async function queueProductEmail(db: D1Database, owner: PrincipalRecord, choice: ProductEmailChoice, ip?: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`INSERT INTO product_email_signups(email,principal_id,request_id,source,consent_basis,consented_at,
      wording_version,locale,requested_at,verified_at,ip,due_at)
    VALUES(?,?,?,'ship-signup','signup-checkbox',?,?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING`)
    .bind(owner.email.trim().toLowerCase(), owner.id, crypto.randomUUID(), now, choice.wordingVersion, choice.locale, now, owner.emailVerifiedAt, ip ?? null, now).run();
}

/** Accounts owns durable delivery; the optional service owns provider semantics. */
export async function runProductEmailJobs(db: D1Database, env: ProductEmailEnvironment): Promise<void> {
  const service = env.PRODUCT_EMAIL;
  if (!service) return;
  // Discard unsent requests whose verified owner or address no longer exists.
  await db.prepare(`DELETE FROM product_email_signups WHERE completed_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id=principal_id AND p.state='active'
      AND p.primary_email_normalized=product_email_signups.email AND p.email_verified_at IS NOT NULL)`).run();
  const now = Date.now();
  const pending = await db.prepare(`SELECT * FROM product_email_signups WHERE completed_at IS NULL AND due_at<=?
    ORDER BY due_at LIMIT 30`)
    .bind(now).all<Signup>();
  for (const row of pending.results) {
    const claim = await db.prepare(`UPDATE product_email_signups SET attempts=attempts+1,due_at=?
      WHERE email=? AND request_id=? AND completed_at IS NULL AND due_at<=? AND EXISTS (
        SELECT 1 FROM principals p WHERE p.id=principal_id AND p.state='active'
          AND p.primary_email_normalized=product_email_signups.email AND p.email_verified_at IS NOT NULL) RETURNING attempts`)
      .bind(Date.now() + 120_000, row.email, row.request_id, now).first<{ attempts: number }>();
    if (!claim) continue;
    try {
      await service.subscribe({ requestId: row.request_id, emailAddress: row.email, recordedAt: row.requested_at,
        consentedAt: row.consented_at, source: row.source, consentBasis: row.consent_basis,
        wordingVersion: row.source === "ship-signup" ? row.wording_version : null,
        locale: row.locale === "und" ? null : row.locale, importId: row.import_id, ipAddress: row.ip ?? undefined });
      await db.prepare(`UPDATE product_email_signups SET completed_at=?,ip=NULL,last_error=NULL WHERE email=? AND request_id=? AND attempts=?`)
        .bind(Date.now(), row.email, row.request_id, claim.attempts).run();
    } catch (cause) {
      await db.prepare("UPDATE product_email_signups SET due_at=?,last_error=? WHERE email=? AND request_id=? AND attempts=?")
        .bind(Date.now() + Math.min(86_400_000, 30_000 * 2 ** Math.min(claim.attempts - 1, 11)),
          JSON.stringify({ diagnosticId: crypto.randomUUID(), ...exceptionDiagnostics(cause) }), row.email, row.request_id, claim.attempts).run();
    }
  }
}

