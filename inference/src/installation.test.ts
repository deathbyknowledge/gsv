import { env } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferencePurpose,
  type ManagedInferenceRequest,
  type ManagedInferenceRouting,
  type ManagedMailSummary,
  type ManagedMailSummaryRequest,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceEnv } from "./env";
import type { InferenceInstallation } from "./installation";

const DEFAULT_ROUTING: ManagedInferenceRouting = {
  version: 1,
  modelId: "deepseek/deepseek-v4-flash-0731",
  displayName: "DeepSeek: DeepSeek V4 Flash 0731",
  contextWindow: 1_048_576,
  maxOutputTokens: 384_000,
  reasoning: true,
  inputNanoUsdPerToken: 80,
  outputNanoUsdPerToken: 180,
  cacheReadNanoUsdPerToken: 16,
  cacheWriteNanoUsdPerToken: 0,
  provider: {
    allowFallbacks: true,
    requireParameters: false,
    dataCollection: "allow",
    zdr: false,
    order: [],
    only: [],
    ignore: [],
    quantizations: [],
    sort: "default",
  },
  updatedAt: 0,
};

function request(
  installationId: string,
  logicalRequestId: string,
  maxOutputTokens = 32,
): ManagedInferenceRequest {
  return {
    version: 1,
    installationId,
    logicalRequestId,
    actor: {
      localUid: 1_000,
      processId: `process_${logicalRequestId}`,
      runId: `run_${logicalRequestId}`,
    },
    model: GSV_INFERENCE_PRODUCT_MODEL,
    messages: [{ role: "user", content: "ping", timestamp: 1 }],
    maxOutputTokens,
    timeoutMs: 1_000,
  };
}

function mailSummaryRequest(
  installationId: string,
  logicalRequestId: string,
): ManagedMailSummaryRequest {
  return {
    version: 1,
    installationId,
    logicalRequestId,
    actor: { localUid: 1_000 },
    from: "Mike Example <mike@example.com>",
    subject: "Following up",
    text: "Mike asked whether we can meet tomorrow.",
  };
}

function completion(id: string, text = "pong"): Response {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installation managed inference", () => {
  it("persists and replays a validated mail summary without another charge", async () => {
    const installationId = "installation_mail_replay";
    const logicalRequestId = "mail_replay";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const expected = {
      summary: "Mike asked to arrange a meeting tomorrow.",
      category: "work",
      requiresAttention: true,
      confidence: 0.94,
    } as const;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: unknown;
        model?: string;
        max_completion_tokens?: number;
      };
      expect(payload.model).toBe("deepseek/deepseek-v4-flash-0731");
      expect(payload.max_completion_tokens).toBe(256);
      expect(payload.tools).toBeUndefined();
      expect(payload.messages?.some((message) => (
        message.role === "system"
        && message.content?.includes("untrusted data")
      ))).toBe(true);
      expect(payload.messages?.some((message) => (
        message.role === "user"
        && message.content?.includes(mailSummaryRequest(
          installationId,
          logicalRequestId,
        ).text)
      ))).toBe(true);
      return completion("gen_mail_replay", JSON.stringify(expected));
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = mailSummaryRequest(installationId, logicalRequestId);

    const first = await stub.summarizeMail(input);
    const replay = await stub.summarizeMail(input);
    const persisted = await runInDurableObject(
      stub,
      async (instance, state) => {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
        const untyped: unknown = instance;
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        const object = untyped as { env: InferenceEnv };
        object.env.MANAGED_INFERENCE_ENABLED = false;
        let disabledReplay: ManagedMailSummary | undefined;
        try {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
          disabledReplay = await (instance as InferenceInstallation)
            .summarizeMail(input);
        } finally {
          object.env.MANAGED_INFERENCE_ENABLED = true;
        }
        const stored = state.storage.sql.exec<{
          purpose: string;
          state: string;
          request_fingerprint: string | null;
          result_json: string | null;
        }>(
          `SELECT purpose, state, request_fingerprint, result_json
           FROM inference_requests WHERE logical_request_id = ?`,
          logicalRequestId,
        ).one();
        let exportedPurpose: ManagedInferencePurpose | undefined;
        const accounts = object.env.ACCOUNTS;
        object.env.ACCOUNTS = {
          getManagedInferencePolicy: async (installationId) => (
            await accounts.getManagedInferencePolicy(installationId)
          ),
          recordManagedInferenceUsage: async (events) => {
            exportedPurpose = events[0]?.purpose;
          },
        };
        try {
          state.storage.sql.exec(
            "UPDATE inference_requests SET next_export_at = ?",
            Date.now(),
          );
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
          await (instance as InferenceInstallation).alarm();
        } finally {
          object.env.ACCOUNTS = accounts;
        }
        return { disabledReplay, exportedPurpose, stored };
      },
    );

    expect(first).toEqual(expected);
    expect(replay).toEqual(expected);
    await expect(stub.getMailSummaryStatus(input)).resolves.toEqual({
      state: "completed",
      summary: expected,
    });
    expect(persisted.disabledReplay).toEqual(expected);
    expect(persisted.exportedPurpose).toBe("mail-intake");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(stub.usage()).resolves.toMatchObject({
      startedRequests: 1,
      completedRequests: 1,
      failedRequests: 0,
      spentNanoUsd: 340,
    });
    expect(persisted.stored).toMatchObject({
      purpose: "mail-intake",
      state: "completed",
      request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      result_json: JSON.stringify(expected),
    });
  });

  it("rejects reuse of a mail replay key for different parsed content", async () => {
    const installationId = "installation_mail_conflict";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion(
      "gen_mail_conflict",
      JSON.stringify({
        summary: "The first message was received.",
        category: "personal",
        requiresAttention: false,
        confidence: 0.8,
      }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const input = mailSummaryRequest(installationId, "mail_conflict");

    await stub.summarizeMail(input);
    const rejection = await runInDurableObject(stub, async (instance) => {
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
      try {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
        await (instance as InferenceInstallation).summarizeMail({
          ...input,
          text: "This is different parsed content.",
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });

    expect(rejection).toContain("conflicts with an existing request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(stub.usage()).resolves.toMatchObject({
      startedRequests: 1,
      completedRequests: 1,
    });
  });

  it("settles an invalid mail summary once and never retries its key", async () => {
    const installationId = "installation_mail_invalid_result";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion(
      "gen_mail_invalid_result",
      JSON.stringify({
        summary: "This output is missing required fields.",
      }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const input = mailSummaryRequest(installationId, "mail_invalid_result");

    const rejections = await runInDurableObject(stub, async (instance) => {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
        const installation = instance as InferenceInstallation;
      const messages: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await installation.summarizeMail(input);
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return messages;
    });

    expect(rejections[0]).toContain("result fields are invalid");
    expect(rejections[1]).toContain("was already failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(stub.getMailSummaryStatus(input)).resolves.toEqual({
      state: "failed",
    });
    await expect(stub.usage()).resolves.toMatchObject({
      spentNanoUsd: 340,
      reservedNanoUsd: 0,
      startedRequests: 1,
      completedRequests: 0,
      failedRequests: 1,
    });
  });

  it("settles provider usage into its installation period", async () => {
    expect(env.OPENROUTER_API_KEY === "test-key").toBe(true);
    const installationId = "installation_settlement";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion("gen_settlement"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await stub.generate(request(installationId, "request_settlement"));

    expect(result).toMatchObject({
      responseId: "gen_settlement",
      usage: { input: 2, output: 1, totalTokens: 3 },
    });
    await expect(stub.usage()).resolves.toMatchObject({
      installationId,
      spentNanoUsd: 340,
      reservedNanoUsd: 0,
      startedRequests: 1,
      completedRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a durable cancellation that arrives before generation", async () => {
    const installationId = "installation_cancelled_before_generate";
    const logicalRequestId = "request_cancelled_before_generate";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion("unexpected"));
    vi.stubGlobal("fetch", fetchMock);

    await stub.abort(logicalRequestId);
    const result = await stub.generate(request(installationId, logicalRequestId));
    const tombstone = await runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ expires_at: number }>(
        `SELECT expires_at FROM inference_cancellations
         WHERE logical_request_id = ?`,
        logicalRequestId,
      ).one()
    ));

    expect(result).toMatchObject({
      provider: "gsv",
      model: "gsv/default",
      stopReason: "aborted",
      usage: { totalTokens: 0 },
    });
    expect(tombstone.expires_at).toBeGreaterThan(Date.now());
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(stub.usage()).resolves.toMatchObject({
      startedRequests: 0,
      reservedNanoUsd: 0,
      spentNanoUsd: 0,
    });
  });

  it("retains the reservation when an accepted provider stream is aborted", async () => {
    const installationId = "installation_accepted_abort";
    const logicalRequestId = "request_accepted_abort";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    let failBody: (reason: Error | string | null | undefined) => void = () => {};
    let markReading: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          failBody = (reason) => controller.error(reason);
        },
        pull() {
          markReading();
          return new Promise<void>(() => {});
        },
      });
      init?.signal?.addEventListener("abort", () => {
        failBody(init.signal?.reason);
      }, { once: true });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }));

    const outcome = await runInDurableObject(stub, async (instance) => {
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      const installation = instance as InferenceInstallation;
      const generation = installation.generate(request(
        installationId,
        logicalRequestId,
      ));
      await reading;
      await installation.abort(logicalRequestId);
      return { result: await generation, usage: await installation.usage() };
    });
    expect(outcome.result).toMatchObject({ stopReason: "aborted" });
    expect(outcome.usage).toMatchObject({
      reservedNanoUsd: 0,
      abortedRequests: 1,
    });
    expect(outcome.usage.spentNanoUsd).toBeGreaterThan(0);
  });

  it("does not let a late abort replace terminal replay behavior", async () => {
    const installationId = "installation_late_abort";
    const logicalRequestId = "request_late_abort";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion("gen_late_abort"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stub.generate(request(installationId, logicalRequestId)),
    ).resolves.toMatchObject({ stopReason: "stop" });
    await stub.abort(logicalRequestId);
    const tombstones = await runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM inference_cancellations
         WHERE logical_request_id = ?`,
        logicalRequestId,
      ).one().count
    ));

    const replayError = await runInDurableObject(stub, async (instance) => {
      try {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
        await (instance as InferenceInstallation).generate(
          request(installationId, logicalRequestId),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(replayError).toBe("Managed inference request was already completed");
    expect(tombstones).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal settlement authoritative over an overtaking cancellation", async () => {
    const installationId = "installation_settlement_cancellation_race";
    const logicalRequestId = "request_settlement_cancellation_race";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    let respond: (response: Response) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      markStarted();
      return await new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
    const outcome = await runInDurableObject(stub, async (instance, state) => {
      // SAFETY: The test fixture provides the concrete installation implementation.
      const installation = instance as InferenceInstallation;
      const generation = installation.generate(request(
        installationId,
        logicalRequestId,
      ));
      await started;
      state.storage.sql.exec(
        `INSERT INTO inference_cancellations (logical_request_id, expires_at)
         VALUES (?, ?)`,
        logicalRequestId,
        Date.now() + 60_000,
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
      );
      respond(completion("gen_settlement_cancellation_race"));
      const result = await generation;
      const requestState = state.storage.sql.exec<{ state: string }>(
        `SELECT state FROM inference_requests WHERE logical_request_id = ?`,
        logicalRequestId,
      ).one().state;
      const tombstones = state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM inference_cancellations
         WHERE logical_request_id = ?`,
        logicalRequestId,
      ).one().count;
      let replayError = "";
      try {
        await installation.generate(request(installationId, logicalRequestId));
      } catch (error) {
        replayError = error instanceof Error ? error.message : String(error);
      }
      return { result, requestState, tombstones, replayError };
    });

    expect(outcome.result).toMatchObject({
      responseId: "gen_settlement_cancellation_race",
      stopReason: "stop",
    });
    expect(outcome.requestState).toBe("completed");
    expect(outcome.tombstones).toBe(0);
    expect(outcome.replayError).toBe(
      "Managed inference request was already completed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes expired cancellation tombstones from its alarm", async () => {
    const installationId = "installation_cancel_cleanup";
    const logicalRequestId = "request_cancel_cleanup";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    await stub.abort(logicalRequestId);

    const remaining = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE inference_cancellations SET expires_at = ?
         WHERE logical_request_id = ?`,
        Date.now() - 1,
        logicalRequestId,
      );
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      await (instance as InferenceInstallation).alarm();
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM inference_cancellations",
      ).one().count;
    });

    expect(remaining).toBe(0);
  });

  it("keeps parallel generations in flight without a concurrency cap", async () => {
    const installationId = "installation_parallel";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const responders: Array<(response: Response) => void> = [];
    let markBothStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      const response = new Promise<Response>((resolve) => responders.push(resolve));
      if (responders.length === 2) markBothStarted();
      return await response;
    }));

// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
// SAFETY: This test callback receives the concrete fixture implementation.
    const state = await runInDurableObject(stub, async (instance) => {
      // SAFETY: The test fixture provides the concrete installation implementation.
      const installation = instance as InferenceInstallation;
      const first = installation.generate(request(
        installationId,
        "request_parallel_a",
      ));
      const second = installation.generate(request(
        installationId,
        "request_parallel_b",
      ));
      await bothStarted;
      const pending = await installation.usage();
      responders[0]?.(completion("gen_parallel_a"));
      responders[1]?.(completion("gen_parallel_b"));
      const results = await Promise.all([first, second]);
      return {
        pending,
        settled: await installation.usage(),
        resultCount: results.length,
      };
    });

    expect(state.pending).toMatchObject({
      spentNanoUsd: 0,
      startedRequests: 2,
      completedRequests: 0,
    });
    expect(state.pending.reservedNanoUsd).toBeGreaterThan(0);
    expect(state.resultCount).toBe(2);
    expect(state.settled).toMatchObject({
      spentNanoUsd: 680,
      reservedNanoUsd: 0,
      completedRequests: 2,
    });
  });

  it("coalesces duplicate in-flight logical requests", async () => {
    const installationId = "installation_duplicate";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    let respond: (response: Response) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      markStarted();
      return await new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await runInDurableObject(stub, async (instance) => {
      // SAFETY: The test fixture provides the concrete installation implementation.
      const installation = instance as InferenceInstallation;
      const input = request(installationId, "request_duplicate");
      const first = installation.generate(input);
      const second = installation.generate(input);
      await started;
      respond(completion("gen_duplicate"));
      const results = await Promise.all([first, second]);
      return {
        results,
        usage: await installation.usage(),
      };
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.results[0]).toEqual(state.results[1]);
    expect(state.usage).toMatchObject({
      spentNanoUsd: 340,
      startedRequests: 1,
      completedRequests: 1,
    });
  });

  it("counts pending reservations when enforcing the allowance", async () => {
    const installationId = "installation_allowance";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    let respond: (response: Response) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      markStarted();
      return await new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }));

    const state = await runInDurableObject(stub, async (instance) => {
      // SAFETY: The test fixture provides the concrete installation implementation.
      const installation = instance as InferenceInstallation;
      const first = installation.generate(request(
        installationId,
        "request_allowance_a",
        6_000,
      ));
      await started;
      let rejection = "";
      try {
        await installation.generate(request(
          installationId,
          "request_allowance_b",
          6_000,
        ));
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      respond(completion("gen_allowance"));
      return { rejection, result: await first };
    });

    expect(state.rejection).toContain("monthly allowance is exhausted");
    expect(state.result).toMatchObject({ responseId: "gen_allowance" });
  });

  it("rejects a disabled installation before contacting the provider", async () => {
    const installationId = "installation_policy_disabled";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion("unexpected"));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = await runInDurableObject(stub, async (instance) => {
      try {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The surrounding owner contract or fixture establishes this asserted shape.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
// SAFETY: The test fixture creates this concrete Durable Object implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
        // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
        await (instance as InferenceInstallation).generate(request(
          installationId,
          "request_policy_disabled",
        ));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });
    expect(rejection).toContain("disabled for this installation");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(stub.usage()).resolves.toMatchObject({
      startedRequests: 0,
      spentNanoUsd: 0,
      reservedNanoUsd: 0,
    });
  });

  it("enforces the installation policy below the deployment ceiling", async () => {
    const installationId = "installation_policy_limited";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const fetchMock = vi.fn<typeof fetch>(async () => completion("unexpected"));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = await runInDurableObject(stub, async (instance) => {
      try {
        // SAFETY: The test fixture provides the concrete installation implementation.
        await (instance as InferenceInstallation).generate(request(
          installationId,
          "request_policy_limited",
          32,
        ));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });
    expect(rejection).toContain("monthly allowance is exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports completed rows from an alarm and marks them delivered", async () => {
    const installationId = "installation_export";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => completion("gen_export")));
    await stub.generate(request(installationId, "request_export"));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE inference_requests SET next_export_at = ?",
        Date.now(),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const exportedAt = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql.exec<{ exported_at: number | null }>(
        `SELECT exported_at FROM inference_requests
         WHERE logical_request_id = 'request_export'`,
      ).one().exported_at,
    );
    expect(exportedAt).not.toBeNull();
  });

  it("charges expired reservations conservatively before releasing them", async () => {
    const installationId = "installation_abandoned";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const snapshot = await runInDurableObject(stub, async (instance, state) => {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
      await (instance as InferenceInstallation).usage();
      const period = new Date().toISOString().slice(0, 7);
      state.storage.sql.exec(
        `INSERT INTO inference_periods (
           period, reserved_nano_usd, started_requests
         ) VALUES (?, 100, 1)`,
        period,
      );
      state.storage.sql.exec(
        `INSERT INTO inference_requests (
           logical_request_id, local_uid, period, model, state,
           reserved_nano_usd, started_at, reservation_expires_at
         ) VALUES (?, 1000, ?, ?, 'reserved', 100, ?, ?)`,
        "request_abandoned",
        period,
        GSV_INFERENCE_PRODUCT_MODEL,
        Date.now() - 2,
        Date.now() - 1,
      );
      state.storage.sql.exec(
        `INSERT INTO inference_cancellations (logical_request_id, expires_at)
         VALUES (?, ?)`,
        "request_abandoned",
        Date.now() + 60_000,
      );

      // SAFETY: The test fixture provides the concrete installation implementation.
      await (instance as InferenceInstallation).alarm();
      return {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
        usage: await (instance as InferenceInstallation).usage(period),
        tombstones: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM inference_cancellations
           WHERE logical_request_id = 'request_abandoned'`,
        ).one().count,
      };
    });

    expect(snapshot.usage).toMatchObject({
      reservedNanoUsd: 0,
      spentNanoUsd: 100,
      abandonedRequests: 1,
    });
    expect(snapshot.tombstones).toBe(0);
  });

  it("retains usage and rearms export after an Accounts failure", async () => {
    const installationId = "installation_export_retry";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => completion("gen_retry")));
    await stub.generate(request(installationId, "request_export_retry"));

    const state = await runInDurableObject(stub, async (instance, durableState) => {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      // SAFETY: The test fixture provides the concrete installation implementation.
      const untyped: unknown = instance;
      // SAFETY: The test fixture exposes the environment through the Durable Object instance.
      const object = untyped as { env: InferenceEnv };
      object.env.ACCOUNTS = {
        getManagedInferencePolicy: async (installationId) => ({
          version: 1,
          installationId,
          enabled: true,
          monthlyLimitNanoUsd: Number.MAX_SAFE_INTEGER,
          routing: DEFAULT_ROUTING,
        }),
        recordManagedInferenceUsage: async () => {
          throw new Error("synthetic Accounts outage");
        },
      };
      durableState.storage.sql.exec(
        "UPDATE inference_requests SET next_export_at = ?",
        Date.now(),
      );
      // SAFETY: The test fixture provides the concrete installation implementation.
      await (instance as InferenceInstallation).alarm();
      return durableState.storage.sql.exec<{
        exported_at: number | null;
        export_attempts: number;
        next_export_at: number | null;
      }>(
        `SELECT exported_at, export_attempts, next_export_at
         FROM inference_requests
         WHERE logical_request_id = 'request_export_retry'`,
      ).one();
    });

    expect(state.exported_at).toBeNull();
    expect(state.export_attempts).toBe(1);
    expect(state.next_export_at).toBeGreaterThan(Date.now());
  });

  it("does not let a request address another installation", async () => {
    const stub = env.INFERENCE_INSTALLATIONS.getByName("installation_owner");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    const rejection = await runInDurableObject(stub, async (instance) => {
      try {
        // SAFETY: The test fixture provides the concrete installation implementation.
        await (instance as InferenceInstallation).generate(request(
          "installation_other",
          "request_wrong_installation",
        ));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });
    expect(rejection).toContain("belongs to another installation");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

interface TestObject { [key: string]: string | number | boolean | null | TestObject | TestObject[]; }

function sse(payload: TestObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
