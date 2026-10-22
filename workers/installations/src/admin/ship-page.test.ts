import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { OperatorGatewayService, OperatorShipSnapshot } from "@humansandmachines/gsv/services/operator";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";

const origin = "http://localhost:8976";

function stack(gateway?: OperatorGatewayService, timeoutMs?: number, insightDb: Pick<D1Database, "prepare"> = env.INSTALLATIONS_DB) {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "principal_ship_page_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {});
  const insight = new ShipInsight(insightDb, { gateway, mailDomain: "ship.space", timeoutMs });
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }),
    origin, {}, undefined, insight);
  return { service, onboarding, http, insight };
}

function form(path: string, values: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(values) });
}

async function page(http: InstallationAdminHttp, path: string): Promise<string> {
  const response = await http.handle(new Request(`${origin}${path}`));
  expect(response?.status).toBe(200);
  return await response!.text();
}

async function createShip(http: InstallationAdminHttp, service: InstallationAdminService, handle: string): Promise<string> {
  await http.handle(form("/admin/installations", { operationId: `operation_${crypto.randomUUID()}`, handle }));
  const list = await service.listInstallations({ query: handle, state: null, page: 1 });
  return list.installations[0]!.installationId;
}

/** The audit log's database, failing each statement that starts with `failing` while `fail.on` is set. */
function auditDb(failing: string) {
  const fail = { on: false };
  const db: Pick<D1Database, "prepare"> = {
    // A statement on a missing table fails inside D1, as a dropped connection would.
    prepare: (sql) => env.INSTALLATIONS_DB.prepare(fail.on && sql.trim().startsWith(failing) ? "SELECT * FROM operator_audit_unreachable" : sql),
  };
  return { db, fail };
}

async function activate(
  { service, onboarding }: Pick<ReturnType<typeof stack>, "service" | "onboarding">,
  installationId: string,
): Promise<void> {
  const issued = await service.reissueOnboarding(installationId);
  const authorized = await onboarding.authorize({ installationId, token: new URL(issued.onboarding.onboardingUrl).hash.slice(1) });
  if (!authorized.ok) throw new Error("Expected valid onboarding");
  await onboarding.complete({ installationId, claimId: authorized.claimId });
}

function snapshot(installationId: string): OperatorShipSnapshot {
  const at = Date.UTC(2026, 9, 22, 11, 29, 57);
  return {
    version: 1, installationId, capturedAt: at + 900_000,
    ship: { pid: "proc:ship", state: "idle", lastActiveAt: at + 800_000, activeRunId: null, queuedCount: 0,
      pendingApprovals: 0, lastCompactionAt: at - 5_000_000 },
    processes: { total: 12, running: 0 },
    runs: [{
      runId: "adapter-run:long", origin: "adapter", inputChars: 10450, inputHasMedia: false, startedAt: at,
      durationMs: 438_000, status: "ok",
      steps: [
        { kind: "tool", name: "Shell", target: "gsv", startedAt: at + 9_000, durationMs: 3_000, status: "error" },
        { kind: "tool", name: "Shell", target: "Device 1", startedAt: at + 31_000, durationMs: 375_000, status: "ok" },
        { kind: "delivery", name: "Send message", startedAt: at + 438_000, durationMs: 200, status: "ok" },
      ],
    }],
    messengers: [{ adapter: "whatsapp", linkedAt: at - 86_400_000 }],
    targets: [{ id: "Device 1", online: true, lastSeenAt: at }],
    shipEvents: { queued: 0, oldestQueuedAt: null },
    openResponsibilities: 3,
  };
}

describe("Ship page", () => {
  it("offers only lifecycle states the directory can hold", async () => {
    const { http } = stack();
    const list = await page(http, "/admin/installations");
    for (const retired of ["trialing", "past_due", "cancelled"]) expect(list).not.toContain(`value="${retired}"`);
    expect(list).toContain('value="restricted"');
  });

  it("shows the owner's email with sign-in methods, the mail address and every live hostname", async () => {
    const ships = stack();
    const { http, service } = ships;
    const installationId = await createShip(http, service, "valent");
    await activate(ships, installationId);
    const now = Date.now();
    await env.INSTALLATIONS_DB.batch([
      env.INSTALLATIONS_DB.prepare(`INSERT INTO principals (id, primary_email, primary_email_normalized, display_name,
        email_verified_at, state, created_at, updated_at) VALUES ('principal_valent', 'valentin@example.org', 'valentin@example.org', 'V', ?, 'active', ?, ?)`)
        .bind(now, now, now),
      env.INSTALLATIONS_DB.prepare(`INSERT INTO memberships (installation_id, principal_id, local_uid, role, state, created_at)
        VALUES (?, 'principal_valent', 1000, 'owner', 'active', ?)`).bind(installationId, now),
      env.INSTALLATIONS_DB.prepare(`INSERT INTO principal_email_credentials (email_normalized, principal_id, created_at)
        VALUES ('valentin@example.org', 'principal_valent', ?)`).bind(now),
      env.INSTALLATIONS_DB.prepare(`INSERT INTO principal_external_identities (issuer, subject, principal_id, created_at)
        VALUES ('https://accounts.google.com', 'subject-1', 'principal_valent', ?)`).bind(now),
      env.INSTALLATIONS_DB.prepare(`INSERT INTO hostnames (normalized_hostname, installation_id, kind, state, created_at)
        VALUES ('valent.gsv.space', ?, 'alias', 'active', ?)`).bind(installationId, now),
      env.INSTALLATIONS_DB.prepare(`INSERT INTO hostnames (normalized_hostname, installation_id, kind, state, created_at, retired_at)
        VALUES ('valent-old.gsv.space', ?, 'alias', 'retired', ?, ?)`).bind(installationId, now, now),
    ]);

    const body = await page(http, `/admin/installations/${installationId}`);
    // Operators contact owners from this page, so it shows the whole address.
    expect(body).toContain('<a class="select-all" href="mailto:valentin@example.org">valentin@example.org</a>');
    expect(body).toContain("email");
    expect(body).toContain("accounts.google.com");
    expect(body).toContain("valent@ship.space");
    expect(body).toContain("valent.gsv.space");
    expect(body).not.toContain("valent-old.gsv.space");
    expect(body).toContain("Ship ID");
    expect(body).not.toContain("Installation ID");
  });

  it("still renders the Ship when its health cannot be read", async () => {
    const { http, service } = stack();
    const installationId = await createShip(http, service, "nohealth");
    const body = await page(http, `/admin/installations/${installationId}`);
    expect(body).toContain("Health unavailable");
    expect(body).toContain("not connected");
    expect(body).toContain("Reissue activation link");
  });

  it("gives up on a slow health read", async () => {
    const gateway: OperatorGatewayService = { operatorShipSnapshot: () => new Promise(() => {}) };
    const { http, service } = stack(gateway, 20);
    const installationId = await createShip(http, service, "slowhealth");
    const body = await page(http, `/admin/installations/${installationId}`);
    expect(body).toContain("Health unavailable");
    expect(body).toContain("timed out");
  });

  it("shows health and a metadata-only timeline that flags slow and failed steps", async () => {
    const operatorShipSnapshot = vi.fn(async (input: { installationId: string }) =>
      ({ found: true as const, snapshot: snapshot(input.installationId) }));
    const ships = stack({ operatorShipSnapshot });
    const { http, service } = ships;
    const installationId = await createShip(http, service, "timeline");
    await activate(ships, installationId);
    const body = await page(http, `/admin/installations/${installationId}`);
    expect(operatorShipSnapshot).toHaveBeenCalledWith({ version: 1, installationId, runLimit: 20 });
    expect(body).toContain("whatsapp");
    expect(body).toContain("Device 1");
    expect(body).toContain("10,450 chars");
    expect(body).toContain("7m 18s");
    expect(body).toContain("6m 15s");
    expect(body).toContain("slow");
    expect(body).toContain("step-error");
    expect(body).toContain("Open work");
  });

  it("says the run history is unavailable instead of showing no runs", async () => {
    const unread = (installationId: string): OperatorShipSnapshot => ({
      ...snapshot(installationId), runs: null,
      ship: { ...snapshot(installationId).ship!, pendingApprovals: null, lastCompactionAt: null },
    });
    const ships = stack({ operatorShipSnapshot: async (input) => ({ found: true, snapshot: unread(input.installationId) }) });
    const installationId = await createShip(ships.http, ships.service, "unreadruns");
    await activate(ships, installationId);
    const body = await page(ships.http, `/admin/installations/${installationId}`);
    expect(body).toContain("Run history unavailable");
    expect(body).not.toContain("No recent runs");
    expect(body).not.toContain("0 waiting for approval");
  });

  it("keeps the cause when the snapshot call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway: OperatorGatewayService = { operatorShipSnapshot: async () => { throw new Error("Durable Object reset because its code was updated"); } };
    const { http, service } = stack(gateway);
    const installationId = await createShip(http, service, "unreachable");
    expect(await page(http, `/admin/installations/${installationId}`)).toContain("Health unavailable");
    expect(warn).toHaveBeenCalledWith("[Operator] Ship snapshot failed:",
      expect.objectContaining({ exceptionMessage: "Durable Object reset because its code was updated" }));
    warn.mockRestore();
  });

  it("rejects a malformed snapshot instead of rendering it", async () => {
    const gateway: OperatorGatewayService = { operatorShipSnapshot: async () => JSON.parse('{"found":true,"snapshot":{"version":2}}') };
    const { http, service } = stack(gateway);
    const installationId = await createShip(http, service, "badhealth");
    const body = await page(http, `/admin/installations/${installationId}`);
    expect(body).toContain("Health unavailable");
    expect(body).toContain("failed");
  });
});

describe("operator audit log", () => {
  it("keeps the cause when the audit page cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audit = auditDb("SELECT");
    const { http } = stack(undefined, undefined, audit.db);
    audit.fail.on = true;
    const response = await http.handle(new Request(`${origin}/admin/audit`));
    expect(response?.status).toBe(503);
    expect(warn).toHaveBeenCalledWith("[Operator] Admin request failed:", "/admin/audit", expect.objectContaining({ exceptionName: "Error" }));
    warn.mockRestore();
  });

  it("records every Ship action with the operator and reason, and shows it on the Ship and audit pages", async () => {
    const ships = stack();
    const { http, service, insight } = ships;
    const installationId = await createShip(http, service, "audited");
    const path = `/admin/installations/${installationId}`;
    await http.handle(form(`${path}/onboarding`, {}));
    await activate(ships, installationId);
    await http.handle(form(`${path}/lifecycle`, { state: "restricted", reason: "abuse report 12" }));
    await http.handle(form(`${path}/lifecycle`, { state: "active" }));
    const reset = await http.handle(form(`${path}/reset`, { operationId: `reset_${crypto.randomUUID()}`, confirmHandle: "audited", reason: "owner asked" }));
    expect(reset?.status).toBe(201);

    const events = await insight.audit.list({ installationId, page: 1 });
    expect(events.events.map((event) => event.action)).toEqual([
      "ship.reset", "ship.reactivate", "ship.suspend", "ship.setup-link.reissue", "ship.create",
    ]);
    expect(events.events.every((event) => event.actor === "development")).toBe(true);
    expect(events.events.find((event) => event.action === "ship.suspend")?.reason).toBe("abuse report 12");
    expect(events.events.find((event) => event.action === "ship.reset")?.reason).toBe("owner asked");

    const audit = await page(http, "/admin/audit");
    expect(audit).toContain("ship.suspend");
    expect(audit).toContain("abuse report 12");
  });

  it("records the JSON operator API the same way", async () => {
    const ships = stack();
    const { http, service, insight } = ships;
    const installationId = await createShip(http, service, "jsonaudit");
    await activate(ships, installationId);
    const response = await http.handle(new Request(`${origin}/admin/api/installations/${installationId}/lifecycle`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ state: "restricted", reason: "chargeback" }),
    }));
    expect(response?.status).toBe(200);
    const [latest] = (await insight.audit.list({ installationId, page: 1 })).events;
    expect(latest).toMatchObject({ action: "ship.suspend", actor: "development", reason: "chargeback" });
  });

  it("records a refused action as an error", async () => {
    const { http, service, insight } = stack();
    const installationId = await createShip(http, service, "unchanged");
    const refused = await http.handle(form(`/admin/installations/${installationId}/reset`, {
      operationId: `reset_${crypto.randomUUID()}`, confirmHandle: "wrong",
    }));
    expect(refused?.status).not.toBe(201);
    const events = (await insight.audit.list({ installationId, page: 1 })).events;
    expect(events.map((event) => [event.action, event.outcome])).toEqual([["ship.reset", "error"], ["ship.create", "completed"]]);
    expect(await page(http, `/admin/installations/${installationId}`)).toContain("Returned an error");
  });

  it("changes nothing when the audit log cannot record the action", async () => {
    const audit = auditDb("INSERT INTO operator_audit_events");
    const ships = stack(undefined, undefined, audit.db);
    const { http, service } = ships;
    const installationId = await createShip(http, service, "unrecorded");
    await activate(ships, installationId);
    audit.fail.on = true;
    const suspend = await http.handle(form(`/admin/installations/${installationId}/lifecycle`, { state: "restricted" }));
    expect(suspend?.status).toBe(503);
    expect((await service.getInstallation(installationId))?.state).toBe("active");
    const create = await http.handle(form("/admin/installations", { operationId: `operation_${crypto.randomUUID()}`, handle: "neverborn" }));
    expect(create?.status).toBe(503);
    expect((await service.listInstallations({ query: "neverborn", state: null, page: 1 })).installations).toEqual([]);
  });

  it("still shows a new activation link when the Ship page's own reads fail", async () => {
    const audit = auditDb("SELECT");
    const { http } = stack(undefined, undefined, audit.db);
    audit.fail.on = true;
    const created = await http.handle(form("/admin/installations", { operationId: `operation_${crypto.randomUUID()}`, handle: "unreadable" }));
    expect(created?.status).toBe(201);
    expect(await created!.text()).toContain("ACTIVATION LINK ISSUED");
  });

  it("reports a committed action as done and keeps its record when the outcome cannot be written", async () => {
    const audit = auditDb("UPDATE operator_audit_events");
    const ships = stack(undefined, undefined, audit.db);
    const { http, service, insight } = ships;
    const installationId = await createShip(http, service, "halfrecorded");
    await activate(ships, installationId);
    audit.fail.on = true;
    const suspend = await http.handle(form(`/admin/installations/${installationId}/lifecycle`, { state: "restricted", reason: "abuse" }));
    expect(suspend?.status).toBe(303);
    expect((await service.getInstallation(installationId))?.state).toBe("restricted");
    const [latest] = (await insight.audit.list({ installationId, page: 1 })).events;
    expect(latest).toMatchObject({ action: "ship.suspend", reason: "abuse", outcome: "pending" });
    expect(await page(http, `/admin/installations/${installationId}`)).toContain("Outcome not recorded");
  });

  it("names the Access operator by the verified token's email", async () => {
    const access = new CloudflareInstallationAdminAccess({
      environment: "production", origin: "https://admin.example", teamDomain: "https://team.cloudflareaccess.com", audience: "aud",
    }, async () => ({ email: "operator@example.org" }));
    const request = new Request("https://admin.example/admin", { headers: { "cf-access-jwt-assertion": "token" } });
    await expect(access.operatorIdentity(request)).resolves.toBe("operator@example.org");
  });
});
