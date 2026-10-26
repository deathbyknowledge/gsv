import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { queueProductEmail, runProductEmailJobs } from "./product-email";

const db = env.INSTALLATIONS_DB;
const config = { GSV_PRODUCT_EMAIL_ENABLED: "true", BUTTONDOWN_API_KEY: "test-key" };
const choice = { wordingVersion: "ship-product-updates-2026-10-23", locale: "en" } as const;
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
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 2, ip: null, last_error: null });
  await queueProductEmail(db, f.owner, choice);
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledTimes(4);
});

it.each(["regular", "unactivated", "unsubscribed", "blocked", "complained", "undeliverable", "removed"])("leaves an existing %s subscriber unchanged", async (type) => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ type, tags: ["existing"] }));
  await runProductEmailJobs(db, config, provider);
  expect(provider).toHaveBeenCalledOnce();
  expect(provider.mock.calls[0][1]?.method).toBeUndefined();
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number) });
});

it("serializes concurrent drains and honors the sending switch", async () => {
  const f = await fixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: "regular" }));
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
