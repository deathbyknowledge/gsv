import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostedRepositoryModeration,
  PdsModerationService,
  PublicTakedown,
  RepositoryModeration,
  SubjectStatusQuery,
  SubjectStatusUpdate,
} from "@humansandmachines/gsv/services/pds";
import type { RequestReportSubmission } from "@humansandmachines/gsv/services/reports";
import { InstallationOnboardingStore } from "../onboarding";
import { CLOSED_MESSAGE_RETENTION_MS, RequestReports } from "../request-reports";
import { AccountStore } from "../store";
import { CloudflareInstallationAdminAccess, type InstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";
import { ShipTakedowns } from "./takedowns";

const db = env.INSTALLATIONS_DB;
const origin = "http://localhost:8976";
const SENDER = "did:plc:reportedsenderaaaaaaaaaa";
const ELSEWHERE = "did:plc:hostedelsewhereaaaaaaaaa";

beforeEach(async () => {
  await db.prepare("DELETE FROM request_reports").run();
});

describe("the operator's report queue", () => {
  it("lists open reports, and a report's page shows only what its person chose to share", async () => {
    const { sender, reporter, other } = await ships();
    const { http, reports } = stack(hostingPds(sender).moderation);
    const shared = await reports.submit(submission(reporter.installationId, {
      category: "harassment", message: { displayName: "<b>Stranger</b>", text: "Line one\n<script>alert(1)</script>" },
    }));
    const bare = await reports.submit(submission(other.installationId, { sender: { did: ELSEWHERE } }));

    const queue = await page(http, "/admin/reports");
    expect(queue).toContain('aria-current="page">Reports</a>');
    expect(queue).toContain("Open (2)");
    expect(queue).toContain("sender.ship.test");
    expect(queue).toContain(ELSEWHERE);
    expect(queue).toContain(reporter.handle);
    expect(queue).toContain(`href="/admin/reports/${shared.reportId}"`);
    expect(queue).toContain(`href="/admin/reports/${bare.reportId}"`);
    // The list names who and why; what the sender wrote stays on the report's own page.
    expect(queue).not.toContain("Line one");

    const report = await page(http, `/admin/reports/${shared.reportId}`);
    expect(report).toContain("&lt;b&gt;Stranger&lt;/b&gt;");
    expect(report).toContain("Line one\n&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).not.toContain("<script>alert(1)");
    expect(report).toContain(`href="/admin/installations/${sender.installationId}"`);
    expect(report).toContain(`action="/admin/reports/${shared.reportId}/takedown"`);
    expect(report).toContain(`action="/admin/reports/${shared.reportId}/dismiss"`);

    const unshared = await page(http, `/admin/reports/${bare.reportId}`);
    expect(unshared).toContain("didn't include");
    // A sender on another host can't be taken down from here.
    expect(unshared).toContain("hosted elsewhere");
    expect(unshared).not.toContain(`action="/admin/reports/${bare.reportId}/takedown"`);
    expect(unshared).toContain(`action="/admin/reports/${bare.reportId}/dismiss"`);

    expect((await http.handle(new Request(`${origin}/admin/reports/report_missing`)))?.status).toBe(404);
  });

  it("dismisses a report under its audit event, which its page then shows", async () => {
    const { sender, reporter } = await ships();
    const { http, reports, insight } = stack(hostingPds(sender).moderation);
    const { reportId } = await reports.submit(submission(reporter.installationId));
    const response = await http.handle(form(`/admin/reports/${reportId}/dismiss`, { reason: "Not spam: a friend's joke" }));
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(`/admin/reports/${reportId}`);

    const closed = await reports.get(reportId);
    expect(closed?.closed).toMatchObject({ resolution: "dismissed", eventId: expect.stringMatching(/^audit_/) });
    expect((await insight.audit.list({ page: 1 })).events[0]).toMatchObject({
      id: closed?.closed?.eventId, action: "report.dismiss", installationId: null, reason: "Not spam: a friend's joke",
      detail: { report: reportId }, outcome: "completed", actor: "development",
    });
    const report = await page(http, `/admin/reports/${reportId}`);
    expect(report).toContain("report.dismiss");
    expect(report).toContain("Not spam: a friend's joke");
    expect(report).not.toContain(`action="/admin/reports/${reportId}/dismiss"`);
    expect(await page(http, "/admin/reports")).toContain("Open (0)");
    expect(await page(http, "/admin/reports?state=closed")).toContain(`href="/admin/reports/${reportId}"`);

    const again = await http.handle(form(`/admin/reports/${reportId}/dismiss`, {}));
    expect(again?.status).toBe(400);
    expect(await again!.text()).toContain("request names a report that is already closed");
  });

  it("takes down a sender hosted here and closes each of their open reports under one audit event", async () => {
    const { sender, reporter, other } = await ships();
    // Relays hide a whole account, so the sender's Ship leaves its profile's copy as it is.
    const gateway = { operatorTakedownsChanged: vi.fn(async () => ({ found: true as const, copy: "unchanged" as const })) };
    const { pds, takedowns, moderation } = hostingPds(sender, { gateway });
    const { http, reports, insight } = stack(moderation);
    const first = await reports.submit(submission(reporter.installationId));
    const second = await reports.submit(submission(other.installationId, { category: "impersonation" }));
    const unrelated = await reports.submit(submission(other.installationId, { sender: { did: ELSEWHERE } }));
    expect(await page(http, `/admin/reports/${first.reportId}`)).toContain("2 open reports");

    const unexplained = await http.handle(form(`/admin/reports/${first.reportId}/takedown`, { reason: " " }));
    expect(unexplained?.status).toBe(400);
    expect(await unexplained!.text()).toContain("request reason is required");
    expect(pds.updateSubjectStatus).not.toHaveBeenCalled();

    const response = await http.handle(form(`/admin/reports/${first.reportId}/takedown`, { reason: "Spam in every message request" }));
    expect(response?.status).toBe(303);
    const [event] = (await insight.audit.list({ page: 1 })).events;
    expect(event).toMatchObject({
      action: "ship.takedown", installationId: sender.installationId, reason: "Spam in every message request",
      detail: { subject: "account", report: first.reportId, closed: "2", bluesky: "unchanged" }, outcome: "completed",
    });
    expect(gateway.operatorTakedownsChanged).toHaveBeenCalledExactlyOnceWith({ version: 1, installationId: sender.installationId });
    expect(pds.updateSubjectStatus).toHaveBeenCalledWith(sender.installationId, {
      subject: { $type: "com.atproto.admin.defs#repoRef", did: SENDER }, takedown: { applied: true, ref: event?.id },
      reason: "Spam in every message request",
    });
    expect(takedowns).toHaveLength(1);
    for (const { reportId } of [first, second]) {
      expect((await reports.get(reportId))?.closed).toMatchObject({ resolution: "taken-down", eventId: event?.id });
    }
    expect((await reports.get(unrelated.reportId))?.closed).toBeNull();
    const report = await page(http, `/admin/reports/${second.reportId}`);
    expect(report).toContain("ship.takedown");
    expect(report).toContain("Spam in every message request");
    expect(report).not.toContain(`action="/admin/reports/${second.reportId}/takedown"`);
  });

  it("shows every audit event that names a report in its trail, a failed takedown included", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sender, reporter } = await ships();
    const { pds, moderation } = hostingPds(sender);
    pds.updateSubjectStatus.mockRejectedValueOnce(new Error("The host refused the takedown"));
    const { http, reports, insight } = stack(moderation);
    const { reportId } = await reports.submit(submission(reporter.installationId));

    const failed = await http.handle(form(`/admin/reports/${reportId}/takedown`, { reason: "Spam in every message request" }));
    expect(failed?.status).toBe(503);
    const [attempt] = (await insight.audit.list({ page: 1 })).events;
    expect(attempt).toMatchObject({
      action: "ship.takedown", installationId: sender.installationId, reason: "Spam in every message request",
      detail: { subject: "account", report: reportId }, outcome: "error",
    });
    expect((await reports.get(reportId))?.closed).toBeNull();
    expect(await failed!.text()).toContain("Returned an error");

    expect((await http.handle(form(`/admin/reports/${reportId}/dismiss`, { reason: "Handled by email" })))?.status).toBe(303);
    const trail = await page(http, `/admin/reports/${reportId}`);
    expect(trail).toContain("Returned an error");
    expect(trail).toContain("Spam in every message request");
    expect(trail.indexOf("report.dismiss")).toBeGreaterThan(-1);
    expect(trail.indexOf("report.dismiss")).toBeLessThan(trail.indexOf("ship.takedown"));
    warn.mockRestore();
  });

  it("says a report closed 90 days ago no longer holds the sender's name or message", async () => {
    const { sender, reporter } = await ships();
    const { http } = stack(hostingPds(sender).moderation);
    const past = new RequestReports(db, () => Date.now() - CLOSED_MESSAGE_RETENTION_MS - 60_000);
    const { reportId } = await past.submit(submission(reporter.installationId, { message: { displayName: "Stranger", text: "Buy my coins" } }));
    await past.dismiss(reportId, "audit_lapsed");
    expect(await new RequestReports(db).forgetClosedMessages()).toBe(1);

    const report = await page(http, `/admin/reports/${reportId}`);
    expect(report).toContain("a closed report keeps them for 90 days at most");
    expect(report).not.toContain("Buy my coins");
    expect(await page(http, "/admin/reports?state=closed")).toContain("Not kept");
  });

  it("refuses to take down a sender the deployment's host doesn't hold, before acting", async () => {
    const { sender, reporter } = await ships();
    const { pds, moderation } = hostingPds(sender);
    const { http, reports, insight } = stack(moderation);
    const { reportId } = await reports.submit(submission(reporter.installationId, { sender: { did: ELSEWHERE } }));
    const audited = (await insight.audit.list({ page: 1 })).events.length;
    const response = await http.handle(form(`/admin/reports/${reportId}/takedown`, { reason: "Spam" }));
    expect(response?.status).toBe(400);
    expect(await response!.text()).toContain("request names a sender this deployment's host doesn't hold");
    expect(pds.updateSubjectStatus).not.toHaveBeenCalled();
    expect((await reports.get(reportId))?.closed).toBeNull();
    expect((await insight.audit.list({ page: 1 })).events).toHaveLength(audited);
  });

  it("still shows a report while the host can't be read, and offers no takedown without a PDS", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sender, reporter } = await ships();
    const { pds, moderation } = hostingPds(sender, { timeoutMs: 20 });
    const { http, reports } = stack(moderation);
    const { reportId } = await reports.submit(submission(reporter.installationId));
    pds.locateRepository.mockRejectedValueOnce(new Error("PDS reset because its code was updated"));
    expect(await page(http, `/admin/reports/${reportId}`)).toContain("could not be read: <strong>failed</strong>");
    pds.locateRepository.mockImplementationOnce(() => new Promise(() => {}));
    expect(await page(http, `/admin/reports/${reportId}`)).toContain("<strong>timed out</strong>");
    warn.mockRestore();

    const bare = stack();
    const withoutPds = await page(bare.http, `/admin/reports/${reportId}`);
    expect(withoutPds).not.toContain(`action="/admin/reports/${reportId}/takedown"`);
    expect(withoutPds).toContain(`action="/admin/reports/${reportId}/dismiss"`);
    expect((await bare.http.handle(form(`/admin/reports/${reportId}/takedown`, { reason: "Spam" })))?.status).toBe(404);
  });

  it("refuses report actions from another origin or without the operator's admission", async () => {
    const { sender, reporter } = await ships();
    const { reports, http } = stack(hostingPds(sender).moderation);
    const { reportId } = await reports.submit(submission(reporter.installationId));
    const crossOrigin = new Request(`${origin}/admin/reports/${reportId}/dismiss`, {
      method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ reason: "" }),
    });
    expect((await http.handle(crossOrigin))?.status).toBe(403);
    const denied = stack(hostingPds(sender).moderation, { allows: async () => false });
    expect((await denied.http.handle(new Request(`${origin}/admin/reports`)))?.status).toBe(403);
    expect((await denied.http.handle(form(`/admin/reports/${reportId}/dismiss`, {})))?.status).toBe(403);
    expect((await reports.get(reportId))?.closed).toBeNull();
  });
});

/** The deployment's PDS as Accounts' moderation binding reaches it: the sender's account on one of its Ships. */
function hostingPds(sender: { installationId: string }, options: ConstructorParameters<typeof ShipTakedowns>[1] = {}) {
  const takedowns: PublicTakedown[] = [];
  const repository = (): RepositoryModeration => ({ did: SENDER, handle: "sender.ship.test", takedowns: [...takedowns] });
  const pds = {
    getRepository: vi.fn(async (installationId: string) => installationId === sender.installationId ? repository() : null),
    updateSubjectStatus: vi.fn(async (_installationId: string, input: SubjectStatusUpdate) => {
      takedowns.push({ subject: input.subject, ref: input.takedown.ref ?? "unreferenced", reason: input.reason ?? null, at: Date.now() });
      return { subject: input.subject, takedown: input.takedown };
    }),
    getSubjectStatus: vi.fn(async (_installationId: string, _query: SubjectStatusQuery) => null),
    locateRepository: vi.fn(async (did: string): Promise<HostedRepositoryModeration | null> =>
      did === SENDER ? { ...repository(), installationId: sender.installationId } : null),
    reconcileAccountStatus: vi.fn(async (_installationId: string) => {}),
  } satisfies PdsModerationService;
  return { pds, takedowns, moderation: new ShipTakedowns(pds, options) };
}

function stack(moderation?: ShipTakedowns, access: InstallationAdminAccess = new CloudflareInstallationAdminAccess({ environment: "development", origin })) {
  const accounts = new AccountStore(db, "example.com");
  const onboarding = new InstallationOnboardingStore(db, accounts);
  const service = new InstallationAdminService(db, accounts, onboarding,
    { id: "principal_report_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {});
  const insight = new ShipInsight(db);
  const reports = new RequestReports(db);
  const http = new InstallationAdminHttp(service, access, origin, {}, undefined, insight, moderation, reports);
  return { http, insight, reports };
}

/** The sender's Ship, and two Ships whose people report requests. */
async function ships() {
  return { sender: await ship("sender"), reporter: await ship("reporter"), other: await ship("other") };
}

async function ship(label: string): Promise<{ installationId: string; handle: string }> {
  const accounts = new AccountStore(db, "example.com");
  const id = crypto.randomUUID();
  const principal = await accounts.createPrincipal({ email: `${id}@example.com`, displayName: label, verified: true });
  const { installationId, handle } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create-${id}`, handle: `${label}${id.slice(0, 6)}` });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(installationId).run();
  return { installationId, handle };
}

function submission(installationId: string, overrides: Partial<RequestReportSubmission> = {}): RequestReportSubmission {
  return {
    installationId, requestKey: `approach:${crypto.randomUUID()}`, sender: { did: SENDER, handle: "sender.ship.test" },
    category: "spam", receivedAtMs: Date.now() - 60_000, ...overrides,
  };
}

function form(path: string, values: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(values) });
}

async function page(http: InstallationAdminHttp, path: string): Promise<string> {
  const response = await http.handle(new Request(`${origin}${path}`));
  expect(response?.status).toBe(200);
  return await response!.text();
}
