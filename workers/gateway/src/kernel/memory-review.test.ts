import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { ProcessRegistry } from "./processes";
import { ResponsibilityStore } from "./responsibility-store";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import { admitMemoryReview } from "./memory-review";

const identity = { uid: 2000, gid: 1000, gids: [1000], username: "ship", home: "/home/ship", cwd: "/home/ship" };
const slice = () => ({ segmentId: crypto.randomUUID(), archivePath: "/home/ship/processes/ship/history/segment.jsonl.gz", generation: 0, afterMessageId: 0, throughMessageId: 50 });

function context(sql: SqlStorage, storage: DurableObjectStorage) {
  const procs = new ProcessRegistry(sql);
  procs.spawn("ship-a", identity, { ownerUid: 1000, isPersonalController: true });
  procs.spawn("ship-b", identity, { ownerUid: 1001, isPersonalController: true });
  procs.spawn("worker", identity, { ownerUid: 1000 });
  return {
    procs, auth: new AuthStore(sql), responsibilities: new ResponsibilityStore(storage),
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
      expect(await admitMemoryReview("ship-a", first, ctx)).toBe(true);
      expect(await admitMemoryReview("ship-a", first, ctx)).toBe(true);
      expect(await admitMemoryReview("ship-a", second, ctx)).toBe(false);
      expect(await admitMemoryReview("ship-b", first, ctx)).toBe(true);
      const [review] = ctx.responsibilities.list({ ownerUid: 1000 }).records;
      expect(review).toMatchObject({ state: "open", priority: "low", assignee: { kind: "ship" }, details: first });
      expect(review!.details!.instructions).toContain("expectedHead");
      ctx.responsibilities.update({ ownerUid: 1000, id: review!.id, patch: { state: "resolved" }, actor: { kind: "system", component: "test" }, observedByShip: true, now: Date.now() });
      expect(await admitMemoryReview("ship-a", second, ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000, includeTerminal: true }).count).toBe(2);
      expect(ctx.responsibilities.list({ ownerUid: 1001 }).count).toBe(1);
    });
  });

  it("ignores workers and respects the owner's opt-out", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context(sql, storage);
      expect(await admitMemoryReview("worker", slice(), ctx)).toBe(true);
      ctx.responsibilitySources.set(1000, "memory.review", false);
      expect(await admitMemoryReview("ship-a", slice(), ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000 }).count).toBe(0);
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
    });
  });

  it("retries wake scheduling without creating another responsibility", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context(sql, storage);
      const review = slice();
      ctx.reconcileResponsibilityWake.mockRejectedValueOnce(new Error("Synthetic scheduling interruption"));
      await expect(admitMemoryReview("ship-a", review, ctx)).rejects.toThrow("Synthetic scheduling interruption");
      expect(await admitMemoryReview("ship-a", review, ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: 1000 }).count).toBe(1);
      expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledTimes(2);
    });
  });
});
