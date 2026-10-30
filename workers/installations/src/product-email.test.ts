import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { queueProductEmail, runProductEmailJobs } from "./product-email";

const db = env.INSTALLATIONS_DB;
const config = { GSV_PRODUCT_EMAIL_ENABLED: "true", BUTTONDOWN_API_KEY: "test-key" };
const choice = { wordingVersion: "ship-product-updates-2026-10-26", locale: "en" } as const;
async function fixture() {
  const id = crypto.randomUUID();
  const owner = await new AccountStore(db, "example.com").createPrincipal({ principalId: id, email: `${id}@example.com`, displayName: "Owner", verified: true });
  await queueProductEmail(db, owner, choice, "192.0.2.1");
  const row = () => db.prepare("SELECT * FROM product_email_signups WHERE email=?").bind(owner.email).first();
  const retry = () => db.prepare("UPDATE product_email_signups SET due_at=0 WHERE email=?").bind(owner.email).run();
  return { owner, row, retry };
}

it("retries provider downtime with the same key and retains redacted diagnostics", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValueOnce(new Error(`Network failed for ${f.owner.email}`));
  await runProductEmailJobs(db, config, provider);
  const failed = await f.row();
  expect(failed).toMatchObject({ completed_at: null, attempts: 1 });
  expect(String(failed!.last_error)).toContain("diagnosticId");
  expect(String(failed!.last_error)).not.toContain(f.owner.email);
  await f.retry();
  provider.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json({ type: "regular" }, { status: 201 }));
  await runProductEmailJobs(db, config, provider);
  expect(new Headers(provider.mock.calls[1][1]?.headers).get("X-Idempotency-Key"))
    .toBe(new Headers(provider.mock.calls[3][1]?.headers).get("X-Idempotency-Key"));
  expect(new Headers(provider.mock.calls[3][1]?.headers).get("X-API-Version")).toBe("2026-04-01");
  expect(JSON.parse(String(provider.mock.calls[3][1]?.body))).toMatchObject({
    email_address: f.owner.email, type: "regular", tags: ["user"],
    metadata: { source: "ship-signup", wording_version: choice.wordingVersion, locale: "en" },
  });
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 2, ip: null, last_error: null });
  await queueProductEmail(db, f.owner, choice);
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledTimes(4);
});

it.each(["unactivated", "unsubscribed", "blocked", "complained", "undeliverable", "removed", "unknown"])("leaves an existing %s subscriber unchanged", async (type) => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type, tags: ["existing"] }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledOnce();
  expect(provider.mock.calls[0][1]?.method).toBeUndefined();
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number) });
});

it.each(["regular", "premium", "gifted", "trialed", "churning", "churned", "past_due", "paused", "unpaid", "upcoming"])("appends user without replacing tags or the %s status", async (type) => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type, tags: ["early-access", "website"] }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledTimes(2);
  const [url, request] = provider.mock.calls[1];
  expect(url).toBe(`https://api.buttondown.com/v1/subscribers/${encodeURIComponent(f.owner.email)}`);
  expect(request?.method).toBe("PATCH");
  expect(new Headers(request?.headers).get("X-Buttondown-Collision-Behavior")).toBe("add");
  expect(JSON.parse(String(request?.body))).toEqual({ tags: ["user"] });
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), ip: null });
});

it("does not update an existing user subscriber", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type: "regular", tags: ["early-access", "user"] }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledOnce();
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number) });
});

it("retries failed tag delivery with a stable key without replacing other tags", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type: "regular", tags: ["early-access"] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  await runProductEmailJobs(db, config, provider);
  expect(await f.row()).toMatchObject({ completed_at: null, attempts: 1 });
  await f.retry();
  provider.mockResolvedValueOnce(Response.json({ type: "regular", tags: ["early-access", "another-source"] }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await runProductEmailJobs(db, config, provider);
  const requests = [provider.mock.calls[1][1]!, provider.mock.calls[3][1]!];
  expect(new Headers(requests[0].headers).get("X-Idempotency-Key"))
    .toBe(new Headers(requests[1].headers).get("X-Idempotency-Key"));
  for (const request of requests) {
    expect(request.method).toBe("PATCH");
    expect(new Headers(request.headers).get("X-Buttondown-Collision-Behavior")).toBe("add");
    expect(JSON.parse(String(request.body))).toEqual({ tags: ["user"] });
  }
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 2, last_error: null });
});

it.each([
  { type: "regular", tags: ["early-access", "user"] },
  { type: "unsubscribed", tags: ["early-access"] },
])("rechecks $type status and tags after an uncertain update", async (subscriber) => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type: "regular", tags: ["early-access"] }))
    .mockRejectedValueOnce(new Error("Response lost"));
  await runProductEmailJobs(db, config, provider);
  await f.retry();
  provider.mockResolvedValueOnce(Response.json(subscriber));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledTimes(3);
  expect(provider.mock.calls[2][1]?.method).toBeUndefined();
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 2 });
});

it("retains a request when Buttondown returns an invalid subscriber", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type: "regular" }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledOnce();
  expect(await f.row()).toMatchObject({ completed_at: null, attempts: 1, last_error: expect.any(String) });
});

it("serializes concurrent drains and honors the sending switch", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: "regular", tags: ["user"] }));
  await runProductEmailJobs(db, {}, provider);
  expect(provider).not.toHaveBeenCalled();
  await Promise.all([runProductEmailJobs(db, config, provider), runProductEmailJobs(db, config, provider)]);
  expect(provider).toHaveBeenCalledOnce();
  expect(await f.row()).toMatchObject({ attempts: 1, completed_at: expect.any(Number) });
});

it.each(["email", "disabled"])("discards a pending request after its owner's %s changes", async (change) => {
  const f = await fixture();
  if (change === "email") await db.prepare("UPDATE principals SET primary_email_normalized=? WHERE id=?").bind(`new-${f.owner.email}`, f.owner.id).run();
  else await db.prepare("UPDATE principals SET state='disabled' WHERE id=?").bind(f.owner.id).run();
  const provider = vi.fn<typeof fetch>();
  await runProductEmailJobs(db, config, provider);
  expect(provider).not.toHaveBeenCalled();
  expect(await f.row()).toBeNull();
});

it("delivers backfilled owners with the user tag and honest source metadata", async () => {
  const f = await fixture();
  await db.prepare("UPDATE product_email_signups SET source='ship-existing-user-backfill', wording_version='operator-backfill-2026-10-30', locale='und' WHERE email=?")
    .bind(f.owner.email).run();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ type: "regular" }, { status: 201 }));
  await runProductEmailJobs(db, config, provider);
  expect(JSON.parse(String(provider.mock.calls[1][1]?.body))).toMatchObject({
    email_address: f.owner.email, type: "regular", tags: ["user"],
    metadata: { source: "ship-existing-user-backfill", wording_version: "operator-backfill-2026-10-30", locale: "und" },
  });
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number) });
});

it("normalizes mixed-case owner addresses before checking current ownership", async () => {
  const owner = await new AccountStore(db, "example.com").createPrincipal({
    email: `Mixed-${crypto.randomUUID()}@Example.com`, displayName: "Owner", verified: true,
  });
  await queueProductEmail(db, owner, choice);
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ type: "regular" }, { status: 201 }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(provider.mock.calls[1][1]?.body))).toMatchObject({ email_address: owner.email.toLowerCase(), tags: ["user"] });
});

