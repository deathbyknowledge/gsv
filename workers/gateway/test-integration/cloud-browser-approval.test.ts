import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "@humansandmachines/gsv/protocol";
import { startProcessRuntimeHarness } from "./process-runtime-harness";
import type { IntegrationState } from "./fixtures/dependencies";

describe("cloud browser approval", () => {
  it("polls a Kernel-committed session when the start response never reached the Process", async () => {
    const runtime = await startProcessRuntimeHarness({ instances: true });
    try {
      const { INTEGRATION_STATE } = await runtime.harness.getWorker<{
        INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
      }>("gsv-test-dependencies").getEnv();
      const state = INTEGRATION_STATE.getByName("integration-recorder");
      const process = await runtime.spawn("Uncertain shell recovery");
      await runtime.configureAi(process.pid);
      const sessionId = crypto.randomUUID();
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "start", name: "Shell", arguments: { start: true, sessionId, target: "cloud-browser", input: "page snapshot" } }] },
        { kind: "tool-calls", calls: [{ id: "poll", name: "Shell", arguments: { sessionId, input: "" } }] },
        { kind: "tool-calls", calls: [{ id: "yield", name: "Shell", arguments: { input: "yield" } }] },
      );
      expect(await runtime.client.proc.send({ pid: process.pid, message: "Recover the shell result." })).toMatchObject({ ok: true });
      await runtime.waitFor(async () => {
        const history = await runtime.client.proc.history({ pid: process.pid, includeMessages: false });
        return history.ok && history.activeRunId === null && history.pendingHil === null;
      }, "uncertain session recovery", 15000);
      expect(await state.listInstanceCalls()).toEqual(["shell.exec", "shell.exec"]);
    } finally { await runtime.close(); }
  });

  it("automatically admits Shell and CodeMode in a clean space, and respects an explicit Ask override", async () => {
    const runtime = await startProcessRuntimeHarness({ instances: true });
    try {
      const { INTEGRATION_STATE } = await runtime.harness.getWorker<{
        INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
      }>("gsv-test-dependencies").getEnv();
      const state = INTEGRATION_STATE.getByName("integration-recorder");
      for (const mode of ["Shell", "CodeMode", "Ask"] as const) {
        const process = await runtime.spawn(`Cloud browser ${mode}`);
        await runtime.configureAi(process.pid);
        await runtime.client.proc.observe({ pid: process.pid });
        if (mode === "Ask") {
          await runtime.client.sys.config.set({ key: "users/1000/ai/tools/approval", value: JSON.stringify({
            ...DEFAULT_TOOL_APPROVAL_POLICY,
            rules: [{ match: "shell.exec", target: { route: "instance", platform: "browser" }, action: "ask" }, ...DEFAULT_TOOL_APPROVAL_POLICY.rules],
          }) });
        }
        runtime.ai.enqueue(
          { kind: "tool-calls", calls: [{ id: `browser-${mode}`, name: mode === "CodeMode" ? "CodeMode" : "Shell", arguments: mode === "CodeMode" ? {
            code: 'return await shell("page snapshot", { target: "cloud-browser" });',
          } : { input: "page snapshot", target: "cloud-browser" } }] },
          { kind: "tool-calls", calls: [{ id: `yield-${mode}`, name: "Shell", arguments: { input: "yield" } }] },
        );
        const sent = await runtime.client.proc.send({ pid: process.pid, message: "Use the cloud browser." });
        if (!sent.ok) throw new Error(sent.error);
        if (mode === "Ask") {
          await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.hil.requested" && payload.pid === process.pid), "cloud browser approval");
          const history = await runtime.client.proc.history({ pid: process.pid, includeMessages: false });
          if (!history.ok || !history.pendingHil) throw new Error("Browser approval missing");
          expect(await state.listInstanceCalls()).toHaveLength(2);
          expect(await runtime.client.proc.hil({ pid: process.pid, requestId: history.pendingHil.requestId, decision: "deny" })).toMatchObject({ ok: true });
        }
        await runtime.waitFor(async () => {
          const history = await runtime.client.proc.history({ pid: process.pid, includeMessages: false });
          return history.ok && history.activeRunId === null && history.pendingHil === null;
        }, `${mode} browser completion`, 15000);
        expect(await state.listInstanceCalls()).toHaveLength(mode === "Shell" ? 1 : 2);
        if (mode !== "Ask") expect(runtime.signals.filter(({ signal, payload }) => signal === "proc.run.hil.requested" && payload.pid === process.pid)).toEqual([]);
      }
    } finally { await runtime.close(); }
  });
});
