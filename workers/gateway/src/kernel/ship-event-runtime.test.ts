import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("drops a queued message once its responsibility or contact no longer admits Ship work", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, shipEvents, responsibilities } = fixture(storage);
      const work = responsibilities.create({ ownerUid: OWNER, title: "Pending messages from Remote", source: actor, actor,
        assignee: { kind: "ship" }, state: "open", priority: "normal", observedByShip: false, announced: true, now: Date.now() }).record;
      shipEvents.enqueue(OWNER, "contact.message:msg:cancelled", event("msg:cancelled", work.id), Date.now());
      shipEvents.enqueue(OWNER, "contact.message:msg:blocked", event("msg:blocked", "r12y:other"), Date.now());
      responsibilities.update({ ownerUid: OWNER, id: work.id, patch: { state: "cancelled" }, actor, observedByShip: false, now: Date.now() });
      host.federation.get = () => ({ state: "active", blocked: true });
      const ensure = vi.spyOn(personalController, "ensurePersonalController");
      await runtime.onShipEvents(OWNER, { id: "task:fenced" });
      expect(ensure).not.toHaveBeenCalled();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("drops a message whose responsibility is cancelled while the Ship controller starts", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, shipEvents, responsibilities } = fixture(storage);
      const work = responsibilities.create({ ownerUid: OWNER, title: "Pending messages from Remote", source: actor, actor,
        assignee: { kind: "ship" }, state: "open", priority: "normal", observedByShip: false, announced: true, now: Date.now() }).record;
      shipEvents.enqueue(OWNER, "contact.message:msg:takeover", event("msg:takeover", work.id), Date.now());
      vi.spyOn(personalController, "ensurePersonalController").mockImplementation(async () => {
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

  it("arms the recovery wake on a pass that finds the queue already drained", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime } = fixture(storage);
      await runtime.onShipEvents(OWNER, { id: "task:retry" });
      expect(host.responsibilityRuntime.reconcileResponsibilityWake).toHaveBeenCalledExactlyOnceWith(OWNER);
    });
  });
});

function event(messageId: string, responsibilityId: string): ShipEvent {
  return { type: "contact.message", contactId: "contact:remote", conversationId: "conv:remote", messageId,
    from: "Remote", text: messageId, responsibilityId, ledgerRevision: 1 };
}

function fixture(storage: DurableObjectStorage) {
  const shipEvents = new ShipEventStore(storage);
  const responsibilities = new ResponsibilityStore(storage);
  const schedule = vi.fn(async () => ({}));
  const host = {
    installationId: "installation:test",
    ctx: { storage, waitUntil: () => {} },
    shipEvents,
    responsibilities,
    federation: { get: (_contactId: string): { state: string; blocked: boolean } | null => ({ state: "active", blocked: false }) },
    auth: { isAccountDisabled: (_uid: number) => false },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    responsibilityRuntime: { reconcileResponsibilityWake: vi.fn(async (_uid: number) => {}) },
    buildKernelContext: () => ({}),
    schedule,
  };
  // SAFETY: ShipEventRuntime reaches only these Kernel members.
  const runtime = new ShipEventRuntime(host as Kernel);
  return { host, runtime, shipEvents, responsibilities, schedule };
}
