import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { Kernel } from "./do";

const SHIP: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const actor = { kind: "system", component: "test" } as const;

const slice = (afterMessageId = 0, throughMessageId = 50) => ({
  segmentId: crypto.randomUUID(), archivePath: "/home/sam/processes/ship/history/segment.jsonl.gz", generation: 0, afterMessageId, throughMessageId,
});

afterEach(() => vi.restoreAllMocks());

function ready(kernel: Kernel) {
  kernel.procs.spawn("ship-a", SHIP, { ownerUid: 1000, isPersonalController: true });
  kernel.procs.spawn("ship-b", { ...SHIP, uid: 1001, gid: 1001, gids: [1001] }, { ownerUid: 1001, isPersonalController: true });
  return vi.spyOn(kernel.responsibilityRuntime, "reconcileResponsibilityWake").mockResolvedValue();
}

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, work);
}

function reviews(kernel: Kernel, ownerUid: number) {
  return kernel.responsibilities.list({ ownerUid, includeTerminal: true }).records
    .filter((record) => record.dedupeKey?.startsWith("memory.review:"))
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.revision - b.revision);
}

function waiting(kernel: Kernel, ownerUid: number) {
  return kernel.ctx.storage.kv.get(`memory-reviews:${ownerUid}`) ?? [];
}

function settle(kernel: Kernel, ownerUid: number, id: string) {
  return kernel.responsibilities.update({ ownerUid, id, patch: { state: "resolved" }, actor, observedByShip: true, now: Date.now() });
}

describe("archived memory review", () => {
  it("admits one review at a time per owner, deduplicating a repeated slice", async () => {
    await fixture(async (kernel) => {
      const wake = ready(kernel);
      const first = slice();
      const second = slice(50, 100);
      await kernel.queueProcessMemoryReview("ship-a", first);
      await kernel.queueProcessMemoryReview("ship-a", first);
      await kernel.queueProcessMemoryReview("ship-a", second);
      await kernel.queueProcessMemoryReview("ship-b", first);
      const [review] = reviews(kernel, 1000);
      expect(reviews(kernel, 1000)).toHaveLength(1);
      expect(review).toMatchObject({
        state: "open", priority: "low", assignee: { kind: "ship" }, dedupeKey: `memory.review:ship-a:${first.segmentId}`,
        details: { ...first, sourceProcessId: "ship-a" },
      });
      expect(review!.details!.instructions).toContain("expectedHead");
      expect(waiting(kernel, 1000)).toEqual([{ ...second, sourceProcessId: "ship-a" }]);
      expect(reviews(kernel, 1001)).toHaveLength(1);
      expect(wake.mock.calls).toEqual([[1000], [1001]]);
      expect(kernel.ctx.storage.sql.exec("SELECT 1 FROM cf_agents_schedules WHERE callback = 'onMemoryReview'").toArray()).toEqual([]);
    });
  });

  it("admits the next waiting review in the transaction that settles the active one", async () => {
    await fixture(async (kernel) => {
      const wake = ready(kernel);
      const first = slice();
      const second = slice(50, 100);
      await kernel.queueProcessMemoryReview("ship-a", first);
      await kernel.queueProcessMemoryReview("ship-a", second);
      const [active] = reviews(kernel, 1000);

      // A settle that rolls back admits nothing.
      expect(() => kernel.ctx.storage.transactionSync(() => {
        settle(kernel, 1000, active!.id);
        throw new Error("Synthetic rollback");
      })).toThrow("Synthetic rollback");
      expect(reviews(kernel, 1000)).toMatchObject([{ id: active!.id, state: "open" }]);
      expect(waiting(kernel, 1000)).toHaveLength(1);

      wake.mockClear();
      settle(kernel, 1000, active!.id);
      expect(reviews(kernel, 1000)).toMatchObject([
        { id: active!.id, state: "resolved" },
        { state: "open", details: { segmentId: second.segmentId } },
      ]);
      expect(waiting(kernel, 1000)).toEqual([]);
      await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(1000));

      // Settling the last review leaves nothing to admit.
      wake.mockClear();
      settle(kernel, 1000, reviews(kernel, 1000)[1]!.id);
      expect(reviews(kernel, 1000)).toHaveLength(2);
      await Promise.resolve();
      expect(wake).not.toHaveBeenCalled();
    });
  });

  it("respects the owner's opt-out, dropping what waits", async () => {
    await fixture(async (kernel) => {
      const wake = ready(kernel);
      kernel.responsibilitySources.set(1000, "memory.review", false);
      await kernel.queueProcessMemoryReview("ship-a", slice());
      expect(reviews(kernel, 1000)).toEqual([]);
      expect(wake).not.toHaveBeenCalled();

      kernel.responsibilitySources.set(1000, "memory.review", true);
      await kernel.queueProcessMemoryReview("ship-a", slice());
      await kernel.queueProcessMemoryReview("ship-a", slice(50, 100));
      kernel.responsibilitySources.set(1000, "memory.review", false);
      settle(kernel, 1000, reviews(kernel, 1000)[0]!.id);
      expect(reviews(kernel, 1000)).toMatchObject([{ state: "resolved" }]);
      expect(waiting(kernel, 1000)).toEqual([]);
    });
  });

  it("settles a review whose successor can't be admitted, keeping the successor and saying why", async () => {
    await fixture(async (kernel) => {
      ready(kernel);
      const first = slice();
      const second = slice(50, 100);
      await kernel.queueProcessMemoryReview("ship-a", first);
      await kernel.queueProcessMemoryReview("ship-a", second);
      const create = kernel.responsibilities.create.bind(kernel.responsibilities);
      vi.spyOn(kernel.responsibilities, "create").mockImplementationOnce(() => {
        throw new Error("Synthetic admission failure");
      }).mockImplementation(create);
      const [active] = reviews(kernel, 1000);
      settle(kernel, 1000, active!.id);
      expect(reviews(kernel, 1000)).toMatchObject([{ id: active!.id, state: "resolved" }]);
      expect(waiting(kernel, 1000)).toEqual([{ ...second, sourceProcessId: "ship-a" }]);
      expect(kernel.ctx.storage.kv.get(`memory-review-failure:${second.segmentId}`)).toMatchObject({
        diagnosticId: expect.any(String), ownerUid: 1000, error: expect.stringContaining("Synthetic admission failure"),
      });
      // The next slice the Ship hands over admits the one that waited first.
      const third = slice(100, 150);
      await kernel.queueProcessMemoryReview("ship-a", third);
      expect(reviews(kernel, 1000)).toMatchObject([{ state: "resolved" }, { state: "open", details: { segmentId: second.segmentId } }]);
      expect(waiting(kernel, 1000)).toEqual([{ ...third, sourceProcessId: "ship-a" }]);
    });
  });

  // TODO(event-log): drop the already-admitted slice with the skip in admitWaitingReview.
  it("admits on start-up a review an older Kernel left waiting, skipping one it had already admitted", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    const admitted = slice();
    const next = slice(50, 100);
    await runInDurableObject(stub, async (kernel: Kernel) => {
      ready(kernel);
      await kernel.queueProcessMemoryReview("ship-a", admitted);
      settle(kernel, 1000, reviews(kernel, 1000)[0]!.id);
      // An older Kernel took a slice off its queue only after admitting it, and polled for the next.
      kernel.ctx.storage.kv.put("memory-reviews:1000", [{ ...admitted, sourceProcessId: "ship-a" }, { ...next, sourceProcessId: "ship-a" }]);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (kernel: Kernel) => {
      try {
        expect(reviews(kernel, 1000)).toMatchObject([{ state: "resolved" }, { state: "open", details: { segmentId: next.segmentId } }]);
        expect(waiting(kernel, 1000)).toEqual([]);
      } finally {
        // Test files share modules, so nothing this Kernel scheduled may run during a later test.
        kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
        await kernel.ctx.storage.deleteAlarm();
      }
    });
  });
});
