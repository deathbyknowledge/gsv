import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedInferenceGeneration,
  ManagedInferenceRequest,
  ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import { createOpenRouterGeneration } from "./openrouter";

export class InferenceService
  extends WorkerEntrypoint<Env>
  implements ManagedInferenceService
{
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  async generate(input: ManagedInferenceRequest): Promise<ManagedInferenceGeneration> {
    return createOpenRouterGeneration(input, this.env.OPENROUTER_API_KEY);
  }
}

export default InferenceService;
