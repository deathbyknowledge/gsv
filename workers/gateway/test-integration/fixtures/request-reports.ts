import { WorkerEntrypoint } from "cloudflare:workers";
import type { RequestReportReceipt, RequestReportService, RequestReportSubmission } from "@humansandmachines/gsv/services/reports";

export type FiledRequestReport = RequestReportSubmission & RequestReportReceipt;

// The reports each installation's person filed, in the order the queue took them.
const FILED: FiledRequestReport[] = [];

/** The operator's queue as Accounts serves the Kernel's binding: one report per request, however often it is filed. */
export class IntegrationRequestReports extends WorkerEntrypoint implements RequestReportService {
  async submitRequestReport(input: RequestReportSubmission): Promise<RequestReportReceipt> {
    const filed = FILED.find((report) => report.installationId === input.installationId && report.requestKey === input.requestKey);
    if (filed) return { reportId: filed.reportId, reportedAtMs: filed.reportedAtMs };
    const receipt = { reportId: `report_${crypto.randomUUID()}`, reportedAtMs: Date.now() };
    FILED.push({ ...input, ...receipt });
    return receipt;
  }
}

export function filedRequestReports(): FiledRequestReport[] {
  return FILED;
}
