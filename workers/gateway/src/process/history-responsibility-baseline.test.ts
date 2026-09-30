import { evictDurableObject } from "cloudflare:test";
import type { ResponsibilityRecord, ResponsibilityTransition } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";
import type { RunState } from "./run/state";

const initial: ResponsibilityRecord = {
  id: "r12y:initial", ownerUid: 0, title: "Welcome", details: { instructions: "Ask how the owner wants to work together." },
  assignee: { kind: "ship" }, state: "waiting", priority: "high", source: { kind: "system", component: "onboarding" },
  revision: 1, createdAtMs: 1, updatedAtMs: 1,
};

function runFixture(pid: string, runId: string, template = "{{r12y}}"): RunState {
  return {
    runId, tools: [], targets: [], mcpServers: [],
    config: { ...terminalTestConfig(pid), skillIndexMode: "off", systemContextFiles: [{ name: "responsibilities.md", text: template }] },
  };
}

describe("responsibility baseline lifecycle", () => {
  it("carries details through initial context, live additions, real compaction and eviction", async () => {
    const stub = await initProcess("responsibility-baseline-lifecycle", ROOT_IDENTITY);
    const saved = await runInProcess(stub, async (process: Process) => {
      vi.spyOn(process, "sendSignal").mockResolvedValue();
      const kernel = vi.spyOn(process.kernel, "kernelRpc");
      kernel.mockResolvedValueOnce({ responsibilities: [initial], count: 1, revision: 1 });
      const run = runFixture(process.pid, "baseline-run");
      process.runs.active = run;
      const epoch = await process.history.ensureContextEpoch(run.runId, run, run.config!);
      if (!epoch) throw new Error("Initial context was not created");
      expect(epoch.systemPrompt).toContain(initial.details!.instructions);
      expect(epoch.sourceManifest.r12yBaselineDetailIds).toEqual([initial.id]);

      const added: ResponsibilityRecord = {
        ...initial, id: "r12y:added", title: "Prepare the report", details: { task: "Compare the two source documents." }, revision: 2,
      };
      const updated = { ...initial, state: "active" as const, revision: 3 };
      const resolved = { ...updated, state: "resolved" as const, revision: 4 };
      const changes: ResponsibilityTransition[] = [
        { revision: 2, responsibilityId: added.id, kind: "created", afterState: added.state,
          changedFields: ["created"], actor: initial.source, record: added, createdAtMs: 2 },
        { revision: 3, responsibilityId: initial.id, kind: "updated", beforeState: initial.state, afterState: updated.state,
          changedFields: ["state"], actor: initial.source, record: updated, createdAtMs: 3 },
        { revision: 4, responsibilityId: initial.id, kind: "resolved", beforeState: updated.state, afterState: resolved.state,
          changedFields: ["state"], actor: initial.source, record: resolved, createdAtMs: 4 },
      ];
      kernel.mockResolvedValueOnce({ transitions: changes, revision: 4, hasMore: false });
      await process.history.syncResponsibilityDeltas(run.runId, epoch);
      const messages = process.store.messages.getMessages();
      expect(messages[0]?.content).toContain('Details:\n- task: "Compare the two source documents."');
      expect(messages[1]?.content).toContain("New state: active");
      expect(messages[1]?.content).not.toContain("New details:");
      expect(messages[2]?.content).toContain("New state: resolved");
      expect(process.store.epochs.getLiveContextEpoch()?.systemPrompt).toBe(epoch.systemPrompt);
      expect(JSON.stringify(await process.history.buildContextMessages())).toContain(added.details!.task);

      process.runs.active = null;
      const compacted = await process.history.handleHistoryCompact({ keepLast: 0, summary: "The owner completed onboarding; the report remains open." });
      expect(compacted).toMatchObject({ ok: true });
      expect(process.store.epochs.getLiveContextEpoch()).toBeNull();
      const next = runFixture(process.pid, "after-compaction");
      process.runs.active = next;
      kernel.mockResolvedValueOnce({ responsibilities: [added], count: 1, revision: 4 });
      const rebuilt = await process.history.ensureContextEpoch(next.runId, next, next.config!);
      if (!rebuilt) throw new Error("Compacted context was not created");
      expect(rebuilt.systemPrompt).toContain(added.details!.task);
      expect(rebuilt.systemPrompt).not.toContain(initial.details!.instructions);
      expect(rebuilt.sourceManifest.r12yBaselineDetailIds).toEqual([added.id]);
      expect(process.store.epochs.getContextEpoch(epoch.id)).toMatchObject({ state: "closed", systemPrompt: epoch.systemPrompt });
      expect(kernel.mock.calls.map(([call]) => call)).toEqual(["r12y.list", "r12y.changes", "r12y.list"]);
      process.runs.active = null;
      return { prompt: rebuilt.systemPrompt, detailIds: rebuilt.sourceManifest.r12yBaselineDetailIds };
    });
    await evictDurableObject(stub);
    await runInProcess(stub, (process: Process) => {
      expect(process.store.epochs.getLiveContextEpoch()).toMatchObject({
        systemPrompt: saved.prompt, sourceManifest: { r12yBaselineDetailIds: saved.detailIds },
      });
    });
  });

  it.each(["missing-template", "recovered-prompt"])("does not claim details were shown for %s", async (mode) => {
    const stub = await initProcess(`responsibility-baseline-${mode}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      vi.spyOn(process.kernel, "kernelRpc").mockResolvedValueOnce({ responsibilities: [initial], count: 1, revision: 1 });
      const run = runFixture(process.pid, "baseline-run", mode === "missing-template" ? "Custom context" : "{{r12y}}");
      if (mode === "recovered-prompt") run.systemPrompt = "Previously captured context";
      process.runs.active = run;
      const epoch = await process.history.ensureContextEpoch(run.runId, run, run.config!);
      expect(epoch?.sourceManifest).toMatchObject({ r12yBaselineRendered: false, r12yBaselineDetailIds: [] });
      expect(epoch?.systemPrompt).not.toContain(initial.details!.instructions);
      process.runs.active = null;
    });
  });
});
