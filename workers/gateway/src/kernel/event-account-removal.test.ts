import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import * as processTransport from "../shared/utils";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import * as personalController from "./personal-controller";
import { handleSignalWatch } from "./signals";
import { deliverTargetConnectionEvent } from "./target-events";

async function fixture(work: (kernel: Kernel, root: KernelContext) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    const password = await hashPassword("event-fixture-password");
    kernel.auth.setShadow(makeShadowEntry("root", password));
    for (const [uid, username] of [[1000, "removed"], [1001, "survivor"], [2000, "agent"]] as const) {
      kernel.auth.addUser({ username, uid, gid: uid, gecos: username, home: `/home/${username}`, shell: "/bin/init" });
      kernel.auth.addGroup({ name: username, gid: uid, members: [] });
      if (uid < 2000) kernel.auth.setShadow(makeShadowEntry(username, password));
      kernel.caps.grant(uid, "signal.watch");
    }
    const root = kernel.buildKernelContext({
      peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"] }),
    });
    await work(kernel, root);
  });
}

function readyResponsibility(kernel: Kernel, ownerUid: number) {
  return kernel.responsibilities.create({
    ownerUid, title: "Due responsibility", source: { kind: "account", uid: ownerUid, username: "fixture" },
    assignee: { kind: "ship" }, state: "open", priority: "normal", actor: { kind: "system", component: "test" },
    observedByShip: false, now: Date.now(),
  }).record;
}

function eventTransport() {
  return vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => {
    if (frame.type !== "req" || (frame.call !== "proc.runtime.event.deliver" && frame.call !== "proc.event.deliver")) {
      throw new Error("Unexpected event fixture frame");
    }
    return { type: "res", id: frame.id, ok: true, data: { eventId: frame.args.eventId, runId: frame.args.eventId, queued: false } };
  });
}

const targetEvent = { targetId: "machine:shared", event: "connected", platform: "linux", observedAt: Date.now() } as const;

function targetWatch(kernel: Kernel, ownerUid: number, runAsUid: number, audience: "person" | "both") {
  const account = kernel.auth.getPasswdByUid(runAsUid)!;
  const pid = `proc:${crypto.randomUUID()}`;
  kernel.procs.spawn(pid, { ...account, gids: [account.gid], cwd: account.home }, { ownerUid });
  if (!kernel.targets.get(targetEvent.targetId)) {
    kernel.targets.register(targetEvent.targetId, 1001, 1001, ["fs.read"], "linux", "test");
  }
  kernel.targets.grantAccess(targetEvent.targetId, account.gid);
  const ctx = kernel.buildProcessContext(pid)!;
  return handleSignalWatch({ signal: "target.status", targetId: targetEvent.targetId, audience, once: false }, ctx);
}

describe("new Kernel event admission after account removal", () => {
  it.each(["before wake", "during allowed gate", "during restricted gate"] as const)("does not prepare a new responsibility batch after removal %s", async (timing) => {
    const send = eventTransport();
    const ensureShip = vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
    try {
      await fixture(async (kernel, root) => {
        const record = readyResponsibility(kernel, 1000);
        const control = readyResponsibility(kernel, 1001);
        await kernel.responsibilityRuntime.reconcileResponsibilityWake(1000);
        const state = kernel.responsibilities.wakeState(1000);
        if (timing === "before wake") {
          await kernel.people.remove(1000, root);
          await kernel.responsibilityRuntime.onResponsibilityWake(state, { id: state.taskId! });
        } else {
          const gate = Promise.withResolvers<Awaited<ReturnType<typeof kernel.onboarding.managedWorkGate>>>();
          const admission = vi.spyOn(kernel.onboarding, "managedWorkGate").mockImplementationOnce(() => gate.promise);
          const pending = kernel.responsibilityRuntime.onResponsibilityWake(state, { id: state.taskId! });
          expect(admission).toHaveBeenCalledTimes(1);
          await kernel.people.remove(1000, root);
          gate.resolve(timing === "during restricted gate"
            ? { allowed: false, code: 423, message: "Installation is restricted" }
            : { allowed: true });
          await pending;
          admission.mockRestore();
        }
        expect(send).not.toHaveBeenCalled();
        expect(ensureShip).not.toHaveBeenCalled();
        expect(kernel.responsibilities.pendingBatch(1000)).toBeNull();
        expect(kernel.responsibilities.get(1000, record.id)).toEqual(record);
        expect(kernel.responsibilities.wakeState(1000)).toMatchObject({ taskId: null, scheduledAtMs: null });
        await kernel.responsibilityRuntime.recoverResponsibilityWakes();
        expect(kernel.responsibilities.wakeState(1000)).toMatchObject({ taskId: null, scheduledAtMs: null });
        await kernel.responsibilityRuntime.onResponsibilityWake(kernel.responsibilities.wakeState(1001));
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[2]).toMatchObject({ args: { event: { responsibilityIds: [control.id] } } });
      });
    } finally { send.mockRestore(); ensureShip.mockRestore(); }
  });

  it("retries the exact already-prepared batch after removal without admitting another batch", async () => {
    const send = eventTransport();
    const ensureShip = vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
    send.mockRejectedValueOnce(new Error("Saved event response was lost"));
    try {
      await fixture(async (kernel, root) => {
        const first = readyResponsibility(kernel, 1000);
        await kernel.responsibilityRuntime.onResponsibilityWake(kernel.responsibilities.wakeState(1000));
        const batch = kernel.responsibilities.pendingBatch(1000)!;
        expect(batch).toMatchObject({ attemptCount: 1, responsibilities: [{ id: first.id }] });
        const later = readyResponsibility(kernel, 1000);
        await kernel.people.remove(1000, root);
        await kernel.responsibilityRuntime.onResponsibilityWake(kernel.responsibilities.wakeState(1000));
        expect(send).toHaveBeenCalledTimes(2);
        for (const call of send.mock.calls) {
          expect(call[2]).toMatchObject({ args: { eventId: batch.eventId, event: { responsibilityIds: [first.id] } } });
        }
        expect(kernel.responsibilities.pendingBatch(1000)).toBeNull();
        expect(kernel.responsibilities.get(1000, later.id)).toEqual(later);
        expect(kernel.responsibilities.wakeState(1000)).toMatchObject({ taskId: null, scheduledAtMs: null });
        await kernel.responsibilityRuntime.onResponsibilityWake(kernel.responsibilities.wakeState(1000));
        expect(send).toHaveBeenCalledTimes(2);
      });
    } finally { send.mockRestore(); ensureShip.mockRestore(); }
  });

  it.each(["person", "both"] as const)("fences a fresh %s watch event after owner removal during admission", async (audience) => {
    const send = eventTransport();
    try {
      await fixture(async (kernel, root) => {
        const removed = targetWatch(kernel, 1000, 2000, audience);
        const control = targetWatch(kernel, 1001, 1001, audience);
        const gate = Promise.withResolvers<Awaited<ReturnType<typeof kernel.onboarding.managedWorkGate>>>();
        const admission = vi.spyOn(kernel.onboarding, "managedWorkGate").mockImplementationOnce(() => gate.promise);
        const pending = deliverTargetConnectionEvent(kernel, targetEvent, "transition:removal", kernel.signalWatches.matchTarget(targetEvent.targetId, "target.status"));
        expect(admission).toHaveBeenCalledTimes(1);
        await kernel.people.remove(1000, root);
        gate.resolve({ allowed: true });
        await pending;
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[2]).toMatchObject({ args: { eventId: `transition:removal:${control.watchId}` } });
        expect(kernel.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM signal_watches WHERE watch_id = ?", removed.watchId).one().status).toBe("failed");
        admission.mockRestore();
      });
    } finally { send.mockRestore(); }
  });

  it("fences a watch whose run-as account was removed while its owner remains active", async () => {
    const send = eventTransport();
    try {
      await fixture(async (kernel, root) => {
        targetWatch(kernel, 1001, 1000, "both");
        await kernel.people.remove(1000, root);
        await deliverTargetConnectionEvent(kernel, targetEvent, "transition:run-as", kernel.signalWatches.matchTarget(targetEvent.targetId, "target.status"));
        expect(send).not.toHaveBeenCalled();
        expect(kernel.auth.isAccountDisabled(1001)).toBe(false);
      });
    } finally { send.mockRestore(); }
  });

  it("keeps an admitted watch delivery's late acknowledgment after removal", async () => {
    const send = eventTransport();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    send.mockImplementationOnce(async (_installation, _pid, frame) => {
      if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected event fixture frame");
      entered.resolve();
      await release.promise;
      return { type: "res", id: frame.id, ok: true, data: { eventId: frame.args.eventId, runId: frame.args.eventId, queued: false } };
    });
    try {
      await fixture(async (kernel, root) => {
        const watch = targetWatch(kernel, 1000, 2000, "both");
        const pending = deliverTargetConnectionEvent(kernel, targetEvent, "transition:admitted", kernel.signalWatches.matchTarget(targetEvent.targetId, "target.status"));
        await entered.promise;
        await kernel.people.remove(1000, root);
        release.resolve();
        await pending;
        expect(send).toHaveBeenCalledTimes(1);
        expect(kernel.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM signal_watches WHERE watch_id = ?", watch.watchId).one().status).toBe("active");
        await deliverTargetConnectionEvent(kernel, targetEvent, "transition:later", kernel.signalWatches.matchTarget(targetEvent.targetId, "target.status"));
        expect(send).toHaveBeenCalledTimes(1);
      });
    } finally { release.resolve(); send.mockRestore(); }
  });
});
