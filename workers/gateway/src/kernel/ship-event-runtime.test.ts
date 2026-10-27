import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableTaskOptions } from "../shared/durable-tasks";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import * as processTransport from "../shared/utils";
import * as personalController from "./personal-controller";
import type { Kernel } from "./do";
import { ResponsibilityStore } from "./responsibility-store";
import { ShipEventRuntime } from "./ship-event-runtime";
import { ShipEventStore, type ShipEvent } from "./ship-event-store";

const OWNER = 1000;
const actor = { kind: "system", component: "test" } as const;

afterEach(() => vi.restoreAllMocks());

describe("Ship event delivery", () => {
  it("delivers an owner's events in order and retries a failed one before later events", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, shipEvents, responsibilities, schedule } = fixture(storage);
      const work = responsibilities.create({ ownerUid: OWNER, title: "Pending messages from Remote", source: actor, actor,
        assignee: { kind: "ship" }, state: "open", priority: "normal", observedByShip: false, announced: true, now: Date.now() }).record;
      shipEvents.enqueue(OWNER, "contact.message:msg:one", event("msg:one", work.id), Date.now());
      shipEvents.enqueue(OWNER, "contact.message:msg:two", event("msg:two", work.id), Date.now());
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const delivered: string[] = [];
      const send = vi.spyOn(processTransport, "sendFrameToProcess")
        .mockImplementationOnce(async () => { throw new Error("Process is restarting"); })
        .mockImplementation(async (_installation, _pid, frame) => {
          if (frame.type === "req" && frame.call === "proc.runtime.event.deliver") delivered.push(frame.args.eventId);
          return { type: "res", id: "response", ok: true, data: {} };
        });

      await runtime.onShipEvents(OWNER, { id: "task:first" });
      expect(send).toHaveBeenCalledOnce();
      expect(shipEvents.next(OWNER)).toMatchObject({ eventId: "contact.message:msg:one", attemptCount: 1 });
      expect(schedule).toHaveBeenLastCalledWith(expect.any(Date), "onShipEvents", OWNER, { idempotent: true, excludeTaskId: "task:first" });

      await runtime.onShipEvents(OWNER, { id: "task:early" });
      expect(delivered).toEqual([]);

      storage.sql.exec("UPDATE ship_events SET next_attempt_at = 0");
      await runtime.onShipEvents(OWNER, { id: "task:retry" });
      expect(delivered).toEqual(["contact.message:msg:one", "contact.message:msg:two"]);
      expect(shipEvents.next(OWNER)).toBeNull();
      expect(host.responsibilityRuntime.reconcileResponsibilityWake).toHaveBeenCalledWith(OWNER);
      expect(responsibilities.createReadyBatch(OWNER, Date.now())).toBeNull();
      expect(responsibilities.nextWakeAt(OWNER, Date.now())).toBeGreaterThan(Date.now());
    });
  });

  it("delivers an owner notice that both Ship and its owner can see in the conversation", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, shipEvents } = fixture(storage);
      const payload = {
        noticeId: "contact.message:contact:remote:1:0", topic: "contact.message", channel: "WhatsApp", from: "Remote",
        preview: "hello", contactId: "contact:remote", conversationId: "conv:remote", messages: 1, sentAtMs: 1,
      } as const;
      const link = { kind: "contact", contactId: "contact:remote" } as const;
      shipEvents.enqueue(OWNER, "owner.notified:contact.message:contact:remote:1:0", { type: "owner.notified", payload, link }, Date.now());
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const send = vi.spyOn(processTransport, "sendFrameToProcess")
        .mockResolvedValue({ type: "res", id: "response", ok: true, data: {} });

      await runtime.onShipEvents(OWNER, { id: "task:notice" });
      expect(send).toHaveBeenCalledWith("installation:test", "proc:ship", expect.objectContaining({
        call: "proc.event.deliver",
        args: { eventId: "owner.notified:contact.message:contact:remote:1:0",
          event: { kind: "owner.notified", payload, severity: "info", audience: "both", link } },
      }));
    });
  });

  it("revokes a queued message once Ship no longer handles its contact", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { contact, runtime, shipEvents, responsibilities } = fixture(storage);
      const work = pending(responsibilities);
      shipEvents.enqueue(OWNER, "contact.message:msg:takeover", event("msg:takeover", work.id), Date.now());
      responsibilities.update({ ownerUid: OWNER, id: work.id, patch: { state: "cancelled" }, actor, observedByShip: false, now: Date.now() });
      contact.preferences.shipHandlesMessages = false;
      const ensure = vi.spyOn(personalController, "ensurePersonalController");
      await runtime.onShipEvents(OWNER, { id: "task:takeover" });
      expect(shipEvents.next(OWNER)).toBeNull();

      const open = pending(responsibilities);
      shipEvents.enqueue(OWNER, "contact.message:msg:blocked", event("msg:blocked", open.id), Date.now());
      contact.blocked = true;
      await runtime.onShipEvents(OWNER, { id: "task:blocked" });
      expect(ensure).not.toHaveBeenCalled();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("moves a message whose shared work Ship already resolved to fresh standing work", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, shipEvents, responsibilities } = fixture(storage);
      const work = pending(responsibilities);
      shipEvents.enqueue(OWNER, "contact.message:msg:later", event("msg:later", work.id), Date.now());
      responsibilities.update({ ownerUid: OWNER, id: work.id, patch: { state: "resolved" }, actor, observedByShip: true, now: Date.now() });
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const delivered: string[] = [];
      vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => {
        if (frame.type === "req" && frame.call === "proc.runtime.event.deliver") delivered.push(frame.args.event.responsibilityId);
        return { type: "res", id: "response", ok: true, data: {} };
      });
      await runtime.onShipEvents(OWNER, { id: "task:later" });
      const reopened = responsibilities.list({ ownerUid: OWNER }).records.filter((record) => record.state === "open");
      expect(reopened).toHaveLength(1);
      expect(reopened[0]!.id).not.toBe(work.id);
      expect(delivered).toEqual([reopened[0]!.id]);
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("revokes a message when the owner takes over while the Ship controller starts", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { contact, runtime, shipEvents, responsibilities } = fixture(storage);
      const work = pending(responsibilities);
      shipEvents.enqueue(OWNER, "contact.message:msg:takeover", event("msg:takeover", work.id), Date.now());
      vi.spyOn(personalController, "ensurePersonalController").mockImplementation(async () => {
        contact.preferences.shipHandlesMessages = false;
        responsibilities.update({ ownerUid: OWNER, id: work.id, patch: { state: "cancelled" }, actor, observedByShip: false, now: Date.now() });
        return "proc:ship";
      });
      const send = vi.spyOn(processTransport, "sendFrameToProcess");
      await runtime.onShipEvents(OWNER, { id: "task:takeover" });
      expect(send).not.toHaveBeenCalled();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("stops delivery when the account is removed while the managed-work gate is pending", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, shipEvents } = fixture(storage);
      shipEvents.enqueue(OWNER, "contact.message:msg:one", event("msg:one", "r12y:one"), Date.now());
      let disabled = false;
      host.auth.isAccountDisabled = () => disabled;
      host.onboarding.managedWorkGate = async () => { disabled = true; return { allowed: true }; };
      const ensure = vi.spyOn(personalController, "ensurePersonalController");
      await runtime.onShipEvents(OWNER, { id: "task:removed" });
      expect(ensure).not.toHaveBeenCalled();
      expect(shipEvents.next(OWNER)).toMatchObject({ eventId: "contact.message:msg:one", attemptCount: 0 });
    });
  });

  it("keeps a successor task for an event queued while reconciliation is pending", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, shipEvents, schedule } = fixture(storage);
      host.responsibilityRuntime.reconcileResponsibilityWake.mockImplementationOnce(async () => {
        shipEvents.enqueue(OWNER, "contact.message:msg:late", event("msg:late", "r12y:late"), Date.now());
      });
      await runtime.onShipEvents(OWNER, { id: "task:running" });
      expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Date), "onShipEvents", OWNER, { idempotent: true, excludeTaskId: "task:running" });
    });
  });

  it("moves a stale backoff task earlier when the queue head becomes due now", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, shipEvents, schedule } = fixture(storage);
      const stale = Date.now() + 5 * 60_000;
      schedule.mockResolvedValueOnce({ id: "task:backoff", time: Math.floor(stale / 1_000) });
      shipEvents.enqueue(OWNER, "contact.message:msg:fresh", event("msg:fresh", "r12y:fresh"), Date.now());
      await runtime.queue(OWNER);
      expect(host.cancelSchedule).toHaveBeenCalledExactlyOnceWith("task:backoff");
      expect(schedule).toHaveBeenCalledTimes(2);
      expect(schedule.mock.calls[1]![0].getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  it("arms the recovery wake on a pass that finds the queue already drained", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime } = fixture(storage);
      await runtime.onShipEvents(OWNER, { id: "task:retry" });
      expect(host.responsibilityRuntime.reconcileResponsibilityWake).toHaveBeenCalledExactlyOnceWith(OWNER);
    });
  });
});

function event(messageId: string, responsibilityId: string): ShipEvent {
  return { type: "contact.message", contactId: "contact:remote", contactGeneration: "1", conversationId: "conv:remote", messageId,
    from: "Remote", text: messageId, responsibilityId, ledgerRevision: 1 };
}

function pending(responsibilities: ResponsibilityStore) {
  return responsibilities.create({ ownerUid: OWNER, title: "Pending messages from Remote", source: actor, actor,
    assignee: { kind: "ship" }, state: "open", priority: "normal",
    dedupeKey: `contact.handoff:contact:remote:1:${crypto.randomUUID()}`,
    observedByShip: false, announced: true, now: Date.now() }).record;
}

function fixture(storage: DurableObjectStorage) {
  const shipEvents = new ShipEventStore(storage);
  const responsibilities = new ResponsibilityStore(storage);
  const schedule = vi.fn(async (when: Date, _callback: string, _ownerUid: number, _options: DurableTaskOptions) =>
    ({ id: `task:${when.getTime()}`, time: Math.floor(when.getTime() / 1_000) }));
  const contact = {
    id: "contact:remote", ownerUid: OWNER, generation: "1", conversationId: "conv:remote", state: "active", blocked: false,
    remoteName: "Remote", preferences: { shipHandlesMessages: true },
  };
  const federation = {
    get: (_contactId: string) => contact,
    transaction: <Value>(callback: () => Value): Value => storage.transactionSync(callback),
  };
  const host = {
    installationId: "installation:test",
    ctx: { storage, waitUntil: () => {} },
    shipEvents,
    responsibilities,
    federation,
    auth: { isAccountDisabled: (_uid: number) => false },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    responsibilityRuntime: { reconcileResponsibilityWake: vi.fn(async (_uid: number) => {}) },
    buildKernelContext: () => ({ federation, responsibilities, shipEvents }),
    schedule,
    cancelSchedule: vi.fn(async (_id: string) => true),
  };
  // SAFETY: ShipEventRuntime reaches only these Kernel members.
  const runtime = new ShipEventRuntime(host as Kernel);
  return { host, contact, runtime, shipEvents, responsibilities, schedule };
}
