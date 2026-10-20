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
    auth: { isAccountDisabled: () => false },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    responsibilityRuntime: { reconcileResponsibilityWake: vi.fn(async () => {}) },
    buildKernelContext: () => ({}),
    schedule,
  };
  // SAFETY: ShipEventRuntime reaches only these Kernel members.
  const runtime = new ShipEventRuntime(host as Kernel);
  return { host, runtime, shipEvents, responsibilities, schedule };
}
