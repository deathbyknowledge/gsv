import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { InferenceExecutionRequest, InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

const requestRows = z.array(z.object({
  request_id: z.string(),
  state: z.string(),
  local_uid: z.number(),
  reserved_tokens: z.number(),
  output_tokens: z.number(),
}));

describe("Process inference attempts across the execution service", () => {
  it("retries an empty generation without reopening or cancelling its completed predecessor", async () => {
    const runtime = await startProcessRuntimeHarness();
    const first = runtime.ai.hold({ kind: "text", chunks: [] });
    const retry = runtime.ai.hold({ kind: "message", text: "The deliberate retry completed." });
    try {
      const process = await runtime.spawn("executor retry isolation");
      await runtime.configureAi(process.pid);
      const sent = await runtime.client.proc.send({ pid: process.pid, message: "Complete this request." });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.ai.waitForRequests(1);
      const storage = await runtime.harness.getWorker("gsv-execution-test")
        .getDurableObjectStorage("INFERENCE_EXECUTORS", { name: "singleton" });
      const readRequests = async () => requestRows.parse(await storage.exec(
        "SELECT request_id, local_uid, state, reserved_tokens, output_tokens FROM executor_requests ORDER BY accepted_at, request_id",
      ));
      const before = await readRequests();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ state: "active", output_tokens: 0 });
      const firstId = before[0]!.request_id;
      first.release();

      await runtime.ai.waitForRequests(2);
      const during = await readRequests();
      expect(during).toHaveLength(2);
      expect(during.find((row) => row.request_id === firstId)).toMatchObject({
        state: "completed", reserved_tokens: 0, output_tokens: 3,
      });
      const retryRow = during.find((row) => row.request_id !== firstId);
      expect(retryRow).toMatchObject({ state: "active", output_tokens: 0 });
      expect(retryRow!.reserved_tokens).toBeGreaterThan(0);
      expect(runtime.ai.requests[1]).toEqual(runtime.ai.requests[0]);

      const { INFERENCE_EXECUTION } = await runtime.harness
        .getWorker<{ INFERENCE_EXECUTION: InferenceExecutionService }>("gsv").getEnv();
      const executor = await INFERENCE_EXECUTION.getExecutor("singleton");
      const replay: InferenceExecutionRequest = {
        version: 1, installationId: "singleton", logicalRequestId: firstId,
        actor: { localUid: before[0]!.local_uid, processId: process.pid, runId: sent.runId },
        connection: { provider: "custom", model: "integration-model", apiKey: "fixture-only",
          baseUrl: runtime.ai.baseUrl, providerStyle: "openai-chat-completions", maxTokens: 128, contextWindowTokens: null },
        messages: [{ role: "user", content: "Complete this request." }],
        timeoutMs: 10_000, deadlineAt: Date.now() + 10_000,
      };
      await expect(async () => await executor.generate(replay)).rejects.toThrow("Inference request identity has already been used");
      await executor.abort(firstId);
      expect(await readRequests()).toEqual(during);
      expect(runtime.ai.requests).toHaveLength(2);

      retry.release();
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === sent.runId && payload.status === "ok"),
      "the deliberate generation retry to finish successfully");
      const { conversation } = await runtime.client.conversation.forProcess({ pid: process.pid });
      expect((await runtime.client.conversation.history({ conversationId: conversation.id })).messages.at(-1)?.text)
        .toBe("The deliberate retry completed.");
      expect(runtime.ai.requests).toHaveLength(2);
      expect(await readRequests()).toEqual(during.map((row) => ({
        ...row, state: "completed", reserved_tokens: 0, output_tokens: 3,
      })));
    } finally {
      first.release();
      retry.release();
      await runtime.close();
    }
  });
});
