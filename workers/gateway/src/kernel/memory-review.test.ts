import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { ResponsibilityStore } from "./responsibility-store";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import { admitMemoryReview } from "./memory-review";

const slice = () => ({ ownerUid: 1000, sourceProcessId: "ship-a", segmentId: crypto.randomUUID(), archivePath: "/home/ship/processes/ship/history/segment.jsonl.gz", generation: 0, afterMessageId: 0, throughMessageId: 50 });

function context(sql: SqlStorage, storage: DurableObjectStorage) {
  return {
    auth: new AuthStore(sql), responsibilities: new ResponsibilityStore(storage),
    responsibilitySources: new ResponsibilitySourcePolicyStore(sql),
    reconcileResponsibilityWake: vi.fn(async () => {}),
  };
}

describe("archived memory review", () => {
  it("deduplicates delivery and serializes reviews within each owner", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context(sql, storage);
      const first = slice();
      const second = { ...slice(), afterMessageId: 50, throughMessageId: 100 };
      expect(await admitMemoryReview(first, ctx)).toBe(true);
      expect(await admitMemoryReview(first, ctx)).toBe(true);
      expect(await admitMemoryReview(second, ctx)).toBe(false);
      expect(await admitMemoryReview({ ...first, ownerUid: 1001, sourceProcessId: "ship-b" }, ctx)).toBe(true);
      const [review] = ctx.responsibilities.list({ ownerUid: 1000 }).records;
      expect(review).toMatchObject({ state: "open", priority: "low", assignee: { kind: "ship" }, details: { segmentId: first.segmentId } });
      expect(review!.details!.instructions).toContain("expectedHead");
      ctx.responsibilities.update({ ownerUid: 1000, id: review!.id, patch: { state: "resolved" }, actor: { kind: "system", component: "test" }, observedByShip: true, now: Date.now() });
      expect(await admitMemoryReview(second, ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000, includeTerminal: true }).count).toBe(2);
      expect(ctx.responsibilities.list({ ownerUid: 1001 }).count).toBe(1);
    });
  });

  it("respects the owner's opt-out", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context(sql, storage);
      ctx.responsibilitySources.set(1000, "memory.review", false);
      expect(await admitMemoryReview(slice(), ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000 }).count).toBe(0);
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
    });
  });

  it("retries wake scheduling without creating another responsibility", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context(sql, storage);
      const review = slice();
      ctx.reconcileResponsibilityWake.mockRejectedValueOnce(new Error("Synthetic scheduling interruption"));
      await expect(admitMemoryReview(review, ctx)).rejects.toThrow("Synthetic scheduling interruption");
      expect(await admitMemoryReview(review, ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000 }).count).toBe(1);
      expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledTimes(2);
    });
  });
});
