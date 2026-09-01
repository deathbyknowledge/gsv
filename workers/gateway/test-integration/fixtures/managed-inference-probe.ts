import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
} from "@humansandmachines/gsv/protocol";
import type {
  InferenceService as ManagedInferenceService,
} from "@humansandmachines/gsv/services/inference";

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
    const target = await env.MANAGED_INFERENCE.getInstallation(
      input.installationId,
    );
    try {
      if (url.pathname === "/abort-first") {
        await target.abort(input.logicalRequestId);
        const result = await target.generate(input);
        return new Response(null, {
          status: result.stopReason === "aborted" ? 204 : 500,
        });
      }
      const result = target.generate(input);
      await target.abort(input.logicalRequestId);
      await result;
      return new Response(null, { status: 204 });
    } finally {
      // SAFETY: Workers RPC stubs implement Symbol.dispose.
      const disposable = target as typeof target & {
        [Symbol.dispose]?(): void;
      };
      disposable[Symbol.dispose]?.();
    }
  },
} satisfies ExportedHandler<Env>;
