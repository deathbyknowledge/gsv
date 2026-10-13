import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getKernelPtr } from "../shared/utils";
import { admitMemoryReview, runMemoryReview } from "../kernel/memory-review";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { deliverMemoryReview, enqueueMemoryReview } from "./memory-review";
import type { ProcessMemoryReview } from "../protocol/process-frames";

const source = (throughMessageId: number) => ({ segmentId: crypto.randomUUID(), archivePath: "/home/ship/processes/source/history/segment.jsonl.gz", generation: 0, throughMessageId });

describe("durable memory review delivery", () => {
  it("starts a fresh range after reset and does not recursively review worker history", async () => {
    const stub = await initProcess("memory-review-generations", ROOT_IDENTITY);
    await runInProcess(stub, (process) => {
      enqueueMemoryReview(process, source(20));
      enqueueMemoryReview(process, source(10));
      process.store.resetHistory();
      enqueueMemoryReview(process, { ...source(5), generation: process.store.state.getHistoryGeneration() });
      process.store.state.setValue("interactive", "0");
      enqueueMemoryReview(process, source(100));
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toMatchObject([
        { afterMessageId: 0, throughMessageId: 20 },
        { afterMessageId: 0, throughMessageId: 5 },
      ]);
    });
  });
  it("records only new ranges and survives eviction before Kernel admission", async () => {
    const pid = "memory-review-eviction";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage("user", "I prefer trains.");
      process.store.messages.appendMessage("assistant", "Understood.");
      process.store.messages.appendMessage("user", "The current request.");
      process.sendSignal = async () => {};
      const compacted = await process.history.handleHistoryCompact({ keepLast: 1, summary: "The user prefers trains." });
      expect(compacted.ok).toBe(true);
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toMatchObject([{ afterMessageId: 0, throughMessageId: 2 }]);
      enqueueMemoryReview(process, { ...source(4), generation: process.store.state.getHistoryGeneration() });
    });
    await evictDurableObject(stub);
    const delivered: ProcessMemoryReview[] = [];
    await runInProcess(stub, async (process) => {
      vi.spyOn(process.kernel, "queueMemoryReview").mockImplementation(async (review) => {
        delivered.push(review);
      });
      await deliverMemoryReview(process, "test-first");
      await deliverMemoryReview(process, "test-second");
      expect(process.trace.list({})).toMatchObject({ spans: [] });
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toEqual([]);
    });
    expect(delivered.map(({ afterMessageId, throughMessageId }) => [afterMessageId, throughMessageId])).toEqual([[0, 2], [2, 4]]);
  });

  it("retains the head and its successor on failure, then advances after acceptance", async () => {
    const stub = await initProcess("memory-review-retry", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      vi.spyOn(process.kernel, "queueMemoryReview")
        .mockRejectedValueOnce(new Error("Synthetic private cause"))
        .mockResolvedValueOnce();
      enqueueMemoryReview(process, source(20));
      await deliverMemoryReview(process, "first-attempt");
      const pending = JSON.parse(process.store.state.getValue("pendingMemoryReviews")!);
      expect(pending).toHaveLength(1);
      const trace = process.trace.list({});
      expect(trace).toMatchObject({ spans: [expect.objectContaining({ status: "error", attributes: { error: "Synthetic private cause" } })] });
      await deliverMemoryReview(process, "second-attempt");
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toEqual([]);
    });
  });

  it("delivers through the real Process-to-Kernel boundary into the owner ledger", async () => {
    const pid = "memory-review-rpc";
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });
    const kernel = await getKernelPtr("inst_test");
    await runInDurableObject(kernel, (instance) => {
      instance.procs.spawn(pid, ROOT_IDENTITY, { ownerUid: ROOT_IDENTITY.uid, isPersonalController: true });
      vi.spyOn(instance.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
      vi.spyOn(instance.responsibilityRuntime, "reconcileResponsibilityWake").mockResolvedValue();
    });
    const review = source(25);
    await runInProcess(stub, async (process) => {
      enqueueMemoryReview(process, review);
      await deliverMemoryReview(process, "real-admission");
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toEqual([]);
    });
    await runInDurableObject(kernel, async (instance) => {
      await runMemoryReview(instance, ROOT_IDENTITY.uid, "kernel-admission");
      const record = instance.responsibilities.getByDedupeKey(ROOT_IDENTITY.uid, `memory.review:${pid}:${review.segmentId}`);
      expect(record).toMatchObject({ ownerUid: ROOT_IDENTITY.uid, details: { sourceProcessId: pid, ...review, afterMessageId: 0 } });
      vi.restoreAllMocks();
    });
  });

  it("hands queued sources to the Kernel before kill, despite restriction and an unfinished review", async () => {
    const ownerUid = 1001;
    const pid = "memory-review-kill";
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });
    const kernel = await getKernelPtr("inst_test");
    const first = source(20);
    const second = source(40);
    const blocker = source(10);
    await runInDurableObject(kernel, async (instance) => {
      instance.procs.spawn(pid, ROOT_IDENTITY, { ownerUid: ownerUid, isPersonalController: true });
      vi.spyOn(instance.onboarding, "managedWorkGate").mockResolvedValue({ allowed: false, code: 423, message: "Restricted" });
      vi.spyOn(instance.responsibilityRuntime, "reconcileResponsibilityWake").mockResolvedValue();
      await admitMemoryReview({ ...blocker, afterMessageId: 0, sourceProcessId: "previous-ship", ownerUid: ownerUid }, instance.buildKernelContext({}));
    });
    await runInProcess(stub, async (process) => {
      enqueueMemoryReview(process, first);
      enqueueMemoryReview(process, second);
      expect(await process.controller.handleProcKill({ archive: false })).toMatchObject({ ok: true });
      expect(process.killed).toBe(true);
    });
    await runInDurableObject(kernel, async (instance) => {
      await runMemoryReview(instance, ownerUid, "restricted");
      expect(instance.ctx.storage.kv.get(`memory-reviews:${ownerUid}`)).toMatchObject([
        { segmentId: first.segmentId, afterMessageId: 0, throughMessageId: 20 },
        { segmentId: second.segmentId, afterMessageId: 20, throughMessageId: 40 },
      ]);
      instance.procs.kill(pid);
      instance.procs.spawn("replacement-ship", ROOT_IDENTITY, { ownerUid: ownerUid, isPersonalController: true });
      vi.restoreAllMocks();
    });
    await evictDurableObject(kernel);
    await runInDurableObject(kernel, async (instance) => {
      vi.spyOn(instance.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
      vi.spyOn(instance.responsibilityRuntime, "reconcileResponsibilityWake").mockResolvedValue();
      await runMemoryReview(instance, ownerUid, "still-busy");
      expect(instance.ctx.storage.kv.get(`memory-reviews:${ownerUid}`)).toHaveLength(2);
      const resolveReview = (sourcePid: string, segmentId: string) => {
        const record = instance.responsibilities.getByDedupeKey(ownerUid, `memory.review:${sourcePid}:${segmentId}`)!;
        instance.responsibilities.update({ ownerUid: ownerUid, id: record.id, patch: { state: "resolved" }, actor: { kind: "system", component: "test" }, observedByShip: true, now: Date.now() });
      };
      resolveReview("previous-ship", blocker.segmentId);
      await runMemoryReview(instance, ownerUid, "first-after-replacement");
      expect(instance.ctx.storage.kv.get(`memory-reviews:${ownerUid}`)).toMatchObject([{ segmentId: second.segmentId }]);
      resolveReview(pid, first.segmentId);
      await runMemoryReview(instance, ownerUid, "second-after-replacement");
      expect(instance.ctx.storage.kv.get(`memory-reviews:${ownerUid}`)).toEqual([]);
      expect(instance.responsibilities.getByDedupeKey(ownerUid, `memory.review:${pid}:${second.segmentId}`)).toMatchObject({ state: "open" });
      vi.restoreAllMocks();
    });
  });

  it("keeps Process state recoverable if teardown cannot transfer its sources", async () => {
    const stub = await initProcess("memory-review-kill-retry", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      enqueueMemoryReview(process, source(20));
      const transfer = vi.spyOn(process.kernel, "queueMemoryReview").mockRejectedValueOnce(new Error("Synthetic handoff interruption"));
      await expect(process.controller.handleProcKill({ archive: false })).rejects.toThrow("Synthetic handoff interruption");
      expect(process.killed).toBe(false);
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toHaveLength(1);
      transfer.mockResolvedValue();
      expect(await process.controller.handleProcKill({ archive: false })).toMatchObject({ ok: true });
      expect(process.killed).toBe(true);
    });
  });

  it("rejects non-Ship sources before accepting durable Kernel ownership", async () => {
    const kernel = await getKernelPtr("inst_memory-review-non-ship");
    await runInDurableObject(kernel, async (instance) => {
      instance.procs.spawn("ordinary-worker", ROOT_IDENTITY, { ownerUid: ROOT_IDENTITY.uid });
      await instance.queueProcessMemoryReview("ordinary-worker", { ...source(20), afterMessageId: 0 });
      expect(instance.ctx.storage.kv.get("memory-reviews:0")).toBeUndefined();
    });
  });
});
