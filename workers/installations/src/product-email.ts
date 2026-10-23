import type { OwnerAuthReceipt, OwnerAuthSession } from "./owner-auth-store";
import { Buttondown, suppressedTypes, type Subscriber } from "./product-email-provider";

export const PRODUCT_EMAIL_WORDING_VERSION = "ship-product-updates-2026-10-23";
export const PRODUCT_EMAIL_WORDING = {
  en: "Email me Ship product updates. Optional; unsubscribe at any time.",
  es: "Envíame novedades de Ship por email. Opcional; puedes darte de baja cuando quieras.",
  "pt-BR": "Quero receber novidades do Ship por email. Opcional; cancele quando quiser.",
} as const;
export type ProductEmailLocale = keyof typeof PRODUCT_EMAIL_WORDING;
export type Consent = {
  email: string; principal_id: string | null; revision: number; opted_in: number; suppressed: number;
  source: string; wording_version: string; locale: string; evidence: string | null; updated_at: number;
  provider_ip: string | null; provider_id: string | null; provider_status: string; request_id: string; due_at: number; attempts: number;
  lease_id: string | null; lease_until: number;
};
export type ProductEmailPreference = { revision: number; optedIn: boolean; status: string; suppressed: boolean };
const DAY = 86_400_000;
export function productEmailLocale(value: string): ProductEmailLocale {
  return value === "es" || value === "pt-BR" ? value : "en";
}
export function normalizeProductEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_email");
  return email;
}

/** The row is a durable outbox; revision changes and evidence append in one SQL transaction. */
export class ProductEmailConsent {
  constructor(readonly db: D1Database) {}
  get(email: string): Promise<Consent | null> {
    return this.db.prepare("SELECT * FROM product_email_consent WHERE email=?").bind(normalizeProductEmail(email)).first<Consent>();
  }
  async associate(owner: { principalId: string; email: string }): Promise<void> {
    // Linking an already verified account is not a consent decision and supplies no marketing evidence.
    await this.db.prepare("UPDATE product_email_consent SET principal_id=? WHERE email=? AND principal_id IS NULL")
      .bind(owner.principalId, owner.email).run();
  }
  async preference(email: string): Promise<ProductEmailPreference> {
    const row = await this.get(email);
    return { revision: row?.revision ?? 0, optedIn: row?.opted_in === 1, suppressed: row?.suppressed === 1,
      status: !row?.opted_in ? "off" : row.suppressed ? "suppressed" : row.provider_status === "regular" && row.evidence ? "active" : "pending" };
  }
  private async ensure(email: string, locale: ProductEmailLocale, now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO product_email_consent(email,source,wording_version,locale,updated_at,request_id,due_at)
      VALUES(?,'none',?,?,?, ?,?) ON CONFLICT(email) DO NOTHING`)
      .bind(normalizeProductEmail(email), PRODUCT_EMAIL_WORDING_VERSION, locale, now, crypto.randomUUID(), now).run();
  }
  async stage(challengeId: string, locale: ProductEmailLocale, version: string, now = Date.now(), ip?: string): Promise<void> {
    if (version !== PRODUCT_EMAIL_WORDING_VERSION) throw new Error("consent_wording_changed");
    // Read the authenticated challenge, never a caller-supplied address or verification claim.
    const challenge = await this.db.prepare("SELECT email FROM owner_auth_challenges WHERE id=? AND purpose='login' AND verified_at IS NULL AND expires_at>?")
      .bind(challengeId, now).first<{ email: string }>();
    if (!challenge) return;
    await this.ensure(challenge.email, locale, now);
    await this.db.prepare(`INSERT INTO product_email_intents(challenge_id,email,baseline_revision,locale,wording_version,created_at,provider_ip)
      SELECT ?,email,revision,?,?,?,? FROM product_email_consent WHERE email=? ON CONFLICT(challenge_id) DO NOTHING`)
      .bind(challengeId, locale, version, now, ip ?? null, challenge.email).run();
  }
  async cancelIntent(challengeId: string): Promise<void> {
    await this.db.prepare("DELETE FROM product_email_intents WHERE challenge_id=? AND consumed_at IS NULL").bind(challengeId).run();
  }
  async verified(receipt: Pick<OwnerAuthReceipt, "receiptId" | "principalId" | "email" | "verifiedAt">, now = Date.now()): Promise<void> {
    const evidence = JSON.stringify({ kind: "owner-code", receiptId: receipt.receiptId, verifiedAt: receipt.verifiedAt });
    await this.db.batch([
      this.db.prepare(`UPDATE product_email_consent SET principal_id=?,opted_in=1,revision=revision+1,source='signup',
        wording_version=(SELECT wording_version FROM product_email_intents WHERE challenge_id=?),
        locale=(SELECT locale FROM product_email_intents WHERE challenge_id=?),provider_ip=(SELECT provider_ip FROM product_email_intents WHERE challenge_id=?),evidence=?,updated_at=?,due_at=?,attempts=0,request_id=?
        WHERE email=? AND suppressed=0 AND EXISTS(SELECT 1 FROM product_email_intents i WHERE i.challenge_id=?
          AND i.email=product_email_consent.email AND i.baseline_revision=product_email_consent.revision AND i.consumed_at IS NULL AND i.created_at>?)`)
        .bind(receipt.principalId, receipt.receiptId, receipt.receiptId, receipt.receiptId, evidence, now, now, crypto.randomUUID(), receipt.email, receipt.receiptId, now - DAY),
      this.db.prepare("UPDATE product_email_intents SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL").bind(now, receipt.receiptId),
    ]);
    await this.associate(receipt);
  }
  async finishVerifiedIntents(now = Date.now()): Promise<void> {
    const pending = await this.db.prepare(`SELECT c.id AS receiptId,c.principal_id AS principalId,c.email,c.verified_at AS verifiedAt
      FROM product_email_intents i JOIN owner_auth_challenges c ON c.id=i.challenge_id
      JOIN principals p ON p.id=c.principal_id WHERE i.consumed_at IS NULL AND c.verified_at IS NOT NULL
      AND c.purpose='login' AND p.state='active' AND p.primary_email_normalized=c.email LIMIT 30`)
      .all<Pick<OwnerAuthReceipt, "receiptId" | "principalId" | "email" | "verifiedAt">>();
    for (const receipt of pending.results) await this.verified(receipt, now);
  }
  async set(session: OwnerAuthSession, optedIn: boolean, revision: number, locale: ProductEmailLocale, version: string, now = Date.now(), ip?: string): Promise<ProductEmailPreference> {
    if (optedIn && version !== PRODUCT_EMAIL_WORDING_VERSION) throw new Error("consent_wording_changed");
    await this.ensure(session.email, locale, now);
    const evidence = JSON.stringify({ kind: "owner-session", verifiedAt: session.authenticatedAt });
    const result = await this.db.prepare(`UPDATE product_email_consent SET principal_id=?, opted_in=?,suppressed=CASE WHEN ?=0 THEN 1 ELSE suppressed END,
      revision=revision+1,source='settings',wording_version=?,locale=?,provider_ip=?,evidence=?,updated_at=?,due_at=?,attempts=0,request_id=?
      WHERE email=? AND revision=? AND (?=0 OR suppressed=0)`).bind(session.principalId, Number(optedIn), Number(optedIn),
        PRODUCT_EMAIL_WORDING_VERSION, locale, ip ?? null, evidence, now, now, crypto.randomUUID(), session.email, revision, Number(optedIn)).run();
    if (!result.meta.changes) throw new Error("consent_changed_or_suppressed");
    return this.preference(session.email);
  }
  async publicSignup(email: string, locale: ProductEmailLocale, version: string, now = Date.now(), ip?: string): Promise<void> {
    if (version !== PRODUCT_EMAIL_WORDING_VERSION) throw new Error("consent_wording_changed");
    email = normalizeProductEmail(email);
    await this.ensure(email, locale, now);
    // Anonymous requests cannot change an existing choice, clear suppression, or prove account ownership.
    await this.db.prepare(`UPDATE product_email_consent SET opted_in=1,revision=revision+1,source='website',wording_version=?,locale=?,
      updated_at=?,due_at=?,request_id=?,provider_ip=? WHERE email=? AND revision=0 AND suppressed=0`)
      .bind(version, locale, now, now, crypto.randomUUID(), ip ?? null, email).run();
  }
  async withdraw(email: string, source: string, now = Date.now()): Promise<void> {
    await this.db.prepare(`UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source=?,updated_at=?,due_at=?,attempts=0,request_id=?
      WHERE email=? AND suppressed=0`).bind(source, now, now, crypto.randomUUID(), email).run();
  }
  async observe(row: Consent, subscriber: Subscriber | null, now: number): Promise<void> {
    if (subscriber && (suppressedTypes.has(subscriber.type) || subscriber.email_address.toLowerCase() !== row.email)) {
      await this.withdraw(row.email, "buttondown-withdrawal", now);
      await this.db.prepare("UPDATE product_email_consent SET provider_id=?,provider_status=?,provider_ip=NULL WHERE email=?")
        .bind(subscriber.id, subscriber.type, row.email).run();
      return;
    }
    if (!subscriber && row.provider_id) { await this.withdraw(row.email, "buttondown-deleted", now); return; }
    const confirmed = subscriber?.type === "regular" && (row.provider_status === "unactivated" || subscriber.metadata.ship_consent_request === row.request_id);
    if (confirmed && !row.evidence && row.opted_in && !row.suppressed) {
      await this.db.prepare(`UPDATE product_email_consent SET evidence=?,revision=revision+1,source='buttondown-confirmation',updated_at=?
        WHERE email=? AND revision=? AND opted_in=1 AND suppressed=0`)
        .bind(JSON.stringify({ kind: "buttondown-confirmation", subscriberId: subscriber.id, observedAt: now }), now, row.email, row.revision).run();
    }
    await this.db.prepare(`UPDATE product_email_consent SET provider_id=COALESCE(?,provider_id),provider_status=?,provider_ip=CASE WHEN ? IS NOT NULL THEN NULL ELSE provider_ip END WHERE email=?`)
      .bind(subscriber?.id ?? null, subscriber?.type ?? "absent", subscriber?.id ?? null, row.email).run();
  }
  async processWebhooks(provider: Buttondown, now = Date.now()): Promise<void> {
    const events = await this.db.prepare("SELECT * FROM product_email_webhooks WHERE processed_at IS NULL AND due_at<=? LIMIT 30")
      .bind(now).all<{ id: string; subscriber_id: string; event_type: string; attempts: number }>();
    for (const event of events.results) {
      try {
        const subscriber = await provider.get(event.subscriber_id);
        const row = await this.db.prepare("SELECT * FROM product_email_consent WHERE provider_id=? OR email=? LIMIT 1")
          .bind(event.subscriber_id, subscriber?.email_address.toLowerCase() ?? "").first<Consent>();
        if (row) {
          // A signed withdrawal is monotone even if a delayed creation has made the provider regular again.
          if (event.event_type === "subscriber.unsubscribed") await this.withdraw(row.email, "buttondown-withdrawal", now);
          await this.db.prepare("UPDATE product_email_consent SET due_at=0 WHERE email=?").bind(row.email).run();
        }
        await this.db.prepare("UPDATE product_email_webhooks SET processed_at=? WHERE id=?").bind(now, event.id).run();
      } catch {
        await this.db.prepare("UPDATE product_email_webhooks SET attempts=attempts+1,due_at=? WHERE id=?")
          .bind(now + Math.min(DAY, 30_000 * 2 ** Math.min(event.attempts, 11)), event.id).run();
      }
    }
  }

  /** One lease per address serializes retries; every provider write rechecks the consent revision. */
  async reconcile(provider: Buttondown, now = Date.now(), limit = 30): Promise<void> {
    const due = await this.db.prepare("SELECT email FROM product_email_consent WHERE due_at<=? AND lease_until<=? ORDER BY due_at LIMIT ?")
      .bind(now, now, limit).all<{ email: string }>();
    for (const { email } of due.results) await this.syncOne(provider, email, now);
  }
  private async syncOne(provider: Buttondown, email: string, now: number): Promise<void> {
    const lease = crypto.randomUUID();
    const locked = await this.db.prepare("UPDATE product_email_consent SET lease_id=?,lease_until=? WHERE email=? AND lease_until<=?")
      .bind(lease, now + 120_000, email, now).run();
    if (!locked.meta.changes) return;
    let row = (await this.get(email))!;
    try {
      // A pending verification intent is neither consent nor a request to unsubscribe an existing subscriber.
      if (!row.opted_in && !row.suppressed) {
        await this.db.prepare("UPDATE product_email_consent SET due_at=? WHERE email=? AND revision=? AND lease_id=?")
          .bind(now + DAY, email, row.revision, lease).run();
        return;
      }
      // Defense in depth for identity changes made by older writers or future credential types.
      if (row.principal_id && row.opted_in) {
        const valid = await this.db.prepare("SELECT 1 FROM principals WHERE id=? AND primary_email_normalized=? AND email_verified_at IS NOT NULL AND state='active'")
          .bind(row.principal_id, email).first();
        if (!valid) { await this.withdraw(email, "account-changed", now); row = (await this.get(email))!; }
      }
      let subscriber = await provider.get(row.provider_id ?? email);
      if (subscriber && (suppressedTypes.has(subscriber.type) || subscriber.email_address.toLowerCase() !== email)) {
        await this.observe(row, subscriber, now); row = (await this.get(email))!;
      } else if (!subscriber && row.provider_id) {
        await this.observe(row, null, now); row = (await this.get(email))!;
      }
      const current = (await this.get(email))!;
      if (current.revision !== row.revision || current.lease_id !== lease || current.lease_until <= Date.now()) return;
      if (!row.opted_in || row.suppressed) {
        if (subscriber && !suppressedTypes.has(subscriber.type)) await provider.unsubscribe(subscriber.id, `${row.request_id}-withdraw`);
      } else if (!subscriber) {
        const created = await provider.create(email, Boolean(row.principal_id && row.evidence), row.request_id, row.provider_ip);
        if (created) {
          // Keep the identity even if deletion or withdrawal races the subsequent canonical read.
          row = { ...row, provider_id: created.id };
          await this.db.prepare("UPDATE product_email_consent SET provider_id=? WHERE email=? AND lease_id=?")
            .bind(created.id, email, lease).run();
        }
      }
      // Never promote an existing unactivated/suppressed subscriber to regular. Never replace their tags.
      subscriber = await provider.get(subscriber?.id ?? email);
      const latest = (await this.get(email))!;
      if (latest.revision !== row.revision) {
        // A withdrawal raced an in-flight creation. Compensate immediately; the newer durable job remains due.
        if ((!latest.opted_in || latest.suppressed) && subscriber && !suppressedTypes.has(subscriber.type))
          await provider.unsubscribe(subscriber.id, `${latest.request_id}-withdraw`);
        return;
      }
      await this.observe(row, subscriber, now);
      const after = (await this.get(email))!;
      await this.db.prepare(`UPDATE product_email_consent SET due_at=?,attempts=0,last_error=NULL
        WHERE email=? AND revision=? AND lease_id=?`).bind(now + (subscriber?.type === "unactivated" ? 300_000 : DAY), email,
          // Confirmation changes the evidence revision, but a new withdrawal must stay immediately due.
          after.source === "buttondown-confirmation" ? after.revision : row.revision, lease).run();
    } catch (error) {
      const safe = error instanceof Error && /^buttondown_(http_\d+|invalid_response)$/.test(error.message) ? error.message : "provider_unavailable";
      await this.db.prepare(`UPDATE product_email_consent SET attempts=attempts+1,last_error=?,due_at=? WHERE email=? AND revision=? AND lease_id=?`)
        .bind(safe, now + Math.min(DAY, 30_000 * 2 ** Math.min(row.attempts, 11)), email, row.revision, lease).run();
    } finally {
      await this.db.prepare("UPDATE product_email_consent SET lease_until=0,lease_id=NULL WHERE email=? AND lease_id=?").bind(email, lease).run();
    }
  }
}
