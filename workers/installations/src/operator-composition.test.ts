import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { PdsModerationService } from "@humansandmachines/gsv/services/pds";
import type { RequestReportSubmission } from "@humansandmachines/gsv/services/reports";
import { ShipTakedowns } from "@humansandmachines/gsv-installations/admin/takedowns";
import {
  forgetOwnerConfirmations,
  OWNER_CONFIRMATION_WINDOW_MS,
  OwnerConfirmations,
} from "@humansandmachines/gsv-installations/owner-confirmations";
import { fileKernelReport, RequestReports } from "@humansandmachines/gsv-installations/request-reports";
import { AccountStore } from "./store";

/** An operator's own Accounts Worker imports these by package name and keeps its database under its own binding. */
describe("an operator's own Accounts Worker", () => {
  it("files the Kernel's reports on its own database, and only with the Kernel's authority", async () => {
    const operatorDb = env.INSTALLATIONS_DB;
    const input = await submission(operatorDb);
    await expect(fileKernelReport(operatorDb, { authority: "kernel-owner-link" }, input)).rejects.toThrow("report authority");
    await expect(fileKernelReport(operatorDb, undefined, input)).rejects.toThrow("report authority");
    const { reportId } = await fileKernelReport(operatorDb, { authority: "kernel-report" }, input);
    expect(await new RequestReports(operatorDb).get(reportId)).toMatchObject({ installationId: input.installationId, closed: null });
  });

  it("keeps the owner's confirmation codes on its own database, and forgets them once they can't be used", async () => {
    const operatorDb = env.INSTALLATIONS_DB;
    const { installationId } = await submission(operatorDb);
    const subject = { installationId, purpose: "recovery-sheet" as const, subjectHash: "0".repeat(64) };
    const issued = await new OwnerConfirmations(operatorDb, "operator-confirmation-secret-0123456789").issue(subject, 1_000);
    if (issued.status !== "issued") throw new Error("Expected a code");
    await forgetOwnerConfirmations(operatorDb, 1_000 + OWNER_CONFIRMATION_WINDOW_MS);
    expect(await operatorDb.prepare("SELECT COUNT(*) AS kept FROM owner_confirmations WHERE id = ?").bind(issued.id).first("kept")).toBe(0);
  });

  it("reads a Ship's takedowns from the deployment's PDS", async () => {
    const repository = { did: "did:plc:operatorshipaaaaaaaaaaaa", handle: "ship.example.com", takedowns: [] };
    const pds = {
      getRepository: vi.fn(async () => repository),
      updateSubjectStatus: vi.fn(),
      getSubjectStatus: vi.fn(async () => null),
      locateRepository: vi.fn(async () => null),
      reconcileAccountStatus: vi.fn(async () => {}),
    } satisfies PdsModerationService;
    expect(await new ShipTakedowns(pds).view("installation_operator")).toEqual({ kind: "ok", repository });
  });
});

async function submission(db: D1Database): Promise<RequestReportSubmission> {
  const accounts = new AccountStore(db, "example.com");
  const id = crypto.randomUUID();
  const principal = await accounts.createPrincipal({ email: `${id}@example.com`, displayName: "owner", verified: true });
  const { installationId } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create-${id}`, handle: `o${id.slice(0, 8)}` });
  return {
    installationId, requestKey: `apr_${crypto.randomUUID()}`, sender: { did: "did:plc:reportedsenderaaaaaaaaaa" },
    category: "spam", receivedAtMs: 1_790_000_000_000,
  };
}
