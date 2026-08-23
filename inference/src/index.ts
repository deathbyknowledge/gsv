import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedInferenceAbortRequest,
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedMailSummary,
  ManagedMailSummaryRequest,
  ManagedMailSummaryRequestStatus,
  ManagedMailSummaryService,
} from "@humansandmachines/gsv/protocol";
import type { InferenceService as InferenceServiceContract } from "@humansandmachines/gsv/services/inference";
import type { InferenceEnv } from "./env";
import { validateManagedMailSummaryRequest } from "./mail-summary";
import {
  validateManagedInferenceAbortRequest,
  validateManagedInferenceRequest,
} from "./validation";
import type { InferenceInstallation } from "./installation";

export { InferenceInstallation } from "./installation";

export class InferenceService
  extends WorkerEntrypoint<InferenceEnv>
  implements InferenceServiceContract, ManagedMailSummaryService
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
    return await inferenceInstallation(this.env, input.installationId).generate(input);
  }

  async generateStream(
    inputValue: ManagedInferenceRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!this.env.MANAGED_INFERENCE_ENABLED) {
      throw new Error("Managed inference is disabled");
    }
    const input = validateManagedInferenceRequest(inputValue);
    return await inferenceInstallation(this.env, input.installationId).generateStream(input);
  }

  async abort(inputValue: ManagedInferenceAbortRequest): Promise<void> {
    const input = validateManagedInferenceAbortRequest(inputValue);
    await inferenceInstallation(this.env, input.installationId).abort(input.logicalRequestId);
  }

  async summarizeMail(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummary> {
    const input = validateManagedMailSummaryRequest(inputValue);
    return await inferenceInstallation(this.env, input.installationId).summarizeMail(input);
  }

  async getMailSummaryStatus(
    inputValue: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummaryRequestStatus> {
    const input = validateManagedMailSummaryRequest(inputValue);
    return await inferenceInstallation(this.env, input.installationId).getMailSummaryStatus(input);
  }
}

function inferenceInstallation(
  env: InferenceEnv,
  installationId: string,
): InferenceInstallation {
  const stub: unknown = env.INFERENCE_INSTALLATIONS.getByName(installationId);
  // SAFETY: the namespace is generated from the exported InferenceInstallation
  // class; this narrows only Cloudflare's recursively mapped RPC stub type.
  return stub as InferenceInstallation;
}

export default InferenceService;
