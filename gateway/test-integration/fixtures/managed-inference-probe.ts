import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";

interface Env {
  MANAGED_INFERENCE: ManagedInferenceService;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const generation = await env.MANAGED_INFERENCE.generate({
      version: 1,
      installationId: "inst_integration_first",
      logicalRequestId: "integration-cancellation",
      actor: { localUid: 1000 },
      model: GSV_INFERENCE_PRODUCT_MODEL,
      messages: [{ role: "user", content: "wait for cancellation" }],
      maxOutputTokens: 128,
      timeoutMs: 5_000,
    });
    try {
      const result = generation.result();
      await generation.abort();
      await result;
      return new Response(null, { status: 204 });
    } finally {
      (generation as typeof generation & Partial<Disposable>)[Symbol.dispose]?.();
    }
  },
} satisfies ExportedHandler<Env>;
