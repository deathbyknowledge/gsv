import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { OperatorShipSnapshot } from "@humansandmachines/gsv/services/operator";
import { AccountStore } from "../store";
import { InstallationAdminStore } from "../administration";
import { InstallationAdminService } from "./service";
import { InstallationOnboardingStore } from "../onboarding";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { AdminMonitoring, DAY_MS, userSegment } from "./monitoring";
import { adminOverviewPage } from "./monitoring-page";

async function fixture() {
  const db = env.INSTALLATIONS_DB;
  const accounts = new AccountStore(db, "example.com");
  const owner = await accounts.createPrincipal({ email: `${crypto.randomUUID()}@example.com`, displayName: "Owner", verified: true });
  const space = await accounts.reserveInstallation({ principalId: owner.id, operationId: crypto.randomUUID(), handle: `monitor-${crypto.randomUUID()}`, ownerSetup: true });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
  return { db, accounts, space, monitoring: new AdminMonitoring(db), admin: new InstallationAdminStore(db) };
}

function snapshot(installationId: string, at: number, messages = 2): OperatorShipSnapshot {
  return { version: 1, installationId, capturedAt: at, ship: null, processes: { total: 0, running: 0 }, runs: [],
    messengers: [], targets: [], shipEvents: { queued: 0, oldestQueuedAt: null }, openResponsibilities: 0,
    usage: { trackedFrom: at - 10 * DAY_MS, firstActiveAt: at - 8 * DAY_MS, lastActiveAt: at - 60_000,
      messages, tasks: 2, successfulTasks: 1, failedTasks: 1, abortedTasks: 0,
      days: [{ day: new Date(at - DAY_MS).toISOString().slice(0, 10), messages }] } };
}

describe("operator monitoring", () => {
  it.each(["unavailable", "missing usage"])("recovers after an initial %s refresh", async (failure) => {
    const { monitoring, admin, db, space } = await fixture();
    const now = Date.now();
    await monitoring.refresh(async (id) => failure === "unavailable" ? null : { ...snapshot(id, now), usage: undefined });
    expect((await admin.getInstallation(space.installationId))?.activity).toMatchObject({
      capturedAt: null, messages: null, availability: "unavailable",
    });
    await db.prepare("UPDATE installation_activity SET attempted_at = 1 WHERE installation_id = ?").bind(space.installationId).run();

    await monitoring.refresh(async (id) => snapshot(id, now, 7));
    expect((await admin.getInstallation(space.installationId))?.activity).toMatchObject({
      capturedAt: now, messages: 7, tasks: 2, successfulTasks: 1, availability: "ok",
    });
    const row = await db.prepare("SELECT attempted_at FROM installation_activity WHERE installation_id = ?")
      .bind(space.installationId).first<{ attempted_at: number }>();
    expect(row?.attempted_at).toBeGreaterThan(1);

    await monitoring.capture(snapshot(space.installationId, now - 1000, 1));
    expect((await admin.getInstallation(space.installationId))?.activity).toMatchObject({ capturedAt: now, messages: 7 });
  });

  it("materializes absolute usage idempotently and ignores older captures", async () => {
    const { monitoring, admin, space } = await fixture();
    const now = Date.now();
    await monitoring.capture(snapshot(space.installationId, now, 7));
    await monitoring.capture(snapshot(space.installationId, now, 7));
    await monitoring.capture(snapshot(space.installationId, now - 1000, 1));
    const list = await admin.listInstallations({ query: space.handle, state: null, page: 1, sort: "messages", minMessages: 5, segment: "active" });
    expect(list.total).toBe(1);
    expect(list.installations[0].activity).toMatchObject({ messages: 7, tasks: 2, successfulTasks: 1, capturedAt: now });
    expect((await admin.listInstallations({ query: space.handle, state: null, page: 1, segment: "never_used" })).total).toBe(0);
  });

  it("keeps unknown history out of rates and measures mature day-7 cohorts", async () => {
    const { monitoring, db, space } = await fixture();
    const now = Date.now();
    await db.prepare("UPDATE installations SET created_at = ?, signup_at = ? WHERE id = ?").bind(now - 8 * DAY_MS, now - 8 * DAY_MS, space.installationId).run();
    await monitoring.capture(snapshot(space.installationId, now));
    const overview = await monitoring.overview(now);
    expect(overview.activated).toBeGreaterThanOrEqual(1);
    expect(overview.retained).toBeGreaterThanOrEqual(1);
    expect(overview.retentionEligible).toBeGreaterThanOrEqual(1);
    expect(overview.days).toHaveLength(30);
    const html = await adminOverviewPage(overview, false).text();
    expect(html).toContain("Day-7 retention");
    expect(html).toContain('<svg class="growth-chart"');
    expect(html).toContain("Daily counts");
  });

  it.each([false, true])("requires coverage through the completed seventh UTC day (returned: %s)", async (returned) => {
    const { monitoring, db, space } = await fixture();
    const now = Date.now();
    const coverageEnd = Math.floor(now / DAY_MS) * DAY_MS;
    const signedUpAt = coverageEnd - 8 * DAY_MS + 13 * 60 * 60 * 1000;
    const baseline = await monitoring.overview(now);
    await db.prepare("UPDATE installations SET created_at = ?, signup_at = ? WHERE id = ?")
      .bind(signedUpAt, signedUpAt, space.installationId).run();
    const initial = snapshot(space.installationId, signedUpAt + DAY_MS, 1);
    const usage = { ...initial.usage!, trackedFrom: signedUpAt, firstActiveAt: signedUpAt, lastActiveAt: signedUpAt,
      days: [{ day: new Date(signedUpAt).toISOString().slice(0, 10), messages: 1 }] };
    await monitoring.capture({ ...initial, usage });
    await monitoring.refresh(async () => null);
    expect(await monitoring.overview(now)).toMatchObject({ retentionEligible: baseline.retentionEligible, retained: baseline.retained });

    const measured = { ...initial, capturedAt: coverageEnd - 1, usage: { ...usage,
      messages: returned ? 2 : 1, lastActiveAt: returned ? coverageEnd - 1 : signedUpAt,
      days: [...usage.days, ...(returned ? [{ day: new Date(coverageEnd - 1).toISOString().slice(0, 10), messages: 1 }] : [])] } };
    await monitoring.capture(measured);
    expect(await monitoring.overview(now)).toMatchObject({ retentionEligible: baseline.retentionEligible, retained: baseline.retained });

    await monitoring.capture({ ...measured, capturedAt: coverageEnd });
    expect(await monitoring.overview(now)).toMatchObject({ retentionEligible: baseline.retentionEligible + 1, retained: baseline.retained + Number(returned) });
  });

  it("saves outreach atomically with immutable history and refuses stale edits", async () => {
    const { monitoring, admin, space } = await fixture();
    await monitoring.saveOutreach(space.installationId, { status: "emailed", notes: "Needs help with setup <script>", lastContactedAt: Date.now(), revision: 0 }, "operator-one");
    await expect(monitoring.saveOutreach(space.installationId, { status: "replied", notes: "stale", lastContactedAt: null, revision: 0 }, "operator-two")).rejects.toThrow("changed");
    await monitoring.saveOutreach(space.installationId, { status: "follow_up", notes: "Reply on Friday", lastContactedAt: Date.now(), revision: 1 }, "operator-one");
    expect(await monitoring.history(space.installationId)).toMatchObject([
      { actor: "operator-one", status: "follow_up", revision: 2 }, { actor: "operator-one", status: "emailed", revision: 1 },
    ]);
    const list = await admin.listInstallations({ query: "Reply on Friday", state: null, page: 1, outreach: "follow_up", sort: "last_contacted" });
    expect(list.installations).toContainEqual(expect.objectContaining({ installationId: space.installationId }));
  });

  it("requires both operator admission and same-origin authority for outreach updates", async () => {
    const { accounts, db, space, monitoring } = await fixture();
    const origin = "https://accounts.example.com";
    const service = new InstallationAdminService(db, accounts, new InstallationOnboardingStore(db, accounts),
      { id: "registry-monitor", email: "registry@gsv.invalid", displayName: "Registry" }, {});
    const http = new InstallationAdminHttp(service, { allows: async () => true, operatorIdentity: async () => "operator" }, origin, {}, undefined, new ShipInsight(db));
    const path = `${origin}/admin/api/installations/${space.installationId}/outreach`;
    const body = JSON.stringify({ status: "emailed", notes: "Hello", revision: 0, lastContactedAt: null });
    const refused = await http.handle(new Request(path, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body }));
    expect(refused?.status).toBe(403);
    expect((await monitoring.outreach(space.installationId)).revision).toBe(0);
    const saved = await http.handle(new Request(path, { method: "POST", headers: { origin, "content-type": "application/json" }, body }));
    expect(saved?.status).toBe(200);
    expect((await monitoring.outreach(space.installationId)).status).toBe("emailed");
  });
});

it("does not label historic unmeasured users as never used", () => {
  const now = Date.now();
  const base = { capturedAt: now, trackedFrom: now - DAY_MS, firstActiveAt: null, lastActiveAt: null, messages: 0,
    tasks: 0, successfulTasks: 0, failedTasks: 0, availability: "ok" };
  expect(userSegment(now - 2 * DAY_MS, base)).toBe("unknown");
  expect(userSegment(now, base)).toBe("never_used");
  expect(userSegment(now, { ...base, messages: 1, lastActiveAt: now - 8 * DAY_MS })).toBe("tried_once");
  expect(userSegment(now, { ...base, messages: 2, lastActiveAt: now })).toBe("active");
  expect(userSegment(now, { ...base, messages: 2, lastActiveAt: now - 8 * DAY_MS })).toBe("inactive");
  expect(userSegment(now, { ...base, messages: 5, lastActiveAt: now - 8 * DAY_MS })).toBe("previously_active");
});
