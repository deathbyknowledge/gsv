import { z } from "zod";
import { readRequestBody } from "./http";
import { sha256Hex } from "./tokens";
import { ProductEmailConsent, productEmailLocale, PRODUCT_EMAIL_WORDING_VERSION } from "./product-email";
import { Buttondown, verifyButtondownSignature } from "./product-email-provider";

export type ProductEmailEnvironment = {
  GSV_PRODUCT_EMAIL_ENABLED?: string;
  GSV_PRODUCT_EMAIL_WEBSITE_ORIGIN?: string;
  BUTTONDOWN_API_KEY?: string;
  BUTTONDOWN_SIGNING_KEY?: string;
  BUTTONDOWN_NEWSLETTER_ID?: string;
  GSV_SERVICE_NOTICES_ENABLED?: string;
};
export async function runProductEmailJobs(db: D1Database, env: ProductEmailEnvironment): Promise<void> {
  if (env.GSV_PRODUCT_EMAIL_ENABLED === "true") {
    const consent = new ProductEmailConsent(db);
    await consent.finishVerifiedIntents();
    if (env.BUTTONDOWN_API_KEY) {
      const provider = new Buttondown(env.BUTTONDOWN_API_KEY);
      await consent.processWebhooks(provider);
      await consent.reconcile(provider);
    }
    await db.prepare("DELETE FROM product_email_rate_limits WHERE window<?").bind(Math.floor(Date.now() / 3_600_000) - 24).run();
  }
}

/** Website and no-JS forms use this same authority. Neither can assert verified ownership. */
export async function handleProductEmailPublic(request: Request, db: D1Database, env: ProductEmailEnvironment, origin: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["/product-email/subscribe", "/product-email/buttondown"].includes(url.pathname)) return null;
  const reply = (data: object, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
  if (url.origin !== origin) return reply({ error: "not_found" }, 404);
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (env.GSV_PRODUCT_EMAIL_ENABLED !== "true") return reply({ error: "unavailable" }, 503);
  const consent = new ProductEmailConsent(db);
  try {
    const body = await readRequestBody(request, 16_384);
    if (url.pathname === "/product-email/buttondown") {
      if (!await verifyButtondownSignature(body, request.headers.get("X-Buttondown-Signature"), env.BUTTONDOWN_SIGNING_KEY ?? ""))
        return reply({ error: "invalid_signature" }, 401);
      const event = z.object({ id: z.string().min(1).max(200).optional(), event_type: z.string(),
        data: z.object({ newsletter: z.string(), subscriber: z.string().min(1).max(200) }) }).parse(JSON.parse(new TextDecoder().decode(body)));
      if (!env.BUTTONDOWN_NEWSLETTER_ID || event.data.newsletter !== env.BUTTONDOWN_NEWSLETTER_ID) return reply({ error: "wrong_newsletter" }, 403);
      // The provider does not sign a timestamp. Durable event/body deduplication handles replays.
      // Payloads are hints only: out-of-order events cannot set consent or reactivate anyone.
      const id = event.id ?? await sha256Hex(new TextDecoder().decode(body));
      await db.batch([
        db.prepare(`UPDATE product_email_consent SET due_at=0 WHERE provider_id=?
          AND NOT EXISTS(SELECT 1 FROM product_email_webhooks WHERE id=?)`).bind(event.data.subscriber, id),
        db.prepare(`UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source='buttondown-withdrawal',
          updated_at=?,due_at=0,attempts=0,request_id=? WHERE provider_id=? AND suppressed=0 AND ?='subscriber.unsubscribed'
          AND NOT EXISTS(SELECT 1 FROM product_email_webhooks WHERE id=?)`).bind(Date.now(), crypto.randomUUID(), event.data.subscriber, event.event_type, id),
        db.prepare("INSERT INTO product_email_webhooks(id,received_at,subscriber_id,event_type) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
          .bind(id, Date.now(), event.data.subscriber, event.event_type),
      ]);
      return reply({ ok: true });
    }
    const allowed = [origin, env.GSV_PRODUCT_EMAIL_WEBSITE_ORIGIN].filter(Boolean);
    if (!allowed.includes(request.headers.get("origin") ?? "")) return reply({ error: "invalid_origin" }, 403);
    const type = request.headers.get("content-type")?.split(";", 1)[0];
    const raw: unknown = type === "application/x-www-form-urlencoded"
      ? Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body))) : JSON.parse(new TextDecoder().decode(body));
    const input = z.object({ email: z.string().max(254), locale: z.enum(["en", "es", "pt-BR"]),
      wordingVersion: z.literal(PRODUCT_EMAIL_WORDING_VERSION), consent: z.union([z.literal(true), z.literal("yes")]) }).parse(raw);
    const now = Date.now();
    const window = Math.floor(now / 3_600_000);
    const rateKey = await sha256Hex(`${window}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`);
    await db.prepare(`INSERT INTO product_email_rate_limits(key,window,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET count=count+1`).bind(rateKey, window).run();
    const rate = await db.prepare("SELECT count FROM product_email_rate_limits WHERE key=?").bind(rateKey).first<{ count: number }>();
    if ((rate?.count ?? 100) > 10) return reply({ error: "rate_limited" }, 429);
    await consent.publicSignup(input.email, productEmailLocale(input.locale), input.wordingVersion, Date.now(), request.headers.get("cf-connecting-ip") ?? undefined);
    // No status disclosure: the same response covers existing, suppressed and new addresses.
    return reply({ ok: true, message: "Request saved. If eligible, check your inbox to confirm Ship product updates." }, 202);
  } catch { return reply({ error: "invalid_request" }, 400); }
}
