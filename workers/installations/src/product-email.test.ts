import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { ProductEmailConsent, PRODUCT_EMAIL_WORDING_VERSION as VERSION } from "./product-email";
import { Buttondown, BUTTONDOWN_API_VERSION, verifyButtondownSignature, type Subscriber } from "./product-email-provider";
import { handleProductEmailPublic } from "./product-email-http";
import { ServiceNotices, handleServiceNotices } from "./service-notices";

const db = env.INSTALLATIONS_DB;
const secret = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
async function fixture() {
  const store = new ProductEmailConsent(db);
  const email = `${crypto.randomUUID()}@example.com`;
  const auth = new InstallationOwnerAuthStore(db, "product-email-test-secret-".repeat(4));
  const input = { purpose: "login" as const, challengeId: crypto.randomUUID(), browserSecret: secret(), email, ip: email };
  const issued = await auth.issue(input);
  const sessionSecret = secret();
  const verify = () => auth.verify({ ...input, code: issued.code, sessionSecret });
  return { store, email, input, auth, verify, sessionSecret };
}
function provider() {
  let subscriber: Subscriber | null = null;
  const writes: { method: string; body: Record<string, unknown>; key: string }[] = [];
  let down = false;
  let beforeCreate: (() => Promise<void>) | undefined;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("X-API-Version")).toBe(BUTTONDOWN_API_VERSION);
    if (down) return new Response("unavailable", { status: 503 });
    const method = init?.method ?? "GET";
    if (method === "GET") return subscriber ? Response.json(subscriber) : new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body));
    const key = new Headers(init?.headers).get("X-Idempotency-Key")!;
    expect(key).toBeTruthy();
    writes.push({ method, body, key });
    if (method === "POST") {
      if (beforeCreate) await beforeCreate();
      subscriber ??= { id: `sub_${crypto.randomUUID()}`, email_address: body.email_address, type: body.type ?? "unactivated", tags: body.tags, metadata: body.metadata };
    } else if (subscriber) subscriber = { ...subscriber, ...body };
    return Response.json(subscriber);
  });
  return { client: new Buttondown("test-key", fetcher), writes, fetcher,
    get: () => subscriber, set: (s: Subscriber | null) => { subscriber = s; }, down: (value: boolean) => { down = value; },
    beforeCreate: (callback: () => Promise<void>) => { beforeCreate = callback; } };
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, p: ReturnType<typeof provider>) {
  await db.prepare("UPDATE product_email_consent SET due_at=0 WHERE email=?").bind(f.email).run();
  await f.store.reconcile(p.client, Date.now(), 1000);
}

describe("product email consent", () => {
  it("verification alone never opts in an existing or new owner", async () => {
    const f = await fixture(); const receipt = await f.verify(); await f.store.verified(receipt);
    expect(await f.store.preference(f.email)).toEqual({ revision: 0, optedIn: false, suppressed: false, status: "off" });
  });
  it("records separate explicit signup consent with verified evidence and creates regular only after verification", async () => {
    const f = await fixture(); const p = provider();
    await f.store.stage(f.input.challengeId, "es", VERSION);
    expect((await f.store.get(f.email))!.opted_in).toBe(0);
    const receipt = await f.verify(); await f.store.verified(receipt); await f.store.verified(receipt);
    const row = (await f.store.get(f.email))!;
    expect(row).toMatchObject({ principal_id: receipt.principalId, revision: 1, locale: "es", wording_version: VERSION, source: "signup" });
    expect(JSON.parse(row.evidence!)).toMatchObject({ receiptId: receipt.receiptId, verifiedAt: receipt.verifiedAt });
    await drain(f, p);
    expect(p.writes[0].body.type).toBe("regular");
    expect((await f.store.preference(f.email)).status).toBe("active");
    await drain(f, p); expect(p.writes).toHaveLength(1);
  });
  it("does not unsubscribe an existing subscriber while a signup intent awaits verification", async () => {
    const f = await fixture(); const p = provider();
    p.set({ id: crypto.randomUUID(), email_address: f.email, type: "regular", tags: ["old"], metadata: {} });
    await f.store.stage(f.input.challengeId, "en", VERSION); await drain(f, p);
    expect(p.writes).toEqual([]); expect(p.get()!.type).toBe("regular");
  });
  it("deleting an account also withdraws its website subscription without a separate account opt-in", async () => {
    const f = await fixture(); await f.verify();
    await f.store.publicSignup(f.email, "en", VERSION);
    expect((await f.store.get(f.email))!.principal_id).toBeNull();
    const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.associate(session);
    expect((await f.store.get(f.email))!.evidence).toBeNull();
    await db.prepare("UPDATE principals SET state='disabled' WHERE id=?").bind(session.principalId).run();
    expect((await f.store.preference(f.email)).optedIn).toBe(false);
  });
  it("public requests require provider confirmation and do not associate an account", async () => {
    const f = await fixture(); const p = provider();
    await f.store.publicSignup(f.email, "en", VERSION);
    await drain(f, p);
    expect(p.writes[0].body).not.toHaveProperty("type");
    expect((await f.store.preference(f.email)).status).toBe("pending");
    expect((await f.store.get(f.email))!.principal_id).toBeNull();
    p.set({ ...p.get()!, type: "regular" }); await drain(f, p);
    expect((await f.store.preference(f.email)).status).toBe("active");
    expect(JSON.parse((await f.store.get(f.email))!.evidence!).kind).toBe("buttondown-confirmation");
  });
  it("does not infer consent from an existing regular subscriber or replace their tags", async () => {
    const f = await fixture(); const p = provider();
    p.set({ id: crypto.randomUUID(), email_address: f.email, type: "regular", tags: ["early-access", "custom"], metadata: {} });
    await f.store.publicSignup(f.email, "en", VERSION); await drain(f, p);
    expect((await f.store.preference(f.email)).status).toBe("pending");
    expect(p.writes).toEqual([]); expect(p.get()!.tags).toEqual(["early-access", "custom"]);
  });
  it.each(["unsubscribed", "complained", "undeliverable", "blocked", "removed"])("never reactivates %s", async type => {
    const f = await fixture(); const p = provider(); const receipt = await f.verify();
    const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.set(session, true, 0, "en", VERSION);
    p.set({ id: crypto.randomUUID(), email_address: f.email, type, tags: ["old"], metadata: {} });
    await drain(f, p);
    expect((await f.store.get(f.email))!.suppressed).toBe(1); expect(p.writes).toEqual([]);
    await expect(f.store.set(session, true, (await f.store.get(f.email))!.revision, "en", VERSION)).rejects.toThrow();
    await f.store.publicSignup(f.email, "en", VERSION); expect((await f.store.get(f.email))!.opted_in).toBe(0);
    expect(receipt.principalId).toBe(session.principalId);
  });
  it("durably retries downtime, but withdrawal cancels the queued opt-in", async () => {
    const f = await fixture(); const p = provider(); await f.verify(); const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.set(session, true, 0, "en", VERSION); p.down(true); await drain(f, p);
    expect((await f.store.get(f.email))!.attempts).toBeGreaterThan(0);
    await f.store.set(session, false, 1, "en", VERSION); p.down(false); await drain(f, p);
    expect(p.writes).toEqual([]); expect((await f.store.preference(f.email)).optedIn).toBe(false);
  });
  it("reuses the persisted provider idempotency key after a failed create", async () => {
    const f = await fixture(); const p = provider();
    await f.store.publicSignup(f.email, "en", VERSION);
    p.fetcher.mockImplementationOnce(async () => new Response(null, { status: 404 }))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await drain(f, p); await drain(f, p);
    const keys = p.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => new Headers(init?.headers).get("X-Idempotency-Key"));
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  });
  it("a successful create returning blocked is never reported as active", async () => {
    const f = await fixture(); const p = provider();
    await f.store.publicSignup(f.email, "en", VERSION);
    p.beforeCreate(async () => { p.set({ id: crypto.randomUUID(), email_address: f.email, type: "blocked", tags: [], metadata: {} }); });
    await drain(f, p);
    expect((await f.store.preference(f.email)).status).not.toBe("active");
    expect((await f.store.get(f.email))!.suppressed).toBe(1);
  });
  it("provider address changes never transfer consent to the new address", async () => {
    const f = await fixture(); const p = provider(); await f.store.publicSignup(f.email, "en", VERSION); await drain(f, p);
    p.set({ ...p.get()!, email_address: `changed-${f.email}`, type: "regular" }); await drain(f, p);
    expect(p.get()!.type).toBe("unsubscribed");
    expect((await f.store.preference(`changed-${f.email}`)).optedIn).toBe(false);
    expect((await f.store.get(f.email))!.suppressed).toBe(1);
  });
  it("withdrawal after checkbox submission invalidates the verification job", async () => {
    const f = await fixture(); await f.store.stage(f.input.challengeId, "en", VERSION);
    await f.store.withdraw(f.email, "buttondown-withdrawal"); await f.store.verified(await f.verify());
    expect((await f.store.get(f.email))!.opted_in).toBe(0);
  });
  it("compensates a withdrawal while creation is in flight without replaying creation", async () => {
    const f = await fixture(); const p = provider(); await f.verify(); const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.set(session, true, 0, "en", VERSION);
    p.beforeCreate(() => f.store.withdraw(f.email, "settings")); await drain(f, p);
    expect(p.get()!.type).toBe("unsubscribed");
    await drain(f, p); expect(p.writes.filter(w => w.method === "POST")).toHaveLength(1);
  });
  it("rejects stale setting revisions and keeps opt-out history", async () => {
    const f = await fixture(); await f.verify(); const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.set(session, true, 0, "pt-BR", VERSION); await f.store.set(session, false, 1, "pt-BR", VERSION);
    await expect(f.store.set(session, true, 1, "en", VERSION)).rejects.toThrow();
    const events = await db.prepare("SELECT * FROM product_email_events WHERE email=? ORDER BY revision").bind(f.email).all();
    expect(events.results).toHaveLength(3); expect(events.results[2]).toMatchObject({ opted_in: 0, source: "settings", revision: 2 });
  });
  it.each(["email", "disabled", "deleted", "revoked"])("withdraws transactionally when identity is %s", async change => {
    const f = await fixture(); await f.verify(); const session = (await f.auth.session(f.sessionSecret))!;
    await f.store.set(session, true, 0, "en", VERSION);
    if (change === "email") await db.prepare("UPDATE principals SET primary_email_normalized=? WHERE id=?").bind(`new-${f.email}`, session.principalId).run();
    if (change === "disabled") await db.prepare("UPDATE principals SET state='disabled' WHERE id=?").bind(session.principalId).run();
    if (change === "revoked") await db.prepare("UPDATE principal_email_credentials SET revoked_at=? WHERE principal_id=?").bind(Date.now(), session.principalId).run();
    if (change === "deleted") {
      await db.batch([db.prepare("DELETE FROM owner_auth_sessions WHERE principal_id=?").bind(session.principalId),
        db.prepare("DELETE FROM owner_auth_challenges WHERE principal_id=?").bind(session.principalId),
        db.prepare("DELETE FROM principal_email_credentials WHERE principal_id=?").bind(session.principalId),
        db.prepare("DELETE FROM principals WHERE id=?").bind(session.principalId)]);
    }
    expect((await f.store.get(f.email))!.suppressed).toBe(1);
    expect((await f.store.preference(`new-${f.email}`)).optedIn).toBe(false);
  });
});

async function signed(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
it("rejects forged webhooks, deduplicates replays, and treats out-of-order confirmation as a hint", async () => {
  const f = await fixture(); const p = provider(); await f.store.publicSignup(f.email, "en", VERSION); await drain(f, p);
  const body = JSON.stringify({ id: crypto.randomUUID(), event_type: "subscriber.confirmed", data: { newsletter: "news", subscriber: p.get()!.id } });
  const cfg = { GSV_PRODUCT_EMAIL_ENABLED: "true", BUTTONDOWN_SIGNING_KEY: "signing-secret", BUTTONDOWN_NEWSLETTER_ID: "news" };
  const request = (signature: string) => new Request("https://accounts.example/product-email/buttondown", { method: "POST", headers: { "X-Buttondown-Signature": signature }, body });
  expect((await handleProductEmailPublic(request("sha256=" + "0".repeat(64)), db, cfg, "https://accounts.example"))!.status).toBe(401);
  const signature = await signed(body, cfg.BUTTONDOWN_SIGNING_KEY);
  expect(await verifyButtondownSignature(new TextEncoder().encode(body + " "), signature, cfg.BUTTONDOWN_SIGNING_KEY)).toBe(false);
  await f.store.withdraw(f.email, "settings");
  for (let i = 0; i < 2; i++) expect((await handleProductEmailPublic(request(signature), db, cfg, "https://accounts.example"))!.status).toBe(200);
  expect((await f.store.get(f.email))!.opted_in).toBe(0);
  const count = await db.prepare("SELECT count(*) n FROM product_email_webhooks WHERE id=?").bind(JSON.parse(body).id).first<{ n: number }>();
  expect(count!.n).toBe(1);
  await drain(f, p); expect(p.get()!.type).toBe("unsubscribed");
});
it("public forms require explicit opt-in and the current wording version, including no-JS posts", async () => {
  const cfg = { GSV_PRODUCT_EMAIL_ENABLED: "true", GSV_PRODUCT_EMAIL_WEBSITE_ORIGIN: "https://ship.example" };
  const send = (form: URLSearchParams) => handleProductEmailPublic(new Request("https://accounts.example/product-email/subscribe", {
    method: "POST", headers: { origin: "https://ship.example", "cf-connecting-ip": crypto.randomUUID() }, body: form }), db, cfg, "https://accounts.example");
  const data = new URLSearchParams({ email: `${crypto.randomUUID()}@example.com`, locale: "en", wordingVersion: VERSION });
  expect((await send(data))!.status).toBe(400); data.set("consent", "yes"); expect((await send(data))!.status).toBe(202);
});

it("essential notice dry-runs require admin access, target verified affected owners, and never duplicate an ambiguous send", async () => {
  const accounts = new AccountStore(db, "example.com"); const f = await fixture(); const receipt = await f.verify();
  const install = await accounts.reserveInstallation({ operationId: crypto.randomUUID(), principalId: receipt.principalId, handle: `notice-${crypto.randomUUID()}` });
  await db.prepare("UPDATE installations SET state='active' WHERE id=?").bind(install.installationId).run();
  const input = { id: crypto.randomUUID(), kind: "maintenance" as const, startsAt: "2026-10-24T10:00:00Z", endsAt: "2026-10-24T11:00:00Z", installationIds: [install.installationId] };
  const request = () => new Request("https://accounts.example/admin/service-notices/dry-run", { method: "POST", headers: { origin: "https://accounts.example", "content-type": "application/json" }, body: JSON.stringify(input) });
  expect((await handleServiceNotices(request(), db, { allows: async () => false }, "https://accounts.example", false))!.status).toBe(403);
  const notices = new ServiceNotices(db); const preview = await notices.preview(input);
  expect(preview.recipients).toEqual([{ principal_id: receipt.principalId, email: f.email }]);
  const send = vi.fn(async () => { throw new Error("ambiguous transport"); });
  await notices.deliver({ send }, "service@example.com"); expect(send).not.toHaveBeenCalled();
  await notices.enqueue(input, preview.audienceDigest); await notices.enqueue(input, preview.audienceDigest);
  await notices.deliver({ send }, "service@example.com"); await notices.deliver({ send }, "service@example.com"); expect(send).toHaveBeenCalledTimes(1);
  expect((await f.store.preference(f.email)).optedIn).toBe(false);
});
