import type { AiContextResult } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { createContextProjection } from "./context/projection";
import {
  initProcess, responsibilityKernelResult, ROOT_IDENTITY, runInProcess, terminalTestConfig,
} from "./do-test-harness";
import type { RunTickContextState } from "./internal/contracts";

describe("Process target availability", () => {
  it("keeps its durable target projection through failed discovery and emits only confirmed changes", async () => {
    const pid = "target-availability-recovery";
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });
    await runInProcess(stub, async (process) => {
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        const result = responsibilityKernelResult(call);
        if (result) return result;
        throw new Error(`unexpected Kernel call: ${call}`);
      });
      const changed = vi.spyOn(process.signals, "changed").mockResolvedValue(undefined);
      const config = {
        ...terminalTestConfig(pid),
        generationTimeoutMs: 30_000,
        capabilities: ["*"],
        systemContextFiles: [],
        skillIndexMode: "off" as const,
      };
      const snapshot: AiContextResult = {
        targets: [{ id: "slack-target:workspace", label: "Slack", implements: ["shell.exec"] }],
        mcpServers: [],
        systemContextFiles: [],
        system: { timezone: "UTC" },
        skillIndexMode: "off",
        skillIndex: [],
      };
      const state: RunTickContextState = {
        run: {
          runId: "availability-initial",
          config,
          devices: snapshot.targets,
          mcpServers: [],
          tools: [],
          approvalPolicy: { default: "auto", rules: [] },
        },
        activeConfig: config,
        tools: [],
        workTools: [],
        context: { systemPrompt: "", messages: [] },
        contextState: null,
        autoCompactionPressure: null,
      };
      process.runs.active = state.run;
      const initial = await process.history.ensureContextEpoch(
        state.run.runId, state.run, config, snapshot, createContextProjection(snapshot),
      );
      const refresh = vi.spyOn(process.settings, "resolveAiContext");

      try {
        // A later run starts without the previously discovered targets in its run state.
        state.run = { ...state.run, runId: "availability-next", devices: [], systemPrompt: undefined };
        process.runs.active = state.run;
        refresh.mockResolvedValue({ ...snapshot, targets: undefined });
        await process.run.refreshRunTickContextEpoch(state.run.runId, state);
        expect(state.run.devices).toEqual(snapshot.targets);
        expect(process.store.epochs.getLiveContextEpoch().observedProjection.targets).toEqual(snapshot.targets);
        expect(process.store.messages.getMessages()).toHaveLength(0);

        refresh.mockResolvedValue(snapshot);
        await process.run.refreshRunTickContextEpoch(state.run.runId, state);
        expect(process.store.messages.getMessages()).toHaveLength(0);

        refresh.mockResolvedValue({ ...snapshot, targets: [] });
        await process.run.refreshRunTickContextEpoch(state.run.runId, state);
        expect(state.run.devices).toEqual([]);
        expect(process.store.messages.getMessages()).toHaveLength(1);
        expect(process.store.messages.getMessages()[0].content).toContain("- Removed: `slack-target:workspace`");

        refresh.mockResolvedValue({ ...snapshot, targets: undefined });
        await process.run.refreshRunTickContextEpoch(state.run.runId, state);
        expect(state.run.devices).toEqual([]);
        expect(process.store.messages.getMessages()).toHaveLength(1);

        refresh.mockResolvedValue(snapshot);
        await process.run.refreshRunTickContextEpoch(state.run.runId, state);
        const messages = process.store.messages.getMessages();
        expect(messages).toHaveLength(2);
        expect(messages[1].content).toContain("- Added: `slack-target:workspace`");
        expect(process.store.epochs.getLiveContextEpoch().id).toBe(initial.id);
        expect(process.store.epochs.getLiveContextEpoch().systemPrompt).toBe(initial.systemPrompt);
      } finally {
        refresh.mockRestore();
        changed.mockRestore();
      }
    });
  });
});
