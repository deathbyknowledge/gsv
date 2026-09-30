import { WorkerEntrypoint } from "cloudflare:workers";
import type { FeedbackSubmission } from "@humansandmachines/gsv/services/feedback";

export default class FeedbackFixture extends WorkerEntrypoint {
  submitFeedback(input: FeedbackSubmission) {
    if (input.installationId !== "inst_integration_default" || input.ownerUid !== 1000 || input.source !== "client") {
      throw new Error("Unexpected feedback caller");
    }
    if (!input.serverVersion || !input.space || !input.message.trim()) throw new Error("Missing report context");
    return { id: input.id };
  }
}
