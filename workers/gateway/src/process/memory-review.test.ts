import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getKernelPtr } from "../shared/utils";
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
      vi.spyOn(process.kernel, "admitMemoryReview").mockImplementation(async (review) => {
        delivered.push(review);
        return true;
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
      vi.spyOn(process.kernel, "admitMemoryReview")
        .mockRejectedValueOnce(new Error("Synthetic private cause"))
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      enqueueMemoryReview(process, source(20));
      await deliverMemoryReview(process, "first-attempt");
      const pending = JSON.parse(process.store.state.getValue("pendingMemoryReviews")!);
      expect(pending).toHaveLength(1);
      const trace = process.trace.list({});
      expect(trace).toMatchObject({ spans: [expect.objectContaining({ status: "error", attributes: { error: "Synthetic private cause" } })] });
      await deliverMemoryReview(process, "second-attempt");
      expect(JSON.parse(process.store.state.getValue("pendingMemoryReviews")!)).toEqual(pending);
      await deliverMemoryReview(process, "third-attempt");
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
    await runInDurableObject(kernel, (instance) => {
      const record = instance.responsibilities.getByDedupeKey(ROOT_IDENTITY.uid, `memory.review:${pid}:${review.segmentId}`);
      expect(record).toMatchObject({ ownerUid: ROOT_IDENTITY.uid, details: { sourceProcessId: pid, ...review, afterMessageId: 0 } });
      vi.restoreAllMocks();
    });
  });
});
