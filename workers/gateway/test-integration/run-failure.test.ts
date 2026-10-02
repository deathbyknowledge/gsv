import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("run failure visibility", () => {
  it("retains a pre-generation failure and accepts a subsequent message", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const process = await runtime.spawn("First reply");
      await runtime.configureAi(process.pid);
      await runtime.client.proc.observe({ pid: process.pid });
      await runtime.client.sys.config.set({ key: "users/1000/ai/models", value: JSON.stringify({ version: 1, models: [{
        id: "integration-model", name: "Unavailable metadata", provider: "custom", model: "integration-metadata-error",
        baseUrl: runtime.ai.baseUrl, providerStyle: "openai-chat-completions", transportTarget: "gsv",
      }] }) });
      const sent = await runtime.client.proc.send({ pid: process.pid, message: "Hello" });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.finished"
        && payload.pid === process.pid && payload.status === "error"), "first-run failure", 15000);
      const history = await runtime.client.proc.history({ pid: process.pid, format: 2 });
      if (!history.ok) throw new Error(history.error);
      if (history.format !== 2) throw new Error("Expected typed process history");
      expect(history.activeRunId).toBeNull();
      expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "event", payload: {
        kind: "runtime.failed", severity: "error", audience: "both",
        payload: { reason: "tick.error", prefix: "Process run failed", error: expect.stringContaining("Fixture model metadata unavailable") },
      } })]));
      await runtime.configureAi(process.pid);
      runtime.ai.enqueue({ kind: "tool-calls", calls: [{ id: "yield", name: "Shell", arguments: { input: "yield" } }] });
      expect(await runtime.client.proc.send({ pid: process.pid, message: "Try again" })).toMatchObject({ ok: true });
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.finished"
        && payload.pid === process.pid && payload.status === "ok"), "recovered run", 15000);
    } finally { await runtime.close(); }
  });
});
