import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestReportSubmission } from "@humansandmachines/gsv/services/reports";
import InstallationService from "./index";
import { CLOSED_MESSAGE_RETENTION_MS, RequestReports, RequestReportsEntrypoint } from "./request-reports";
import { AccountStore } from "./store";

const db = env.INSTALLATIONS_DB;
const SENDER = "did:plc:reportedsenderaaaaaaaaaa";
const OTHER_SENDER = "did:plc:anothersenderaaaaaaaaaaa";
const RECEIVED_AT = 1_790_000_000_000;

beforeEach(async () => {
  await db.prepare("DELETE FROM request_reports").run();
});

describe("filing a report", () => {
  it("keeps the sender, the category and the times, and the message only when the person included it", async () => {
    const ship = await activeShip();
    const reports = new RequestReports(db, () => 1_800_000_000_000);
    const bare = await reports.submit(submission(ship.installationId));
    expect(bare).toEqual({ reportId: expect.stringMatching(/^report_/), reportedAtMs: 1_800_000_000_000 });
    expect(await reports.get(bare.reportId)).toEqual({
      id: bare.reportId, installationId: ship.installationId, handle: ship.handle,
      sender: { did: SENDER, handle: "stranger.ship.test" }, category: "spam", message: null,
      receivedAt: RECEIVED_AT, reportedAt: 1_800_000_000_000, closed: null,
    });

    const included = await reports.submit(submission(ship.installationId, {
      category: "harassment", sender: { did: SENDER }, message: { displayName: "Stranger", text: "<b>hello</b> there" },
    }));
    expect(await reports.get(included.reportId)).toMatchObject({
      sender: { did: SENDER, handle: null }, category: "harassment", message: { displayName: "Stranger", text: "<b>hello</b> there" },
    });
  });

  it("files each request once: reporting it again returns the first report unchanged", async () => {
    const ship = await activeShip();
    let now = 1_800_000_000_000;
    const reports = new RequestReports(db, () => now);
    const input = submission(ship.installationId);
    const first = await reports.submit(input);
    now += 60_000;
    expect(await reports.submit({ ...input, category: "other", message: { displayName: "Stranger", text: "later" } })).toEqual(first);
    expect(await reports.get(first.reportId)).toMatchObject({ category: "spam", message: null, reportedAt: first.reportedAtMs });
    expect((await reports.list({ state: "open", page: 1 })).reports).toHaveLength(1);
  });

  it.each<[string, (installationId: string) => RequestReportSubmission]>([
    ["a sender that is no DID", (installationId) => submission(installationId, { sender: { did: "stranger.ship.test" } })],
    // SAFETY: The case sends what an older or hostile caller could, past the contract's type.
    ["an unknown category", (installationId) => ({ ...submission(installationId), category: "rude" as "spam" })],
    ["an empty message", (installationId) => submission(installationId, { message: { displayName: "Stranger", text: "" } })],
    ["a message longer than a request", (installationId) => submission(installationId, { message: { displayName: "Stranger", text: "a".repeat(32_769) } })],
    ["a field the contract doesn't name", (installationId) => ({ ...submission(installationId), contact: "stranger@example.com" })],
  ])("refuses %s before writing", async (_label, build) => {
    const ship = await activeShip();
    await expect(new RequestReports(db).submit(build(ship.installationId))).rejects.toThrow();
    expect((await new RequestReports(db).list({ state: "open", page: 1 })).reports).toEqual([]);
  });
});

describe("the operator's queue", () => {
  it("lists open reports newest first, and closed ones by when they closed", async () => {
    const ship = await activeShip();
    let now = 1_800_000_000_000;
    const reports = new RequestReports(db, () => now);
    const older = await reports.submit(submission(ship.installationId));
    now += 1_000;
    const newer = await reports.submit(submission(ship.installationId, { sender: { did: OTHER_SENDER } }));
    now += 1_000;
    const third = await reports.submit(submission(ship.installationId));

    expect(await reports.list({ state: "open", page: 1 })).toMatchObject({
      state: "open", page: 1, totalPages: 1, counts: { open: 3, closed: 0 },
      reports: [{ id: third.reportId }, { id: newer.reportId }, { id: older.reportId }],
    });
    now += 1_000;
    await reports.dismiss(newer.reportId, "audit_dismissed");
    now += 1_000;
    await reports.dismiss(older.reportId, "audit_dismissed_again");
    expect(await reports.list({ state: "open", page: 1 })).toMatchObject({ counts: { open: 1, closed: 2 }, reports: [{ id: third.reportId }] });
    expect((await reports.list({ state: "closed", page: 1 })).reports.map((report) => report.id)).toEqual([older.reportId, newer.reportId]);
    expect((await reports.list({ state: "open", page: 2, pageSize: 1 })).reports).toEqual([]);
    await expect(reports.list({ state: "open", page: 0 })).rejects.toThrow("page is invalid");
  });

  it("closes a report once, keeping the audit event that closed it", async () => {
    const ship = await activeShip();
    const reports = new RequestReports(db, () => 1_800_000_000_000);
    const { reportId } = await reports.submit(submission(ship.installationId));
    await reports.dismiss(reportId, "audit_dismissed");
    expect((await reports.get(reportId))?.closed).toEqual({ at: 1_800_000_000_000, resolution: "dismissed", eventId: "audit_dismissed" });
    await expect(reports.dismiss(reportId, "audit_again")).rejects.toThrow("request names a report that is already closed");
    await expect(reports.dismiss("report_missing", "audit_missing")).rejects.toThrow("request names no report");
    expect((await reports.get(reportId))?.closed?.eventId).toBe("audit_dismissed");
  });

  it("closes every open report of a sender it took down, and leaves other senders' and closed ones alone", async () => {
    const first = await activeShip();
    const second = await activeShip();
    const reports = new RequestReports(db, () => 1_800_000_000_000);
    const dismissed = await reports.submit(submission(first.installationId));
    await reports.dismiss(dismissed.reportId, "audit_dismissed");
    const open = await Promise.all([
      reports.submit(submission(first.installationId)),
      reports.submit(submission(second.installationId)),
    ]);
    const other = await reports.submit(submission(second.installationId, { sender: { did: OTHER_SENDER } }));
    expect(await reports.openReportsOf(SENDER)).toBe(2);

    expect(await reports.closeTakenDown(SENDER, "audit_takedown")).toBe(2);
    for (const { reportId } of open) {
      expect((await reports.get(reportId))?.closed).toEqual({ at: 1_800_000_000_000, resolution: "taken-down", eventId: "audit_takedown" });
    }
    expect((await reports.get(dismissed.reportId))?.closed).toMatchObject({ resolution: "dismissed", eventId: "audit_dismissed" });
    expect((await reports.get(other.reportId))?.closed).toBeNull();
    expect(await reports.openReportsOf(SENDER)).toBe(0);
  });
});

describe("keeping a report", () => {
  it("erases the sender's name and message once a report has been closed 90 days, and keeps everything else", async () => {
    const ship = await activeShip();
    const closedAt = 1_800_000_000_000;
    let now = closedAt;
    const reports = new RequestReports(db, () => now);
    const message = { displayName: "Stranger", text: "Buy my coins" };
    const [lapsed, recent, open] = await Promise.all([0, 1, 2].map(() => reports.submit(submission(ship.installationId, { message }))));
    await reports.dismiss(lapsed.reportId, "audit_lapsed");
    now = closedAt + 86_400_000;
    await reports.dismiss(recent.reportId, "audit_recent");
    now = closedAt + CLOSED_MESSAGE_RETENTION_MS + 1;
    const kept = await Promise.all([lapsed, recent, open].map(({ reportId }) => reports.get(reportId)));
    expect(kept.map((report) => report?.message)).toEqual([message, message, message]);

    expect(await reports.forgetClosedMessages()).toBe(1);
    expect(await reports.get(lapsed.reportId)).toEqual({ ...kept[0], message: null });
    expect(await reports.get(recent.reportId)).toEqual(kept[1]);
    expect(await reports.get(open.reportId)).toEqual(kept[2]);
    expect(await reports.forgetClosedMessages()).toBe(0);
  });

  it("forgets lapsed messages from the Accounts cron", async () => {
    const ship = await activeShip();
    const reports = new RequestReports(db, () => Date.now() - CLOSED_MESSAGE_RETENTION_MS - 60_000);
    const { reportId } = await reports.submit(submission(ship.installationId, { message: { displayName: "Stranger", text: "Buy my coins" } }));
    await reports.dismiss(reportId, "audit_lapsed");
    await new InstallationService(createExecutionContext(), env).scheduled();
    expect(await reports.get(reportId)).toMatchObject({ message: null, closed: { resolution: "dismissed", eventId: "audit_lapsed" } });
  });
});

describe("the Kernel's binding", () => {
  it.each([["no", undefined], ["the owner link", "kernel-owner-link"], ["the moderation", "operator-moderation"]])(
    "refuses %s authority without writing",
    async (_label, authority) => {
      const ship = await activeShip();
      await expect(entrypoint(authority).submitRequestReport(submission(ship.installationId))).rejects.toThrow("report authority");
      expect((await new RequestReports(db).list({ state: "open", page: 1 })).reports).toEqual([]);
    },
  );

  it("files the report for the Kernel's installation", async () => {
    const ship = await activeShip();
    const receipt = await entrypoint("kernel-report").submitRequestReport(submission(ship.installationId));
    expect(await new RequestReports(db).get(receipt.reportId)).toMatchObject({ installationId: ship.installationId, sender: { did: SENDER } });
  });
});

async function activeShip(): Promise<{ installationId: string; handle: string }> {
  const accounts = new AccountStore(db, "example.com");
  const id = crypto.randomUUID();
  const principal = await accounts.createPrincipal({ email: `${id}@example.com`, displayName: "owner", verified: true });
  const { installationId, handle } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create-${id}`, handle: `r${id.slice(0, 8)}` });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(installationId).run();
  return { installationId, handle };
}

function submission(installationId: string, overrides: Partial<RequestReportSubmission> = {}): RequestReportSubmission {
  return {
    installationId, requestKey: `apr_${crypto.randomUUID()}`, sender: { did: SENDER, handle: "stranger.ship.test" },
    category: "spam", receivedAtMs: RECEIVED_AT, ...overrides,
  };
}

/** The entrypoint as a binding with the given authority, or with no props at all, sees it. */
function entrypoint(authority: string | undefined): RequestReportsEntrypoint {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority === undefined ? undefined : { authority } });
  // SAFETY: The entrypoint reads only its binding props and the Accounts database.
  return new RequestReportsEntrypoint(ctx as never, env);
}
