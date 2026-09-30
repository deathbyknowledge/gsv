import { WorkerEntrypoint } from "cloudflare:workers";
import type { FeedbackSubmission } from "@humansandmachines/gsv/services/feedback";

const stalledReports = new Set<string>();
const misreportedReceipts = new Set<string>();
const rejectedReports = new Set<string>();

export default class FeedbackFixture extends WorkerEntrypoint {
  async submitFeedback(input: FeedbackSubmission) {
    if (input.installationId !== "inst_integration_default" || input.ownerUid !== 1000 || input.source !== "client") {
      throw new Error("Unexpected feedback caller");
    }
    if (!input.serverVersion || !input.space || !input.message.trim()) throw new Error("Missing report context");
    if (input.message.startsWith("PRIVATE_REJECTED_REPORT_CONTENT") && !rejectedReports.has(input.id)) {
      rejectedReports.add(input.id);
      throw new Error(`${input.message}: ${input.activity?.text ?? ""}`);
    }
    if (input.message === "Stall the first attempt" && !stalledReports.has(input.id)) {
      stalledReports.add(input.id);
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
    if (input.message === "Misreport the first receipt" && !misreportedReceipts.has(input.id)) {
      misreportedReceipts.add(input.id);
      return { id: crypto.randomUUID() };
    }
    return { id: input.id };
  }
}
