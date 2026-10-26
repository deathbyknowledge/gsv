import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationAdmissionService, InstallationStateChangedRequest } from "@humansandmachines/gsv/services/lifecycle";
import InstallationService from "./index";
import { InstallationAdminStore } from "./administration";
import { CloudflareInstallationAdminAccess } from "./admin/access";
import { InstallationAdminHttp } from "./admin/http";
import { InstallationAdminService } from "./admin/service";
import { AccountsDeletionRuntime } from "./deletion-runtime";
import { InstallationOnboardingStore } from "./onboarding";
import { changeInstallationState, InstallationStateNotices } from "./state-notices";
import { AccountStore } from "./store";

const origin = "http://localhost:8976";
const db = env.INSTALLATIONS_DB;
const accounts = new AccountStore(db, "example.com");
const NOT_CONFIRMED = "The Ship is suspended, but it hasn't confirmed yet. Accounts keeps telling it.";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The Gateway's admission entrypoint as Accounts reaches it: it reads the
 * installation back from the directory, and its Kernel keeps what it read.
 */
function admissionGateway() {
  const kept: Array<{ installationId: string; state: string; stateRevision: number }> = [];
  const service = {
    installationStateChanged: vi.fn(async ({ installationId }: InstallationStateChangedRequest) => {
      const installation = await accounts.resolveInstallation(installationId, { stateRevision: true });
      if (!installation.found || installation.stateRevision === undefined) return { found: false as const };
      kept.push({ installationId, state: installation.state, stateRevision: installation.stateRevision });
      return { found: true as const, stateRevision: installation.stateRevision };
    }),
  } satisfies InstallationAdmissionService;
  return { service, kept, last: (installationId: string) => kept.filter((entry) => entry.installationId === installationId).at(-1) };
}

function stack(admission?: InstallationAdmissionService) {
  const onboarding = new InstallationOnboardingStore(db, accounts);
  const notices = admission ? new InstallationStateNotices(db, admission) : undefined;
  const service = new InstallationAdminService(db, accounts, onboarding,
    { id: "principal_state_notice_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {}, undefined, notices);
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }), origin);
  return { service, onboarding, http, notices };
}

async function activeShip({ http, service, onboarding }: ReturnType<typeof stack>, handle: string): Promise<string> {
  await http.handle(form("/admin/installations", { operationId: `operation_${crypto.randomUUID()}`, handle }));
  const installationId = (await service.listInstallations({ query: handle, state: null, page: 1 })).installations[0]!.installationId;
  const issued = await service.reissueOnboarding(installationId);
  const authorized = await onboarding.authorize({ installationId, token: new URL(issued.onboarding.onboardingUrl).hash.slice(1) });
  if (!authorized.ok) throw new Error("Expected valid onboarding");
  await onboarding.complete({ installationId, claimId: authorized.claimId });
  return installationId;
}

async function notice(installationId: string) {
  return await db.prepare(`SELECT state, revision, delivered_revision AS delivered, attempted_at AS attemptedAt
    FROM installation_state_notices WHERE installation_id = ?`).bind(installationId)
    .first<{ state: string; revision: number; delivered: number; attemptedAt: number }>();
}

function form(path: string, values: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(values) });
}

function api(path: string, body: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function cron(admission: InstallationAdmissionService): Promise<void> {
  return new InstallationService(createExecutionContext(), { ...env, ADMISSION_GATEWAY: admission }).scheduled();
}

describe("an installation's changes of state", () => {
  it("each take a higher revision in the write that makes them, even when the clock stands still", async () => {
    const ships = stack();
    const installationId = await activeShip(ships, "noticecount");
    const activated = (await notice(installationId))!;
    expect(activated).toMatchObject({ state: "active", delivered: 0 });

    const admin = new InstallationAdminStore(db);
    await admin.setInstallationState(installationId, "restricted");
    const suspended = (await notice(installationId))!;
    expect(suspended).toMatchObject({ state: "restricted", delivered: 0, attemptedAt: 0 });
    expect(suspended.revision).toBeGreaterThan(activated.revision);
    await admin.setInstallationState(installationId, "restricted");
    expect(await notice(installationId)).toEqual(suspended);
    await admin.setInstallationState(installationId, "active");
    const reactivated = (await notice(installationId))!;
    expect(reactivated).toMatchObject({ state: "active" });
    expect(reactivated.revision).toBeGreaterThan(suspended.revision);

    await changeInstallationState(db, installationId, [db.prepare("UPDATE installations SET state = 'restricted' WHERE id = ?").bind(installationId)], 5);
    await changeInstallationState(db, installationId, [db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(installationId)], 5);
    expect(await notice(installationId)).toMatchObject({ state: "active", revision: reactivated.revision + 2 });
  });

  it("are reported by the directory only when it is asked for them", async () => {
    const installationId = await activeShip(stack(), "noticereport");
    expect(await accounts.resolveInstallation(installationId, { stateRevision: true }))
      .toMatchObject({ state: "active", stateRevision: (await notice(installationId))!.revision });
    await new InstallationAdminStore(db).setInstallationState(installationId, "restricted");
    await new InstallationAdminStore(db).setInstallationState(installationId, "active");
    const { revision } = (await notice(installationId))!;
    expect(await accounts.resolveInstallation(installationId)).not.toHaveProperty("stateRevision");
    expect(await accounts.resolveInstallation(installationId, { stateRevision: true })).toMatchObject({ state: "active", stateRevision: revision });
    const principal = await accounts.createPrincipal({ email: "unchanged@example.com", displayName: "Owner", verified: true });
    const reserved = await accounts.reserveInstallation({ principalId: principal.id, operationId: "create_noticeunchanged", handle: "noticeunchanged" });
    expect(await accounts.resolveInstallation(reserved.installationId, { stateRevision: true })).toMatchObject({ state: "reserved", stateRevision: 0 });

    // Accounts reports revisions only while it can tell the Gateway of each change.
    expect(await new InstallationService(createExecutionContext(), env).resolveInstallation(installationId)).not.toHaveProperty("stateRevision");
    expect(await new InstallationService(createExecutionContext(), { ...env, ADMISSION_GATEWAY: admissionGateway().service })
      .resolveInstallation(installationId)).toMatchObject({ stateRevision: revision });
  });

  it("leave with their installation", async () => {
    const principal = await accounts.createPrincipal({ email: "leaving@example.com", displayName: "Owner", verified: true });
    const { installationId } = await accounts.reserveInstallation({ principalId: principal.id, operationId: "create_noticeleaving", handle: "noticeleaving" });
    await changeInstallationState(db, installationId, []);
    expect(await notice(installationId)).toMatchObject({ state: "reserved" });
    await db.prepare("DELETE FROM installations WHERE id = ?").bind(installationId).run();
    expect(await notice(installationId)).toBeNull();
  });
});

describe("telling a Ship's Kernel of its state", () => {
  it("tells it at once when an operator suspends or reactivates the Ship", async () => {
    const gateway = admissionGateway();
    const ships = stack(gateway.service);
    const installationId = await activeShip(ships, "noticepush");
    const path = `/admin/installations/${installationId}/lifecycle`;

    expect((await ships.http.handle(form(path, { state: "restricted", reason: "abuse" })))?.status).toBe(303);
    const suspended = (await notice(installationId))!;
    expect(gateway.last(installationId)).toEqual({ installationId, state: "restricted", stateRevision: suspended.revision });
    expect(suspended.delivered).toBe(suspended.revision);

    expect((await ships.http.handle(api(`/admin/api/installations/${installationId}/lifecycle`, { state: "active" })))?.status).toBe(200);
    const reactivated = (await notice(installationId))!;
    expect(gateway.last(installationId)).toEqual({ installationId, state: "active", stateRevision: reactivated.revision });
    expect(reactivated.delivered).toBe(reactivated.revision);
  });

  it("keeps a notice the Ship missed, says the Ship hasn't confirmed, and the cron tells it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = admissionGateway();
    const ships = stack(gateway.service);
    const installationId = await activeShip(ships, "noticemissed");
    const path = `/admin/installations/${installationId}/lifecycle`;
    gateway.service.installationStateChanged.mockRejectedValueOnce(new Error("Gateway unavailable"));

    const failed = await ships.http.handle(form(path, { state: "restricted", reason: "abuse" }));
    expect(failed?.status).toBe(503);
    const page = await failed!.text();
    expect(page).toContain(NOT_CONFIRMED);
    expect(page).toContain(">Try again<");
    expect(warn).toHaveBeenCalledWith("[Lifecycle] Ship not yet told of its state:", installationId,
      expect.objectContaining({ exceptionMessage: "Gateway unavailable" }));
    expect((await ships.service.getInstallation(installationId))?.state).toBe("restricted");
    const missed = (await notice(installationId))!;
    expect(missed.delivered).toBeLessThan(missed.revision);
    expect(missed.attemptedAt).toBeGreaterThan(0);

    await cron(gateway.service);
    expect(gateway.last(installationId)).toEqual({ installationId, state: "restricted", stateRevision: missed.revision });
    expect((await notice(installationId))!.delivered).toBe(missed.revision);
  });

  it("answers the JSON API the same way, and setting the state again tells the Ship", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = admissionGateway();
    const ships = stack(gateway.service);
    const installationId = await activeShip(ships, "noticeapi");
    const path = `/admin/api/installations/${installationId}/lifecycle`;
    gateway.service.installationStateChanged.mockRejectedValueOnce(new Error("Gateway unavailable"));

    const failed = await ships.http.handle(api(path, { state: "restricted" }));
    expect(failed?.status).toBe(503);
    expect(await failed!.json()).toEqual({ error: NOT_CONFIRMED });
    const repeated = await ships.http.handle(api(path, { state: "restricted" }));
    expect(repeated?.status).toBe(200);
    expect(gateway.last(installationId)?.state).toBe("restricted");
  });

  it("leaves a newer change pending when the Kernel read an older one", async () => {
    const gateway = admissionGateway();
    const ships = stack(gateway.service);
    const installationId = await activeShip(ships, "noticelate");
    gateway.service.installationStateChanged.mockImplementationOnce(async ({ installationId: id }) => {
      const read = await accounts.resolveInstallation(id, { stateRevision: true });
      if (!read.found || read.stateRevision === undefined) throw new Error("Expected the installation");
      // Another operator reactivates the Ship before this answer reaches Accounts.
      await new InstallationAdminStore(db).setInstallationState(id, "active");
      return { found: true, stateRevision: read.stateRevision };
    });

    await ships.service.setInstallationState(installationId, "restricted");
    const late = (await notice(installationId))!;
    expect(late.delivered).toBeLessThan(late.revision);
    expect(await ships.notices!.deliver(installationId)).toBe(true);
    expect(gateway.last(installationId)).toEqual({ installationId, state: "active", stateRevision: late.revision });
    expect((await notice(installationId))!.delivered).toBe(late.revision);

    await new InstallationAdminStore(db).setInstallationState(installationId, "restricted");
    gateway.service.installationStateChanged.mockResolvedValueOnce({ found: true, stateRevision: late.revision });
    expect(await ships.notices!.deliver(installationId)).toBe(false);
    expect((await notice(installationId))!.delivered).toBe(late.revision);
  });

  it("tells a Ship that was reset or retired, so it stops its own work", async () => {
    const gateway = admissionGateway();
    const ships = stack(gateway.service);
    const reset = await activeShip(ships, "noticereset");
    const replacement = await ships.service.resetInstallation(reset, { operationId: "reset_noticereset", confirmHandle: "noticereset" });
    expect(replacement.reset?.previousInstallationId).toBe(reset);
    expect(gateway.last(reset)).toMatchObject({ state: "retained" });
    expect((await notice(reset))!.delivered).toBe((await notice(reset))!.revision);

    const retired = await activeShip(ships, "noticeretire");
    await new AccountsDeletionRuntime(db, {}, undefined, 20, Date.now, {}, undefined, ships.notices)
      .retire(retired, { operationId: "retire_noticeretire", confirmHandle: "noticeretire" });
    expect(gateway.last(retired)).toMatchObject({ state: "retained" });
    expect((await notice(retired))!.delivered).toBe((await notice(retired))!.revision);
  });

  it("retries from the cron in bounded batches, least recently tried first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.prepare("UPDATE installation_state_notices SET delivered_revision = revision").run();
    const principal = await accounts.createPrincipal({ email: "batch@example.com", displayName: "Owner", verified: true });
    const ids: string[] = [];
    for (let index = 0; index < 22; index++) {
      const { installationId } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create_noticebatch${index}`, handle: `noticebatch${index}` });
      ids.push(installationId);
    }
    for (const installationId of ids) await changeInstallationState(db, installationId, []);
    const unreachable = { installationStateChanged: vi.fn(async (_input: InstallationStateChangedRequest): Promise<never> => {
      throw new Error("Gateway unavailable");
    }) };

    await new InstallationStateNotices(db, unreachable, () => 1_000).resumePending();
    expect(unreachable.installationStateChanged).toHaveBeenCalledTimes(20);
    const untried = (await db.prepare("SELECT installation_id FROM installation_state_notices WHERE attempted_at = 0 AND delivered_revision < revision")
      .all<{ installation_id: string }>()).results.map(({ installation_id }) => installation_id);
    expect(untried).toHaveLength(2);

    unreachable.installationStateChanged.mockClear();
    await new InstallationStateNotices(db, unreachable, () => 2_000).resumePending();
    const retried = unreachable.installationStateChanged.mock.calls.map(([input]) => input.installationId);
    expect(retried).toHaveLength(20);
    expect(retried).toEqual(expect.arrayContaining(untried));

    const gateway = admissionGateway();
    await new InstallationStateNotices(db, gateway.service).resumePending();
    await new InstallationStateNotices(db, gateway.service).resumePending();
    expect((await db.prepare("SELECT COUNT(*) AS count FROM installation_state_notices WHERE delivered_revision < revision")
      .first<{ count: number }>())?.count).toBe(0);
  });
});
