import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedInferenceGeneration,
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import type { InferenceEnv } from "./env";
import { validateManagedInferenceRequest } from "./validation";

export { InferenceInstallation } from "./installation";

export class InferenceService
  extends WorkerEntrypoint<InferenceEnv>
  implements ManagedInferenceService
{
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  async generate(
    inputValue: ManagedInferenceRequest,
  ): Promise<ManagedInferenceGeneration> {
    if (!this.env.MANAGED_INFERENCE_ENABLED) {
      throw new Error("Managed inference is disabled");
    }
    const input = validateManagedInferenceRequest(inputValue);
    const installation = this.env.INFERENCE_INSTALLATIONS.getByName(
      input.installationId,
    );
    let resultPromise: Promise<ManagedInferenceResult> | undefined;
    return {
      result: () => {
        resultPromise ??= installation.generate(input);
        return resultPromise;
      },
      abort: async () => {
        await installation.abort(input.logicalRequestId);
      },
    };
  }
}

export default InferenceService;
