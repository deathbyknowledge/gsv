import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  ModerationSubject,
  PdsModerationService,
  PublicTakedown,
  RepositoryModeration,
  SubjectStatusQuery,
  SubjectStatusUpdate,
} from "@humansandmachines/gsv/services/pds";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";
import { ShipTakedowns } from "./takedowns";

const origin = "http://localhost:8976";
const DID = "did:plc:takedownshipaaaaaaaaaaaa";
const PROFILE = `at://${DID}/space.ship.profile/self`;
const PICTURE = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/**
 * The deployment's PDS as Accounts' moderation binding reaches it: one Ship's
 * account with its profile record, and what the operator has taken down.
 */
function moderationPds(timeoutMs?: number) {
  const takedowns: PublicTakedown[] = [];
  const key = (subject: ModerationSubject) => subject.$type === "com.atproto.admin.defs#repoRef" ? subject.did
    : subject.$type === "com.atproto.repo.strongRef" ? subject.uri : subject.cid;
  const pds = {
    getRepository: vi.fn(async (_installationId: string): Promise<RepositoryModeration | null> =>
      ({ did: DID, handle: "takedown.ship.space", takedowns: [...takedowns] })),
    updateSubjectStatus: vi.fn(async (_installationId: string, input: SubjectStatusUpdate) => {
      const index = takedowns.findIndex((takedown) => key(takedown.subject) === key(input.subject));
      if (index >= 0) takedowns.splice(index, 1);
      if (input.takedown.applied) {
        takedowns.push({ subject: input.subject, ref: input.takedown.ref ?? "unreferenced", reason: input.reason ?? null, at: Date.now() });
      }
      return { subject: input.subject, takedown: input.takedown };
    }),
    getSubjectStatus: vi.fn(async (_installationId: string, query: SubjectStatusQuery) => query.uri === PROFILE
      ? { subject: { $type: "com.atproto.repo.strongRef" as const, uri: PROFILE, cid: "bafyreiprofile" }, takedown: { applied: false } }
      : null),
    locateRepository: vi.fn(async (_did: string) => null),
    reconcileAccountStatus: vi.fn(async (_installationId: string) => {}),
  } satisfies PdsModerationService;
  return { pds, takedowns, moderation: new ShipTakedowns(pds, timeoutMs) };
}

function stack(moderation?: ShipTakedowns) {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "principal_takedown_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {});
  const insight = new ShipInsight(env.INSTALLATIONS_DB);
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }),
    origin, {}, undefined, insight, moderation);
  return { service, onboarding, http, insight };
}

function form(path: string, values: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(values) });
}

function api(path: string, body?: Record<string, string>): Request {
  return body
    ? new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) })
    : new Request(`${origin}${path}`);
}

async function page(http: InstallationAdminHttp, path: string): Promise<string> {
  const response = await http.handle(new Request(`${origin}${path}`));
  expect(response?.status).toBe(200);
  return await response!.text();
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

describe("open-network takedowns", () => {
  it("takes down a Ship's record, blob or account with the operator's reason under its audit event, and restores each", async () => {
    const { pds, takedowns, moderation } = moderationPds();
    const ships = stack(moderation);
    const { http, insight } = ships;
    const installationId = await activeShip(ships, "takedown");
    const path = `/admin/installations/${installationId}`;
    const before = await page(http, path);
    expect(before).toContain(DID);
    expect(before).toContain("Nothing is taken down");

    // The Ship's person reads the reason, so a takedown has one.
    const unexplained = await http.handle(form(`${path}/takedowns`, { subject: "account", uri: "", cid: "", reason: "  " }));
    expect(unexplained?.status).toBe(400);
    expect(await unexplained!.text()).toContain("request reason is required");
    expect(pds.updateSubjectStatus).not.toHaveBeenCalled();

    const subjects: [Record<string, string>, ModerationSubject][] = [
      [{ subject: "record", uri: PROFILE, cid: "", reason: "It impersonates a public figure" },
        { $type: "com.atproto.repo.strongRef", uri: PROFILE, cid: "bafyreiprofile" }],
      [{ subject: "blob", uri: "", cid: PICTURE, reason: "An explicit picture" },
        { $type: "com.atproto.admin.defs#repoBlobRef", did: DID, cid: PICTURE }],
      [{ subject: "account", uri: "", cid: "", reason: "Spam in every message request" },
        { $type: "com.atproto.admin.defs#repoRef", did: DID }],
    ];
    for (const [values, subject] of subjects) {
      const response = await http.handle(form(`${path}/takedowns`, values));
      expect(response?.status).toBe(303);
      expect(response?.headers.get("location")).toBe(path);
      expect(pds.updateSubjectStatus).toHaveBeenLastCalledWith(installationId, {
        subject, takedown: { applied: true, ref: expect.stringMatching(/^audit_/) }, reason: values.reason,
      });
    }
    // Each takedown the PDS holds names the audit event that records it.
    const events = (await insight.audit.list({ installationId, page: 1 })).events;
    const applied = events.filter((event) => event.action === "ship.takedown").reverse();
    expect(applied.map((event) => [event.reason, event.detail, event.outcome])).toEqual([
      ["It impersonates a public figure", { subject: "record" }, "completed"],
      ["An explicit picture", { subject: "blob" }, "completed"],
      ["Spam in every message request", { subject: "account" }, "completed"],
    ]);
    expect(takedowns.map((takedown) => takedown.ref)).toEqual(applied.map((event) => event.id));
    const after = await page(http, path);
    for (const reason of ["It impersonates a public figure", "An explicit picture", "Spam in every message request"]) {
      expect(after).toContain(reason);
    }
    expect(after).toContain(PROFILE);
    expect(after).toContain(PICTURE);

    const restored = await http.handle(form(`${path}/takedowns/restore`, { subject: PROFILE, reason: "Verified as the real person" }));
    expect(restored?.status).toBe(303);
    expect(pds.updateSubjectStatus).toHaveBeenLastCalledWith(installationId, {
      subject: { $type: "com.atproto.repo.strongRef", uri: PROFILE, cid: "bafyreiprofile" }, takedown: { applied: false },
    });
    expect((await insight.audit.list({ installationId, page: 1 })).events[0]).toMatchObject({
      action: "ship.restore", reason: "Verified as the real person", detail: { subject: "record" }, outcome: "completed",
    });
    expect(takedowns.map((takedown) => takedown.subject.$type)).toEqual(["com.atproto.admin.defs#repoBlobRef", "com.atproto.admin.defs#repoRef"]);

    // Restoring what isn't taken down changes nothing, and says so.
    const absent = await http.handle(form(`${path}/takedowns/restore`, { subject: PROFILE }));
    expect(absent?.status).toBe(400);
    expect(await absent!.text()).toContain("request names nothing this Ship has taken down");
  });

  it("refuses a record its Ship's repository doesn't hold, and records the refusal", async () => {
    const { pds, moderation } = moderationPds();
    const ships = stack(moderation);
    const installationId = await activeShip(ships, "norecord");
    const path = `/admin/installations/${installationId}`;
    const missing = `at://${DID}/space.ship.note/missing`;
    const response = await ships.http.handle(form(`${path}/takedowns`, { subject: "record", uri: missing, cid: "", reason: "Abuse" }));
    expect(response?.status).toBe(400);
    expect(await response!.text()).toContain(`request names no record of this Ship: ${missing}`);
    expect(pds.updateSubjectStatus).not.toHaveBeenCalled();
    expect((await ships.insight.audit.list({ installationId, page: 1 })).events[0]).toMatchObject({ action: "ship.takedown", outcome: "error" });
    const incomplete: Record<string, string>[] = [
      { subject: "record", uri: "", cid: "", reason: "Abuse" }, { subject: "blob", uri: "", cid: "", reason: "Abuse" }, { subject: "profile", reason: "Abuse" },
    ];
    for (const values of incomplete) {
      expect((await ships.http.handle(form(`${path}/takedowns`, values)))?.status).toBe(400);
    }
  });

  it("answers the JSON operator API with the same audit", async () => {
    const { moderation } = moderationPds();
    const ships = stack(moderation);
    const installationId = await activeShip(ships, "jsontakedown");
    const path = `/admin/api/installations/${installationId}/takedowns`;
    const applied = await ships.http.handle(api(path, { subject: "record", uri: PROFILE, reason: "Impersonation" }));
    expect(applied?.status).toBe(200);
    expect(await applied!.json()).toEqual({
      subject: { $type: "com.atproto.repo.strongRef", uri: PROFILE, cid: "bafyreiprofile" },
      takedown: { applied: true, ref: expect.stringMatching(/^audit_/) },
    });
    const listed = await ships.http.handle(api(path));
    expect(await listed!.json()).toMatchObject({ did: DID, takedowns: [{ reason: "Impersonation", subject: { uri: PROFILE } }] });
    expect((await ships.http.handle(api(`${path}/restore`, { subject: PROFILE })))?.status).toBe(200);
    expect((await ships.http.handle(api(path, { subject: "account" })))?.status).toBe(400);
    const actions = (await ships.insight.audit.list({ installationId, page: 1 })).events.map((event) => event.action);
    expect(actions).toEqual(["ship.restore", "ship.takedown", "ship.create"]);
  });

  it("still renders the Ship page while the PDS can't be read, and keeps the cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pds, moderation } = moderationPds(20);
    const ships = stack(moderation);
    const installationId = await activeShip(ships, "pdsdown");
    const path = `/admin/installations/${installationId}`;
    pds.getRepository.mockRejectedValueOnce(new Error("PDS reset because its code was updated"));
    expect(await page(ships.http, path)).toContain("The Ship's open-network host could not be read: <strong>failed</strong>");
    expect(warn).toHaveBeenCalledWith("[Operator] Ship takedowns unavailable:",
      expect.objectContaining({ exceptionMessage: "PDS reset because its code was updated" }));
    pds.getRepository.mockImplementationOnce(() => new Promise(() => {}));
    expect(await page(ships.http, path)).toContain("<strong>timed out</strong>");
    pds.getRepository.mockResolvedValueOnce(null);
    expect(await page(ships.http, path)).toContain("no repository on the open network yet");
    warn.mockRestore();
  });

  it("offers no takedowns on a deployment without a PDS", async () => {
    const ships = stack();
    const installationId = await activeShip(ships, "nopds");
    expect(await page(ships.http, `/admin/installations/${installationId}`)).not.toContain("OPEN NETWORK");
    const response = await ships.http.handle(form(`/admin/installations/${installationId}/takedowns`, { subject: "account", reason: "Spam" }));
    expect(response?.status).toBe(404);
  });
});
