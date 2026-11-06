import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { ProductEmailService } from "@humansandmachines/gsv/services/product-email";
import { AccountStore } from "./store";
import { queueProductEmail, runProductEmailJobs } from "./product-email";

const db = env.INSTALLATIONS_DB;
const choice = { wordingVersion: "ship-product-updates-2026-10-26", locale: "en" } as const;
async function fixture() {
  const id = crypto.randomUUID();
  const owner = await new AccountStore(db, "example.com").createPrincipal({ principalId: id,
    email: `Mixed-${id}@Example.com`, displayName: "Owner", verified: true });
  await queueProductEmail(db, owner, choice, "192.0.2.1");
  const row = () => db.prepare("SELECT * FROM product_email_signups WHERE email=?").bind(owner.email.toLowerCase()).first();
  const retry = () => db.prepare("UPDATE product_email_signups SET due_at=0 WHERE email=?").bind(owner.email.toLowerCase()).run();
  const subscribe = vi.fn<ProductEmailService["subscribe"]>().mockResolvedValue(undefined);
  return { owner, row, retry, subscribe, config: { PRODUCT_EMAIL: { subscribe } } };
}

it("delivers normalized signup evidence through the optional service once", async () => {
  const f = await fixture();
  await runProductEmailJobs(db, {});
  expect(f.subscribe).not.toHaveBeenCalled();
  await Promise.all([runProductEmailJobs(db, f.config), runProductEmailJobs(db, f.config)]);
  expect(f.subscribe).toHaveBeenCalledOnce();
  expect(f.subscribe.mock.calls[0][0]).toMatchObject({ emailAddress: f.owner.email.toLowerCase(), source: "ship-signup",
    consentBasis: "signup-checkbox", wordingVersion: choice.wordingVersion, locale: "en", importId: null,
    recordedAt: expect.any(Number), consentedAt: expect.any(Number), ipAddress: "192.0.2.1" });
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 1, ip: null });
  await queueProductEmail(db, f.owner, choice);
  await runProductEmailJobs(db, f.config);
  expect(f.subscribe).toHaveBeenCalledOnce();
});

it("retries service downtime with the same identity and preserves redacted diagnostics", async () => {
  const f = await fixture();
  f.subscribe.mockRejectedValueOnce(new Error(`Private failure ${f.owner.email}`));
  await runProductEmailJobs(db, f.config);
  const failed = await f.row();
  expect(failed).toMatchObject({ completed_at: null, attempts: 1 });
  expect(String(failed!.last_error)).toContain("diagnosticId");
  expect(String(failed!.last_error)).not.toContain(f.owner.email);
  await f.retry();
  await runProductEmailJobs(db, f.config);
  expect(f.subscribe.mock.calls[1][0]).toEqual(f.subscribe.mock.calls[0][0]);
  expect(await f.row()).toMatchObject({ completed_at: expect.any(Number), attempts: 2, last_error: null, ip: null });
});

it.each(["email", "disabled"])("discards pending delivery after the owner's %s changes", async (change) => {
  const f = await fixture();
  if (change === "email") await db.prepare("UPDATE principals SET primary_email_normalized=? WHERE id=?").bind(`new-${f.owner.email}`, f.owner.id).run();
  else await db.prepare("UPDATE principals SET state='disabled' WHERE id=?").bind(f.owner.id).run();
  await runProductEmailJobs(db, f.config);
  expect(f.subscribe).not.toHaveBeenCalled();
  expect(await f.row()).toBeNull();
});

it("tells the service an imported owner's request apart from checkbox evidence", async () => {
  const f = await fixture();
  const importId = crypto.randomUUID();
  await db.prepare(`UPDATE product_email_signups SET source='ship-existing-user-backfill',consent_basis='operator-confirmed-existing-opt-ins',
    consented_at=NULL,import_id=?,wording_version='unknown',locale='und' WHERE principal_id=?`).bind(importId, f.owner.id).run();
  await runProductEmailJobs(db, f.config);
  expect(f.subscribe.mock.calls[0][0]).toMatchObject({ source: "ship-existing-user-backfill",
    consentBasis: "operator-confirmed-existing-opt-ins", importId, wordingVersion: null, locale: null, consentedAt: null });
});
