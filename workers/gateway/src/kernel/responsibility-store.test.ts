import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDurableObjectByName } from "../shared/durable-object";
import { Kernel } from "./do";
import {
  ResponsibilityStore,
  type ResponsibilityCreateInput,
} from "./responsibility-store";

const OWNER_UID = 1000;
const DAY_MS = 24 * 60 * 60_000;
const SHIP_ACTOR = {
  kind: "process" as const,
  processId: "proc:ship",
  runId: "run:ship",
};
const USER_ACTOR = {
  kind: "account" as const,
  uid: OWNER_UID,
  username: "hank",
};

function createInput(
  partial: Partial<ResponsibilityCreateInput> = {},
): ResponsibilityCreateInput {
  return {
    ownerUid: OWNER_UID,
    title: "Keep the Ship healthy",
    source: USER_ACTOR,
    assignee: { kind: "ship" },
    state: "open",
    priority: "normal",
    actor: USER_ACTOR,
    observedByShip: false,
    now: 1_000,
    ...partial,
  };
}

async function withStore<Result>(
  callback: (store: ResponsibilityStore) => Result | Promise<Result>,
  onChange?: (uid: number) => void,
): Promise<Result> {
  const kernel = await getDurableObjectByName<Env, Kernel>(
    env.KERNEL,
    `responsibility-store-${crypto.randomUUID()}`,
  );
  return await runInDurableObject(kernel, async (_instance: Kernel, state) => {
    return await callback(new ResponsibilityStore(state.storage, onChange));
  });
}

describe("ResponsibilityStore", () => {
  it("persists a waiting check, wakes for review, and rearms only after another waiting decision", async () => {
    await withStore((store) => {
      const created = store.create(createInput({ actor: SHIP_ACTOR, observedByShip: true })).record;
      const input = { ownerUid: OWNER_UID, id: created.id, actor: SHIP_ACTOR, observedByShip: true };
      const waiting = store.update({ ...input, patch: { state: "waiting", blocker: "Waiting for your answer" }, now: 2_000 });
      const checkAt = 2_000 + DAY_MS;
      expect(store.get(OWNER_UID, created.id)).toMatchObject({ state: "waiting", nextCheckAtMs: checkAt });
      expect(store.changes(OWNER_UID, created.revision).transitions[0]).toMatchObject({
        changedFields: expect.arrayContaining(["state", "blocker", "nextCheckAtMs"]),
        record: waiting.record,
      });
      store.update({ ...input, patch: { title: "Still awaiting your answer" }, now: 3_000 });
      const noOp = store.update({ ...input, patch: { state: "waiting" }, now: 4_000 });
      expect(noOp.changed).toBe(false);
      expect(store.nextWakeAt(OWNER_UID, 4_000)).toBe(checkAt);
      expect(store.createReadyBatch(OWNER_UID, checkAt - 1)).toBeNull();
      const batch = store.createReadyBatch(OWNER_UID, checkAt);
      expect(batch?.responsibilities.map(({ id }) => id)).toEqual([created.id]);
      expect(store.createReadyBatch(OWNER_UID, checkAt)).toEqual(batch);
      store.markBatchDelivered(batch!.id);
      expect(store.nextWakeAt(OWNER_UID, checkAt)).toBe(checkAt + 5 * 60_000);
      store.update({ ...input, patch: { state: "waiting" }, now: checkAt + 1 });
      expect(store.nextWakeAt(OWNER_UID, checkAt + 1)).toBe(checkAt + 1 + DAY_MS);
      store.update({ ...input, patch: { state: "resolved" }, now: checkAt + 2 });
      expect(store.nextWakeAt(OWNER_UID, checkAt + 2)).toBeNull();
    });
  });

  it("preserves explicit check times, including an intentional clear", async () => {
    await withStore((store) => {
      const created = store.create(createInput({ nextCheckAtMs: 3 * DAY_MS, observedByShip: true })).record;
      const input = { ownerUid: OWNER_UID, id: created.id, actor: SHIP_ACTOR, observedByShip: true };
      store.update({ ...input, patch: { state: "waiting", blocker: "Waiting for a decision" }, now: 2_000 });
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(3 * DAY_MS);
      const explicit = store.update({ ...input, patch: { state: "waiting", nextCheckAtMs: 5_000 }, now: 3_000 });
      expect(explicit.record.nextCheckAtMs).toBe(5_000);
      const past = store.update({ ...input, patch: { state: "waiting", nextCheckAtMs: 1_000 }, now: 4_000 });
      expect(past.record.nextCheckAtMs).toBe(1_000);
      const cleared = store.update({ ...input, patch: { state: "waiting", nextCheckAtMs: null }, now: 4_001 });
      expect(cleared.record.nextCheckAtMs).toBeUndefined();
      expect(store.nextWakeAt(OWNER_UID, 4_001)).toBeNull();
      store.update({ ...input, patch: { title: "Still waiting" }, now: 4_002 });
      expect(store.nextWakeAt(OWNER_UID, 4_002)).toBeNull();
    });
  });

  it("brings the default forward to a future deadline and preserves revision conflicts", async () => {
    await withStore((store) => {
      const created = store.create(createInput({ dueAtMs: 20_000, observedByShip: true })).record;
      const input = { ownerUid: OWNER_UID, id: created.id, actor: SHIP_ACTOR, observedByShip: true };
      expect(() => store.update({ ...input, expectedRevision: 0, patch: { state: "waiting" }, now: 2_000 })).toThrow("revision conflict");
      expect(store.get(OWNER_UID, created.id)?.nextCheckAtMs).toBeUndefined();
      const waiting = store.update({ ...input, expectedRevision: created.revision, patch: { state: "waiting" }, now: 2_000 });
      expect(waiting.record.nextCheckAtMs).toBe(20_000);
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(20_000);
    });
  });

  it("leaves system and delegated waits alone until a person returns the assignment to Ship", async () => {
    await withStore((store) => {
      const systemActor = { kind: "system" as const, component: "fixture" };
      const created = store.create(createInput({ state: "waiting", blocker: "External event", actor: systemActor, observedByShip: true })).record;
      const input = { ownerUid: OWNER_UID, id: created.id, observedByShip: true };
      store.update({ ...input, actor: systemActor, patch: { state: "waiting", blocker: "Another external event" }, now: 2_000 });
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBeNull();
      store.update({ ...input, actor: SHIP_ACTOR, patch: { assignee: { kind: "process", processId: "proc:worker" }, state: "waiting" }, now: 3_000 });
      expect(store.get(OWNER_UID, created.id)?.nextCheckAtMs).toBeUndefined();
      store.update({ ...input, actor: USER_ACTOR, patch: { assignee: { kind: "ship" } }, now: 4_000 });
      expect(store.get(OWNER_UID, created.id)?.nextCheckAtMs).toBe(4_000 + DAY_MS);
    });
  });

  it("announces committed owner changes but not no-ops, deduplication or revision conflicts", async () => {
    const changes: { uid: number; revision: number }[] = [];
    let observed: ResponsibilityStore;
    await withStore((store) => {
      observed = store;
      const first = store.create(createInput({ dedupeKey: "once" }));
      store.create(createInput({ dedupeKey: "once" }));
      const input = { ownerUid: OWNER_UID, id: first.record.id, actor: USER_ACTOR, observedByShip: false, now: 2000 };
      store.update({ ...input, patch: { state: "open" } });
      expect(() => store.update({ ...input, expectedRevision: 0, patch: { state: "active" } })).toThrow();
      store.update({ ...input, expectedRevision: first.record.revision, patch: { state: "waiting", blocker: "An answer" } });
    }, (uid) => changes.push({ uid, revision: observed.list({ ownerUid: uid }).revision }));
    expect(changes).toEqual([{ uid: OWNER_UID, revision: 1 }, { uid: OWNER_UID, revision: 2 }]);
  });
  it("records one deduplicated responsibility and an ordered transition", async () => {
    await withStore((store) => {
      const first = store.create(createInput({
        dedupeKey: "system:mailbox:recovery",
        details: { component: "mailbox" },
      }));
      const replay = store.create(createInput({
        title: "This replay must not replace the original",
        dedupeKey: "system:mailbox:recovery",
        now: 2_000,
      }));

      expect(first.created).toBe(true);
      expect(first.record.id).toMatch(/^r12y:/);
      expect(first.revision).toBe(1);
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: 1,
      });
      expect(store.list({ ownerUid: OWNER_UID })).toMatchObject({
        records: [first.record],
        count: 1,
        revision: 1,
      });
      expect(store.changes(OWNER_UID, 0)).toMatchObject({
        revision: 1,
        hasMore: false,
        transitions: [{
          revision: 1,
          responsibilityId: first.record.id,
          kind: "created",
          actor: USER_ACTOR,
          record: first.record,
        }],
      });
    });
  });

  it("applies optimistic transitions and keeps terminal records terminal", async () => {
    await withStore((store) => {
      const parent = store.create(createInput({ title: "Parent" })).record;
      const child = store.create(createInput({
        title: "Child",
        parentId: parent.id,
        actor: SHIP_ACTOR,
        source: SHIP_ACTOR,
        observedByShip: true,
        now: 2_000,
      })).record;
      const resolved = store.update({
        ownerUid: OWNER_UID,
        id: child.id,
        expectedRevision: child.revision,
        patch: { state: "resolved", resolution: { outcome: "done" } },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: 3_000,
      });

      expect(resolved.record).toMatchObject({
        state: "resolved",
        resolution: { outcome: "done" },
        resolvedAtMs: 3_000,
      });
      expect(() => store.update({
        ownerUid: OWNER_UID,
        id: child.id,
        patch: { state: "active" },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: 4_000,
      })).toThrow("Terminal responsibility cannot transition");
      expect(() => store.update({
        ownerUid: OWNER_UID,
        id: parent.id,
        patch: { parentId: child.id },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: 4_000,
      })).toThrow("create a cycle");
    });
  });

  it("batches due work idempotently and retains a later deadline wake", async () => {
    await withStore((store) => {
      const dueAtMs = 10_000;
      const responsibility = store.create(createInput({ dueAtMs })).record;
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(2_000);

      const first = store.createReadyBatch(OWNER_UID, 2_000);
      expect(first?.responsibilities.map((record) => record.id)).toEqual([
        responsibility.id,
      ]);
      expect(store.createReadyBatch(OWNER_UID, 2_000)).toEqual(first);
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(2_000);

      store.markBatchFailed(first!.id, "temporary failure", 2_500);
      expect(store.pendingBatch(OWNER_UID)?.attemptCount).toBe(1);
      store.markBatchDelivered(first!.id);
      expect(store.pendingBatch(OWNER_UID)).toBeNull();
      expect(store.nextWakeAt(OWNER_UID, 3_000)).toBe(dueAtMs);

      const deadline = store.createReadyBatch(OWNER_UID, dueAtMs);
      expect(deadline?.responsibilities[0]?.id).toBe(responsibility.id);
      store.markBatchDelivered(deadline!.id);
      expect(store.nextWakeAt(OWNER_UID, dueAtMs)).toBe(dueAtMs + 5 * 60_000);
      store.update({
        ownerUid: OWNER_UID,
        id: responsibility.id,
        patch: { state: "waiting", blocker: "Awaiting a reply" },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: dueAtMs + 1,
      });
      expect(store.nextWakeAt(OWNER_UID, dueAtMs + 1)).toBe(dueAtMs + 1 + DAY_MS);
    });
  });

  it("keeps Ship-owned work actionable until it is explicitly deferred", async () => {
    await withStore((store) => {
      const checkAtMs = 20_000;
      const created = store.create(createInput({
        actor: SHIP_ACTOR,
        source: SHIP_ACTOR,
        observedByShip: true,
        nextCheckAtMs: checkAtMs,
      })).record;
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(2_000);
      store.update({
        ownerUid: OWNER_UID,
        id: created.id,
        patch: { state: "waiting" },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: 2_100,
      });
      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(checkAtMs);
    });
  });

  it("wakes once when an assignment lease expires", async () => {
    await withStore((store) => {
      const leaseExpiresAtMs = 12_000;
      const responsibility = store.create(createInput({
        assignee: { kind: "process", processId: "proc:leased-worker" },
        state: "active",
        actor: SHIP_ACTOR,
        source: SHIP_ACTOR,
        observedByShip: true,
        leaseExpiresAtMs,
      })).record;

      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(leaseExpiresAtMs);
      expect(store.createReadyBatch(OWNER_UID, 2_000)).toBeNull();
      const expired = store.createReadyBatch(OWNER_UID, leaseExpiresAtMs);
      expect(expired?.responsibilities.map((record) => record.id)).toEqual([
        responsibility.id,
      ]);
      if (!expired) throw new Error("Expected expired lease batch");
      store.markBatchDelivered(expired.id);
      expect(store.nextWakeAt(OWNER_UID, leaseExpiresAtMs))
        .toBe(leaseExpiresAtMs + 5 * 60_000);
      store.update({
        ownerUid: OWNER_UID,
        id: responsibility.id,
        patch: {
          assignee: { kind: "ship" },
          state: "waiting",
          blocker: "Reviewing worker failure",
          leaseExpiresAtMs: null,
        },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: leaseExpiresAtMs + 1,
      });
      expect(store.nextWakeAt(OWNER_UID, leaseExpiresAtMs + 1)).toBe(leaseExpiresAtMs + 1 + DAY_MS);
    });
  });

  it("does not treat an unbounded process assignment as safely delegated", async () => {
    await withStore((store) => {
      const responsibility = store.create(createInput({
        assignee: { kind: "process", processId: "proc:unbounded-worker" },
        state: "active",
        actor: SHIP_ACTOR,
        source: SHIP_ACTOR,
        observedByShip: true,
      })).record;

      expect(store.nextWakeAt(OWNER_UID, 2_000)).toBe(2_000);
      expect(store.createReadyBatch(OWNER_UID, 2_000)?.responsibilities)
        .toEqual([expect.objectContaining({ id: responsibility.id })]);
    });
  });

  it("returns unresolved work to Ship when its assigned process is killed", async () => {
    await withStore((store) => {
      const processId = "proc:worker";
      const assigned = store.create(createInput({
        assignee: { kind: "process", processId },
        state: "active",
        leaseExpiresAtMs: 20_000,
      })).record;
      store.create(createInput({
        title: "Already complete",
        assignee: { kind: "process", processId },
        state: "resolved",
        now: 2_000,
      }));

      expect(store.reclaimProcessAssignments({
        ownerUid: OWNER_UID,
        processId,
        now: 3_000,
      })).toEqual([expect.objectContaining({
        id: assigned.id,
        assignee: { kind: "ship" },
        state: "open",
      })]);
      expect(store.get(OWNER_UID, assigned.id)).toEqual(expect.objectContaining({
        assignee: { kind: "ship" },
        state: "open",
      }));
      expect(store.get(OWNER_UID, assigned.id)?.leaseExpiresAtMs).toBeUndefined();
      expect(store.changes(OWNER_UID, 2).transitions).toEqual([
        expect.objectContaining({
          responsibilityId: assigned.id,
          changedFields: ["assignee", "state", "leaseExpiresAtMs"],
          actor: { kind: "system", component: "process.lifecycle" },
        }),
      ]);
      expect(store.nextWakeAt(OWNER_UID, 3_000)).toBe(3_000);
    });
  });

  it("shows a child only its assignments, ancestors, and reassignment-away delta", async () => {
    await withStore((store) => {
      const childPid = "proc:child";
      const otherPid = "proc:other";
      const parent = store.create(createInput({ title: "Parent" })).record;
      const assigned = store.create(createInput({
        title: "Assigned child",
        parentId: parent.id,
        assignee: { kind: "process", processId: childPid },
        now: 2_000,
      })).record;
      const hidden = store.create(createInput({
        title: "Other child",
        assignee: { kind: "process", processId: otherPid },
        now: 3_000,
      })).record;

      expect(store.listVisibleToProcess({
        ownerUid: OWNER_UID,
        processId: childPid,
      }).records.map((record) => record.id).sort()).toEqual([
        assigned.id,
        parent.id,
      ].sort());
      expect(store.isVisibleToProcess(OWNER_UID, parent.id, childPid)).toBe(true);
      expect(store.isVisibleToProcess(OWNER_UID, hidden.id, childPid)).toBe(false);

      store.update({
        ownerUid: OWNER_UID,
        id: assigned.id,
        patch: { assignee: { kind: "ship" } },
        actor: SHIP_ACTOR,
        observedByShip: true,
        now: 4_000,
      });
      expect(store.changes(OWNER_UID, 0, 100, childPid).transitions.map((change) => (
        change.responsibilityId
      ))).toEqual([assigned.id, assigned.id]);
    });
  });
});
