import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdsModerationService } from "@humansandmachines/gsv/services/pds";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";

const origin = "http://localhost:8976";
const NOT_TOLD = "The Ship is suspended, but its open-network host could not be told.";

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
    { id: "principal_suspension_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {}, pds);
  const insight = new ShipInsight(env.INSTALLATIONS_DB);
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }),
    origin, {}, undefined, insight);
  return { service, onboarding, http, insight };
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

  it("keeps the new state when the PDS can't follow, and the error page's Try again tells it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pds, followed } = moderationPds();
    const ships = stack(pds);
    const { http, service, insight } = ships;
    const installationId = await activeShip(ships, "unfollowed");
    const path = `/admin/installations/${installationId}/lifecycle`;
    pds.reconcileAccountStatus.mockRejectedValueOnce(new Error("PDS unavailable"));

    const failed = await http.handle(form(path, { state: "restricted", reason: "abuse" }));
    expect(failed?.status).toBe(503);
    const page = await failed!.text();
    const retry = tryAgain(page);
    expect(retry).toEqual({ method: "post", action: path, values: { reason: "abuse", state: "restricted" } });
    expect(page).toContain(NOT_TOLD);
    expect(warn).toHaveBeenCalledWith("[Operator] Admin request failed:", path, expect.objectContaining({ exceptionCause: "PDS unavailable" }));
    expect((await service.getInstallation(installationId))?.state).toBe("restricted");

    // Trying again sets the state Accounts already holds, tells the PDS, and is audited on its own.
    const repeated = await http.handle(form(retry!.action, retry!.values));
    expect(repeated?.status).toBe(303);
    expect(repeated?.headers.get("location")).toBe(`/admin/installations/${installationId}`);
    expect(followed).toEqual([{ installationId, state: "restricted" }]);
    expect((await service.getInstallation(installationId))?.state).toBe("restricted");
    expect((await insight.audit.list({ installationId, page: 1 })).events.slice(0, 2)).toMatchObject([
      { action: "ship.suspend", outcome: "completed", reason: "abuse" },
      { action: "ship.suspend", outcome: "error", reason: "abuse" },
    ]);
  });

  it("answers the JSON API with the same error, and setting the same state again there tells the PDS", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pds, followed } = moderationPds();
    const ships = stack(pds);
    const installationId = await activeShip(ships, "apifollow");
    const path = `/admin/api/installations/${installationId}/lifecycle`;
    pds.reconcileAccountStatus.mockRejectedValueOnce(new Error("PDS unavailable"));

    const failed = await ships.http.handle(api(path, { state: "restricted" }));
    expect(failed?.status).toBe(503);
    expect(await failed!.json()).toEqual({ error: NOT_TOLD });
    const repeated = await ships.http.handle(api(path, { state: "restricted" }));
    expect(repeated?.status).toBe(200);
    expect(await repeated!.json()).toEqual({ installationId, state: "restricted" });

    pds.reconcileAccountStatus.mockRejectedValueOnce(new Error("PDS unavailable"));
    const unfollowed = await ships.http.handle(api(path, { state: "active" }));
    expect(await unfollowed!.json()).toEqual({ error: "The Ship is reactivated, but its open-network host could not be told." });
    expect(followed).toEqual([{ installationId, state: "restricted" }]);
  });
});

/** The page's Try again form, as a browser submits it. */
function tryAgain(page: string): { method: string; action: string; values: Record<string, string> } | undefined {
  const form = page.split("<form").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("</form>"))).find((chunk) => chunk.includes(">Try again<"));
  if (!form) return undefined;
  const values = Object.fromEntries([...form.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)].map(([, name, value]) => [name, value]));
  return { method: /method="([^"]*)"/.exec(form)?.[1] ?? "", action: /action="([^"]*)"/.exec(form)?.[1] ?? "", values };
}
