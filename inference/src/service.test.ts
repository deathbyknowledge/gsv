import { env, exports } from "cloudflare:workers";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const REQUEST: ManagedInferenceRequest = {
  version: 1,
  installationId: "installation_service_rpc",
  logicalRequestId: "request_service_rpc",
  actor: {
    localUid: 1_000,
    processId: "process_service_rpc",
    runId: "run_service_rpc",
  },
  model: GSV_INFERENCE_PRODUCT_MODEL,
  messages: [{ role: "user", content: "ping", timestamp: 1 }],
  maxOutputTokens: 32,
  timeoutMs: 1_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed inference service RPC", () => {
  it("routes a trusted installation request through its Durable Object", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => completion()));

    const generation = await exports.default.generate(REQUEST);
    try {
      await expect(generation.result()).resolves.toMatchObject({
        responseId: "generation_service_rpc",
        usage: { input: 2, output: 1, totalTokens: 3 },
      });
    } finally {
      (generation as typeof generation & Partial<Disposable>)[Symbol.dispose]?.();
    }

    const installation = env.INFERENCE_INSTALLATIONS.getByName(
      REQUEST.installationId,
    );
    await expect(installation.usage()).resolves.toMatchObject({
      installationId: REQUEST.installationId,
      spentNanoUsd: 340,
      reservedNanoUsd: 0,
      completedRequests: 1,
    });
  });
});

function completion(): Response {
  return new Response([
    sse({
      id: "generation_service_rpc",
      model: "deepseek/deepseek-v4-flash-0731",
      choices: [{ index: 0, delta: { content: "pong" } }],
    }),
    sse({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
      },
    }),
    "data: [DONE]\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
