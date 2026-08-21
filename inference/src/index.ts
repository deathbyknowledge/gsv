import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedInferenceAbortRequest,
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedInferenceService,
  ManagedMailSummary,
  ManagedMailSummaryRequest,
  ManagedMailSummaryRequestStatus,
  ManagedMailSummaryService,
} from "@humansandmachines/gsv/protocol";
import type { InferenceEnv } from "./env";
import { validateManagedMailSummaryRequest } from "./mail-summary";
import {
  validateManagedInferenceAbortRequest,
  validateManagedInferenceRequest,
} from "./validation";

export { InferenceInstallation } from "./installation";

export class InferenceService
  extends WorkerEntrypoint<InferenceEnv>
  implements ManagedInferenceService, ManagedMailSummaryService
{
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  async generate(
    inputValue: ManagedInferenceRequest,
  ): Promise<ManagedInferenceResult> {
    if (!this.env.MANAGED_INFERENCE_ENABLED) {
      throw new Error("Managed inference is disabled");
    }
    const input = validateManagedInferenceRequest(inputValue);
    return await this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    ).generate(input);
  }

  async generateStream(
    inputValue: ManagedInferenceRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!this.env.MANAGED_INFERENCE_ENABLED) {
      throw new Error("Managed inference is disabled");
    }
    const input = validateManagedInferenceRequest(inputValue);
    return await this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    ).generateStream(input);
  }

  async abort(inputValue: ManagedInferenceAbortRequest): Promise<void> {
    const input = validateManagedInferenceAbortRequest(inputValue);
    await this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    ).abort(input.logicalRequestId);
  }

  async summarizeMail(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummary> {
    const input = validateManagedMailSummaryRequest(inputValue);
    return await this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    ).summarizeMail(input);
  }

  async getMailSummaryStatus(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummaryRequestStatus> {
    const input = validateManagedMailSummaryRequest(inputValue);
    return await this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    ).getMailSummaryStatus(input);
  }
}

export default InferenceService;
