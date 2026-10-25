import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { RequestReport, RequestReports, RequestReportState } from "../request-reports";
import { AdminForbiddenError, type InstallationAdminAccess } from "./access";
import { adminRedirect, adminText, installationAdminFailure, readAdminForm, readPageNumber, requireAdminMutationOrigin } from "./http";
import type { AdminAuditRecorder, OperatorAuditEvent, OperatorAuditLog } from "./insight";
import { adminErrorPage, type AdminNavigationItem } from "./page";
import { reportPage, reportsPage } from "./reports-page";
import type { ShipTakedowns } from "./takedowns";

const REASON_MAX_LENGTH = 500;

/**
 * The operator's queue of reported message requests. The operator dismisses
 * a report, or takes its sender's account down when the deployment's host
 * holds it; the audit event of either action closes the report.
 */
export class RequestReportsHttp {
  constructor(
    private readonly reports: RequestReports,
    private readonly audit: OperatorAuditLog,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly audited: AdminAuditRecorder,
    private readonly takedowns: ShipTakedowns | undefined,
    private readonly navigation: readonly AdminNavigationItem[] = [],
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const route = /^\/admin\/reports(?:\/([^/]+)(?:\/(dismiss|takedown))?)?$/.exec(url.pathname);
    if (!route) return null;
    if (!await this.access.allows(request)) return adminText("Forbidden", 403);
    const head = request.method === "HEAD";
    const reading = request.method === "GET" || head;
    const notFound = () => adminErrorPage("The operator page does not exist.", 404, head, this.navigation);
    const [, encodedId, action] = route;
    let report: RequestReport | null = null;
    try {
      if (!encodedId) return reading ? reportsPage(await this.reports.list({ state: readState(url), page: readPageNumber(url) }), head, this.navigation) : notFound();
      if (!action) {
        if (!reading) return notFound();
        report = await this.reports.get(decodeReportId(encodedId));
        return report ? await this.reportPage(report, head) : adminErrorPage("The report does not exist.", 404, head, this.navigation);
      }
      const takedowns = action === "takedown" ? this.takedowns : undefined;
      if (request.method !== "POST" || (action === "takedown" && !takedowns)) return notFound();
      requireAdminMutationOrigin(request, this.origin);
      report = await this.reports.get(decodeReportId(encodedId));
      if (!report) return adminErrorPage("The report does not exist.", 404, false, this.navigation);
      const form = await readAdminForm(request);
      if (report.closed) throw new Error("request names a report that is already closed");
      if (takedowns) await this.takeDown(request, report, form.get("reason"), takedowns);
      else await this.dismiss(request, report, form.get("reason"));
      return adminRedirect(`/admin/reports/${encodeURIComponent(report.id)}`);
    } catch (error) {
      if (error instanceof AdminForbiddenError) return adminText("Forbidden", 403);
      const failure = installationAdminFailure(error instanceof Error ? error : new Error("request failed"));
      if (failure.status >= 500) console.warn("[Operator] Report request failed:", url.pathname, exceptionDiagnostics(error));
      if (report && action) {
        try {
          return await this.reportPage(await this.reports.get(report.id) ?? report, false, failure.message, failure.status);
        } catch (pageError) {
          console.warn("[Operator] Report page unavailable:", exceptionDiagnostics(pageError));
        }
      }
      return adminErrorPage(failure.message, failure.status, head, this.navigation);
    }
  }

  private async reportPage(report: RequestReport, head: boolean, error?: string, status = 200): Promise<Response> {
    const [hosting, openReports, trail] = await Promise.all([
      this.takedowns ? this.takedowns.senderView(report.sender.did) : null,
      this.reports.openReportsOf(report.sender.did),
      this.trail(report),
    ]);
    return reportPage({ report, hosting, openReports, trail, error, status, head, navigation: this.navigation });
  }

  /** Every audit event that names the report, failures included, and the one that closed it when another report's takedown did. */
  private async trail(report: RequestReport): Promise<OperatorAuditEvent[]> {
    const events = await this.audit.forReport(report.id);
    const closedBy = report.closed?.eventId;
    if (!closedBy || events.some(({ id }) => id === closedBy)) return events;
    const closing = await this.audit.event(closedBy);
    return closing ? [...events, closing].sort((first, second) => second.at - first.at) : events;
  }

  private async dismiss(request: Request, report: RequestReport, reason: string | null): Promise<void> {
    await this.audited(request, { name: "report.dismiss", reason, detail: { report: report.id } },
      (eventId) => this.reports.dismiss(report.id, closingEvent(eventId)));
  }

  /** Takes the sender's whole account down on the deployment's host, closing each open report of them. */
  private async takeDown(request: Request, report: RequestReport, value: string | null, takedowns: ShipTakedowns): Promise<void> {
    const reason = value?.trim();
    if (!reason) throw new Error("request reason is required: the sender's person reads it");
    if (reason.length > REASON_MAX_LENGTH) throw new Error("request reason is too long");
    const sender = await takedowns.sender(report.sender.did);
    if (!sender) throw new Error("request names a sender this deployment's host doesn't hold");
    await this.audited(request, { name: "ship.takedown", installationId: sender.installationId, reason, detail: { subject: "account", report: report.id } },
      async (eventId) => {
        const event = closingEvent(eventId);
        const { bluesky } = await takedowns.takeDown(sender.installationId, { subject: "account", reason }, event);
        return { closed: await this.reports.closeTakenDown(report.sender.did, event), bluesky };
      },
      ({ closed, bluesky }) => ({ detail: { subject: "account", report: report.id, closed: String(closed), bluesky } }));
  }
}

/** A report closes under the audit event that records the operator's action. */
function closingEvent(eventId: string | undefined): string {
  if (!eventId) throw new Error("request needs the operator audit log");
  return eventId;
}

function readState(url: URL): RequestReportState {
  const state = url.searchParams.get("state");
  if (state === null || state === "open") return "open";
  if (state === "closed") return "closed";
  throw new Error("query state is invalid");
}

function decodeReportId(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new Error("request names no report"); }
}
