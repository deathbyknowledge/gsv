import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";

interface Env {
  MANAGED_INFERENCE: ManagedInferenceService;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const input: ManagedInferenceRequest = {
      version: 1,
      installationId: url.searchParams.get("installationId")
        ?? "inst_integration_first",
      logicalRequestId: url.searchParams.get("logicalRequestId")
        ?? "integration-cancellation",
      actor: { localUid: 1000 },
      model: GSV_INFERENCE_PRODUCT_MODEL,
      messages: [{ role: "user", content: "wait for cancellation" }],
      maxOutputTokens: 128,
      timeoutMs: 5_000,
    };
    if (url.pathname === "/abort-first") {
      await env.MANAGED_INFERENCE.abort({
        version: 1,
        installationId: input.installationId,
        logicalRequestId: input.logicalRequestId,
      });
      const result = await env.MANAGED_INFERENCE.generate(input);
      return new Response(null, {
        status: result.stopReason === "aborted" ? 204 : 500,
      });
    }
    const result = env.MANAGED_INFERENCE.generate(input);
    await env.MANAGED_INFERENCE.abort({
      version: 1,
      installationId: input.installationId,
      logicalRequestId: input.logicalRequestId,
    });
    await result;
    return new Response(null, { status: 204 });
  },
} satisfies ExportedHandler<Env>;
