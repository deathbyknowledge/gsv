import { env } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceEnv } from "./env";
import type { InferenceInstallation } from "./installation";

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

function completion(id: string): Response {
  return new Response([
    sse({
      id,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installation managed inference", () => {
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

    const state = await runInDurableObject(stub, async (instance) => {
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

  it("abandons expired durable reservations and releases their allowance", async () => {
    const installationId = "installation_abandoned";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    const snapshot = await runInDurableObject(stub, async (instance, state) => {
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

      await (instance as InferenceInstallation).alarm();
      return await (instance as InferenceInstallation).usage(period);
    });

    expect(snapshot).toMatchObject({
      reservedNanoUsd: 0,
      abandonedRequests: 1,
    });
  });

  it("retains usage and rearms export after an Accounts failure", async () => {
    const installationId = "installation_export_retry";
    const stub = env.INFERENCE_INSTALLATIONS.getByName(installationId);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => completion("gen_retry")));
    await stub.generate(request(installationId, "request_export_retry"));

    const state = await runInDurableObject(stub, async (instance, durableState) => {
      const object = instance as unknown as { env: InferenceEnv };
      object.env.ACCOUNTS = {
        recordManagedInferenceUsage: async () => {
          throw new Error("synthetic Accounts outage");
        },
      };
      durableState.storage.sql.exec(
        "UPDATE inference_requests SET next_export_at = ?",
        Date.now(),
      );
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

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
