import { WorkerEntrypoint } from "cloudflare:workers";
import { baseAiModelStack } from "../base-model-stack";
import type { GatewayEnv } from "../../runtime-env";
import type { InferenceExecutionService, InferenceExecutor, InferenceMediaRequest } from "@humansandmachines/gsv/services/inference-execution";

type FixtureEnv = {
  COUNTS: { count(): Promise<number>; dispatch(): Promise<{ url: string; model: string } | null> };
  INFERENCE: InferenceExecutionService;
  INVALID: InferenceExecutionService;
  EXECUTORS: { getByName(id: string): InferenceExecutor };
};

export default class Client extends WorkerEntrypoint<FixtureEnv> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.split("/");
    if (path[1] === "calls") return Response.json({ calls: await this.env.COUNTS.count(), dispatch: await this.env.COUNTS.dispatch() });
    const installationId = path[2] || "singleton";
    try {
      const executor = path[1] === "direct" ? this.env.EXECUTORS.getByName(installationId)
        : await (path[1] === "invalid" ? this.env.INVALID : this.env.INFERENCE).getExecutor(installationId);
      if (path[1] === "text") {
        // SAFETY: model-stack selection reads only inference/directory feature bindings; this fixture supplies the standalone subset.
        const model = baseAiModelStack({ INFERENCE_EXECUTION: this.env.INFERENCE } as GatewayEnv)[0];
        if (model.maxTokens === undefined) throw new Error("The base model must supply an output limit");
        const result = await executor.generate({ version: 1, installationId, logicalRequestId: crypto.randomUUID(),
          actor: { localUid: 1000 }, timeoutMs: 10_000, deadlineAt: Date.now() + 10_000,
          connection: { provider: model.provider, model: model.model, apiKey: "",
            maxTokens: model.maxTokens, contextWindowTokens: null,
            baseUrl: undefined, providerStyle: undefined, openAiCodex: undefined, reasoning: undefined },
          messages: [{ role: "user", content: "fixture message" }],
        });
        return Response.json({ result });
      }
      const input: InferenceMediaRequest = { version: 1, installationId, logicalRequestId: crypto.randomUUID(),
        actor: { localUid: 1000 }, timeoutMs: 10_000, deadlineAt: Date.now() + 10_000, kind: "transcription",
        input: { provider: "workers-ai", model: "@cf/openai/whisper-large-v3-turbo", maxInputBytes: 4 } };
      return Response.json(await executor.media(input, new Response(new Uint8Array([1, 2])).body!));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
    }
  }
}
