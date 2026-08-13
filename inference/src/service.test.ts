import { env, exports } from "cloudflare:workers";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
  type ManagedMailSummaryRequest,
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

const MAIL_REQUEST: ManagedMailSummaryRequest = {
  version: 1,
  installationId: "installation_service_mail_rpc",
  logicalRequestId: "mail_service_rpc",
  actor: { localUid: 1_000 },
  from: "mike@example.com",
  subject: "Checking in",
  text: "Are we still on for tomorrow?",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed inference service RPC", () => {
  it("routes a trusted installation request through its Durable Object", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => completion()));

    await expect(exports.default.generate(REQUEST)).resolves.toMatchObject({
      responseId: "generation_service_rpc",
      usage: { input: 2, output: 1, totalTokens: 3 },
    });

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

  it("honors an immediate abort that overtakes generation RPC", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => completion("unexpected"));
    vi.stubGlobal("fetch", fetchMock);
    const request: ManagedInferenceRequest = {
      ...REQUEST,
      installationId: "installation_service_abort_rpc",
      logicalRequestId: "request_service_abort_rpc",
    };

    await exports.default.abort({
      version: 1,
      installationId: request.installationId,
      logicalRequestId: request.logicalRequestId,
    });
    const result = exports.default.generate(request);

    await expect(result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes fixed mail intake through the same budget coordinator", async () => {
    const expected = {
      summary: "Mike asked whether tomorrow's meeting is still scheduled.",
      category: "work",
      requiresAttention: true,
      confidence: 0.9,
    } as const;
    const fetchMock = vi.fn<typeof fetch>(async () => completion(
      JSON.stringify(expected),
      "generation_service_mail_rpc",
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exports.default.summarizeMail(MAIL_REQUEST)).resolves.toEqual(
      expected,
    );
    await expect(exports.default.summarizeMail(MAIL_REQUEST)).resolves.toEqual(
      expected,
    );

    const installation = env.INFERENCE_INSTALLATIONS.getByName(
      MAIL_REQUEST.installationId,
    );
    await expect(installation.usage()).resolves.toMatchObject({
      startedRequests: 1,
      completedRequests: 1,
      spentNanoUsd: 340,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function completion(
  text = "pong",
  id = "generation_service_rpc",
): Response {
  return new Response([
    sse({
      id,
      model: "deepseek/deepseek-v4-flash-0731",
      choices: [{ index: 0, delta: { content: text } }],
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
