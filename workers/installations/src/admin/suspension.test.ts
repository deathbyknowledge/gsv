import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdsModerationService } from "@humansandmachines/gsv/services/pds";
import InstallationService from "../index";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";
import { InstallationStateNotices } from "../state-notices";

const origin = "http://localhost:8976";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The deployment's PDS as Accounts' moderation binding reaches it. Each time
 * it is asked to follow an installation, it records the state Accounts holds
 * by then, as the PDS reads it back.
 */
function moderationPds() {
  const followed: Array<{ installationId: string; state: string | null }> = [];
  const pds = {
    getRepository: vi.fn(async () => null),
    updateSubjectStatus: vi.fn(async () => {
      throw new Error("No takedown is expected");
    }),
    getSubjectStatus: vi.fn(async () => null),
    locateRepository: vi.fn(async () => null),
    reconcileAccountStatus: vi.fn(async (installationId: string) => {
      const row = await env.INSTALLATIONS_DB.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first<{ state: string }>();
      followed.push({ installationId, state: row?.state ?? null });
    }),
  } satisfies PdsModerationService;
  return { pds, followed };
}

function stack(pds: PdsModerationService) {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "principal_suspension_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {},
    new InstallationStateNotices(env.INSTALLATIONS_DB, { pds }));
  const insight = new ShipInsight(env.INSTALLATIONS_DB);
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }),
    origin, {}, undefined, insight);
  return { service, onboarding, http, insight };
}

/** Accounts' cron, with the deployment's PDS bound. */
function cron(pds: PdsModerationService): Promise<void> {
  return new InstallationService(createExecutionContext(), { ...env, PDS_MODERATION: pds }).scheduled();
}

function form(path: string, values: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(values) });
}

function api(path: string, body: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
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

describe("suspending a Ship on the open network", () => {
  it("has the PDS follow once the Ship is suspended or reactivated, from a form or the JSON API", async () => {
    const { pds, followed } = moderationPds();
    const ships = stack(pds);
    const installationId = await activeShip(ships, "following");
    expect(pds.reconcileAccountStatus).not.toHaveBeenCalled();

    const suspended = await ships.http.handle(form(`/admin/installations/${installationId}/lifecycle`, { state: "restricted", reason: "abuse" }));
    expect(suspended?.status).toBe(303);
    const reactivated = await ships.http.handle(api(`/admin/api/installations/${installationId}/lifecycle`, { state: "active" }));
    expect(reactivated?.status).toBe(200);
    expect(followed).toEqual([{ installationId, state: "restricted" }, { installationId, state: "active" }]);
  });

  it("keeps the new state when the PDS can't be told, answers as done, and the cron tells it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pds, followed } = moderationPds();
    const ships = stack(pds);
    const installationId = await activeShip(ships, "unfollowed");
    pds.reconcileAccountStatus.mockRejectedValueOnce(new Error("PDS unavailable"));

    const suspended = await ships.http.handle(form(`/admin/installations/${installationId}/lifecycle`, { state: "restricted", reason: "abuse" }));
    expect(suspended?.status).toBe(303);
    expect(suspended?.headers.get("location")).toBe(`/admin/installations/${installationId}`);
    expect(warn).toHaveBeenCalledWith("[Lifecycle] Open-network host not yet told of a Ship's state:", installationId,
      expect.objectContaining({ exceptionMessage: "PDS unavailable" }));
    expect((await ships.service.getInstallation(installationId))?.state).toBe("restricted");
    expect(followed).toEqual([]);

    await cron(pds);
    expect(followed).toEqual([{ installationId, state: "restricted" }]);
  });

  it("answers the JSON API as done too, and the cron tells the PDS", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pds, followed } = moderationPds();
    const ships = stack(pds);
    const installationId = await activeShip(ships, "apifollow");
    pds.reconcileAccountStatus.mockRejectedValueOnce(new Error("PDS unavailable"));

    const suspended = await ships.http.handle(api(`/admin/api/installations/${installationId}/lifecycle`, { state: "restricted" }));
    expect(suspended?.status).toBe(200);
    expect(await suspended!.json()).toEqual({ installationId, state: "restricted" });
    await cron(pds);
    expect(followed).toEqual([{ installationId, state: "restricted" }]);
  });
});

