import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import { contextSnapshotFromRun } from "./run/helpers";
import { generationRun, initProcess, mockGeneration, processTestConfig, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";

const runId = "checkpoint-run";
const owner = { runId, requestId: "checkpoint-dispatch" };
const handover = "The user corrected the deadline to Friday. The report is in /report.md; verify its citations next. Onboarding is complete.";

async function prepare(process: Process) {
  vi.spyOn(process, "sendSignal").mockResolvedValue();
  vi.spyOn(process.kernel, "kernelRpc").mockResolvedValue({ responsibilities: [], count: 0, revision: 0 });
  const run = { runId, tools: [], targets: [], mcpServers: [], config: { ...terminalTestConfig(process.pid), skillIndexMode: "off" as const } };
  process.runs.active = run;
  const epoch = await process.history.ensureContextEpoch(runId, run, run.config);
  if (!epoch) throw new Error("Missing initial epoch");
  const inputId = process.store.messages.appendMessage("user", "Prepare the report, without publishing it.", { runId });
  const finishedId = process.store.messages.appendMessage("assistant", "Verified the source and wrote /report.md.", { runId });
  const calls = ["checkpoint-call", "concurrent-call"].map((callId) => ({
    kind: "call" as const,
    payload: { callId, tool: "Shell", syscall: "shell.exec", args: {}, target: "gsv", runId },
  }));
  const toolId = process.store.messages.appendMessage("assistant", "Save the handover", { runId, records: calls });
  process.store.tools.register(owner.requestId, "checkpoint-call", runId, "shell.exec", {});
  process.store.tools.register("concurrent-dispatch", "concurrent-call", runId, "shell.exec", {});
  return { inputId, finishedId, toolId, epochId: epoch.id };
}

function finishTools(process: Process) {
  for (const callId of ["checkpoint-call", "concurrent-call"]) {
    process.store.messages.appendMessage("toolResult", "Completed", { runId, toolCallId: callId, record: {
      kind: "result", payload: { callId, tool: "Shell", outcome: "completed", output: "Completed", media: [], resources: [] },
    } });
  }
  process.store.tools.clearRun(runId);
}

describe("process-authored handover", () => {
  it("waits for the whole tool batch, survives eviction, and retains the exact assignment and unseen results", async () => {
    const stub = await initProcess("checkpoint-eviction", ROOT_IDENTITY);
    const initial = await runInProcess(stub, async (process: Process) => {
      const fixture = await prepare(process);
      const before = process.store.messages.getMessages();
      expect(await process.history.requestHistoryCompaction({ summary: handover }, owner)).toEqual({ ok: true, pid: process.pid, pending: true });
      expect(await process.history.applyPendingCompaction(runId)).toBe(false);
      expect(process.store.messages.getMessages()).toEqual(before);
      expect(process.store.history.listHistorySegments()).toHaveLength(0);
      return fixture;
    });
    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      vi.spyOn(process, "sendSignal").mockResolvedValue();
      expect(process.runs.active?.pendingCompaction?.summary).toBe(handover);
      finishTools(process);
      const lateId = process.store.messages.appendMessage("system", "An unrelated completed task reported its result.");
      expect(await process.history.applyPendingCompaction(runId)).toBe(true);
      const messages = process.store.messages.getMessages();
      expect(messages.find((message) => message.id === initial.inputId)?.content).toBe("Prepare the report, without publishing it.");
      expect(process.store.messages.getRunInputMessageId(runId)).toBe(initial.inputId);
      expect(messages.find((message) => message.id === initial.finishedId)?.content).toContain(handover);
      expect(messages.find((message) => message.id === initial.toolId)?.records).toHaveLength(2);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
      expect(messages.at(-1)?.id).toBe(lateId);
      expect(process.runs.active?.pendingCompaction).toBeUndefined();
      expect(process.runs.active?.contextEpochId).toBeUndefined();
      expect(process.store.epochs.getContextEpoch(initial.epochId)?.state).toBe("closed");
      const [segment] = process.store.history.listHistorySegments();
      const archived = await process.history.handleHistorySegmentRead({ segmentId: segment!.id });
      expect(archived.ok && archived.messages.some((message) => message.id === initial.finishedId && JSON.stringify(message.content).includes("Verified the source and wrote /report.md."))).toBe(true);
      expect(await process.history.applyPendingCompaction(runId)).toBe(true);
      expect(process.store.history.listHistorySegments()).toHaveLength(1);
      process.runs.active = null;
    });
  });

  it("rejects external, forged, cancelled and superseded owners without changing history", async () => {
    const stub = await initProcess("checkpoint-ownership", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      await prepare(process);
      const before = process.store.messages.getMessages();
      expect(await process.history.requestHistoryCompaction({ summary: handover, keepLast: 1 }, undefined)).toMatchObject({ ok: false, error: "Process is active" });
      expect(await process.history.requestHistoryCompaction({ summary: handover }, { ...owner, requestId: "forged" })).toMatchObject({ ok: false });
      expect(await process.history.requestHistoryCompaction({ summary: handover }, owner, AbortSignal.abort())).toMatchObject({ ok: false });
      process.runs.active = { ...process.runs.active!, runId: "replacement" };
      expect(await process.history.requestHistoryCompaction({ summary: handover }, owner)).toMatchObject({ ok: false });
      expect(process.store.messages.getMessages()).toEqual(before);
      process.store.tools.clearRun(runId);
      process.runs.active = null;
    });
  });

  it("installs after result ingestion and rebuilds the epoch before the next generation", async () => {
    const stub = await initProcess("checkpoint-next-generation", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const initial = await prepare(process);
      vi.mocked(process.kernel.kernelRpc).mockImplementation(async (call) => {
        if (call === "r12y.list") return { responsibilities: [], count: 0, revision: 0 };
        if (call === "r12y.changes") return { transitions: [], revision: 0, hasMore: false };
        if (call === "ai.context") return contextSnapshotFromRun(process.runs.active!, process.runs.active!.config!);
        throw new Error(`Unexpected test syscall: ${call}`);
      });
      await process.history.requestHistoryCompaction({ summary: handover }, owner);
      process.store.tools.resolve(owner.requestId, { ok: true, pending: true });
      process.store.tools.resolve("concurrent-dispatch", { stdout: "New evidence from the concurrent tool" });
      let generated = false;
      vi.spyOn(process.run, "runGenerationCycle").mockImplementation(async (_runId, prepared) => {
        generated = true;
        const rendered = JSON.stringify(prepared.context);
        expect(rendered).toContain(handover);
        expect(rendered).toContain("Prepare the report, without publishing it.");
        expect(rendered).toContain("New evidence from the concurrent tool");
        expect(process.runs.active?.contextEpochId).not.toBe(initial.epochId);
        expect(process.runs.active?.pendingCompaction).toBeUndefined();
        expect(process.store.history.listHistorySegments()).toHaveLength(1);
        return null;
      });
      await process.run.runTick(runId);
      expect(generated).toBe(true);
      process.runs.active = null;
    });
  });

  it("leaves history intact when archiving fails", async () => {
    const stub = await initProcess("checkpoint-archive-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      await prepare(process);
      await process.history.requestHistoryCompaction({ summary: handover }, owner);
      finishTools(process);
      const before = process.store.messages.getMessages();
      vi.spyOn(process.storage, "put").mockRejectedValueOnce(new Error("Synthetic archive failure"));
      await expect(process.history.applyPendingCompaction(runId)).rejects.toThrow("Synthetic archive failure");
      expect(process.store.messages.getMessages()).toEqual(before);
      expect(process.store.history.listHistorySegments()).toHaveLength(0);
      process.runs.active = null;
    });
  });

  it("drops a queued handover when the active run is replaced", async () => {
    const stub = await initProcess("checkpoint-replaced", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      await prepare(process);
      await process.history.requestHistoryCompaction({ summary: handover }, owner);
      process.runs.active = { runId: "new-input" };
      process.store.messages.appendMessage("user", "Stop the report; answer my new question.", { runId: "new-input" });
      finishTools(process);
      expect(await process.history.applyPendingCompaction(runId)).toBe(true);
      expect(process.store.history.listHistorySegments()).toHaveLength(0);
      expect(process.store.messages.getMessages().at(-3)?.content).toContain("new question");
      process.runs.active = null;
    });
  });

  it("can compact completed steps inside one long worker run", async () => {
    const stub = await initProcess("checkpoint-long-worker", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      vi.spyOn(process, "sendSignal").mockResolvedValue();
      const inputId = process.store.messages.appendMessage("user", "Compare both sources, then report; do not publish.", { runId });
      for (let step = 0; step < 100; step += 1) {
        process.store.messages.appendMessage("assistant", `Completed source check ${step}: ${"evidence ".repeat(65)}`, { runId });
      }
      process.runs.active = generationRun(runId, processTestConfig(process.pid, { contextWindowTokens: 20_000, maxTokens: 1_000 }));
      mockGeneration(process, async () => { throw new Error("Generation is intercepted below"); }, async () => "Both sources are checked. Write the comparison next; do not publish.");
      let generated = false;
      vi.spyOn(process.run, "runGenerationCycle").mockImplementation(async (_runId, prepared) => {
        generated = true;
        expect(JSON.stringify(prepared.context)).toContain("Both sources are checked");
        expect(JSON.stringify(prepared.context)).toContain("Compare both sources, then report; do not publish.");
        return null;
      });
      await process.run.runTick(runId);
      expect(generated).toBe(true);
      expect(process.store.messages.getRunInputMessageId(runId)).toBe(inputId);
      const [segment] = process.store.history.listHistorySegments();
      expect(segment?.toMessageId).toBeGreaterThan(inputId);
      expect(process.store.messages.messageCount()).toBeLessThan(100);
      process.runs.active = null;
    });
  });
});
