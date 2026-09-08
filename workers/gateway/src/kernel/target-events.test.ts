import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { Kernel } from "./do";
import { getDurableObjectByName } from "../shared/durable-object";
import * as utils from "../shared/utils";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import { SignalWatchStore } from "./signal-watches";
import { deliverTargetConnectionEvent } from "./target-events";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./schema/migrations";
import { runSqlMigrations } from "../schema/runner";

const identity: ProcessIdentity = {
  uid: 7100, gid: 7100, gids: [7100], username: "target-observer", home: "/home/target-observer", cwd: "/home/target-observer",
};

function setup(kernel: Kernel) {
  kernel.procs.spawn("proc:observer", identity, { ownerUid: 7000 });
  kernel.procs.spawn("proc:child", identity, { ownerUid: 7000 });
  kernel.procs.spawn("proc:foreign", identity, { ownerUid: 8000 });
  kernel.caps.grant(identity.gid, "signal.watch");
  expect(kernel.targets.register("machine:visible", 8000, 8000, ["fs.read"], "linux", "fixture-version", { label: "Fixture machine" }).ok).toBe(true);
  expect(kernel.targets.register("machine:private", 8000, 8000, ["fs.read"], "linux", "fixture-version").ok).toBe(true);
  kernel.targets.grantAccess("machine:visible", identity.gid);
  const ctx = kernel.buildProcessContext("proc:observer");
  if (!ctx) throw new Error("Missing fixture Process context");
  return ctx;
}

function acknowledgeEvents() {
  return vi.spyOn(utils, "sendFrameToProcess").mockImplementation(async (_installationId, _pid, frame) => {
    if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected fixture delivery");
    return { type: "res", id: frame.id, ok: true, data: { eventId: frame.args.eventId, runId: null, queued: false, messageId: 1 } };
  });
}

const event = { targetId: "machine:visible", event: "connected", platform: "linux", observedAt: 100 } as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("registered target event watches", () => {
  it("upgrades v39 process watches without changing their source or delivery behavior", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(stub, async (_kernel: Kernel, state) => {
      await state.storage.deleteAll();
      runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter(({ id }) => id <= 39));
      state.storage.sql.exec(
        `INSERT INTO signal_watches (watch_id, uid, target_type, target_process_id, signal, process_id, dedupe_key,
          state_json, once_only, status, error, created_at, updated_at, expires_at)
         VALUES ('old-watch', 7000, 'process', 'proc:observer', 'proc.run.finished', 'proc:child', 'old-key',
          '{"old":true}', 0, 'active', NULL, 1, 1, NULL)`,
      );
      const before = state.storage.sql.exec("SELECT * FROM signal_watches").toArray();
      runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
      expect(state.storage.sql.exec("SELECT * FROM signal_watches").toArray())
        .toEqual(before.map((row) => ({ ...row, source_target_id: null, event_audience: null, revision: 1 })));
      const store = new SignalWatchStore(state.storage.sql);
      expect(store.match(7000, "proc.run.finished", "proc:child")).toMatchObject([
        { watchId: "old-watch", processId: "proc:child", sourceTargetId: null, audience: null, state: { old: true } },
      ]);
      expect(store.matchTarget("machine:visible", "proc.run.finished")).toEqual([]);
    });
  });

  it("authorizes an exact visible target while preserving process watch ownership restrictions", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(stub, (kernel: Kernel) => {
      const ctx = setup(kernel);
      for (const args of [
        { signal: "target.status", targetId: "machine:private" },
        { signal: "target.status", targetId: "missing" },
        { signal: "target.status", targetId: "machine:visible", processId: "proc:child" },
        { signal: "custom.machine", targetId: "machine:visible" },
        { signal: "proc.run.finished", processId: "proc:foreign" },
        { signal: "proc.run.finished", processId: "proc:observer" },
        { signal: "proc.run.finished", processId: "proc:child", audience: "person" as const },
      ]) expect(() => handleSignalWatch(args, ctx)).toThrow();
      const watched = handleSignalWatch({ signal: "target.status", targetId: "machine:visible", key: "target:status", once: false }, ctx);
      expect(kernel.signalWatches.matchTarget("machine:visible", "target.status")).toMatchObject([
        { watchId: watched.watchId, uid: 7000, targetProcessId: "proc:observer", processId: null, sourceTargetId: "machine:visible", audience: "person" },
      ]);
      expect(kernel.signalWatches.match(7000, "target.status", "proc:child")).toEqual([]);
      handleSignalWatch({ signal: "target.status", targetId: "machine:visible", key: "target:status", audience: "both" }, ctx);
      expect(kernel.signalWatches.matchTarget("machine:visible", "target.status")).toMatchObject([{ watchId: watched.watchId, audience: "both" }]);
      expect(handleSignalUnwatch({ key: "target:status" }, ctx)).toEqual({ removed: 1 });
    });
  });

  it("retains target watches across eviction and requires a matching delivery acknowledgment", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(stub, (kernel: Kernel) => {
      const ctx = setup(kernel);
      handleSignalWatch({ signal: "target.status", targetId: "machine:visible" }, ctx);
      kernel.targets.setOnline("machine:visible", false);
    });
    await evictDurableObject(stub);
    const send = acknowledgeEvents();
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        await deliverTargetConnectionEvent(kernel, event, "transition:one", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        expect(send).toHaveBeenCalledWith(kernel.installationId, "proc:observer", expect.objectContaining({
          call: "proc.event.deliver", args: {
            eventId: expect.stringMatching(/^transition:one:/),
            event: { kind: "target.connection", payload: event, audience: "person", severity: "info" },
          },
        }));
        expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toEqual([]);
        const ctx = kernel.buildProcessContext("proc:observer")!;
        const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId }, ctx);
        send.mockResolvedValueOnce({ type: "res", id: "mismatch", ok: true, data: { eventId: "different", runId: null, queued: false } });
        await deliverTargetConnectionEvent(kernel, event, "transition:two", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        expect(kernel.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM signal_watches WHERE watch_id = ?", watch.watchId).toArray())
          .toEqual([{ status: "failed" }]);
      });
    } finally { send.mockRestore(); }
  });

  it("rechecks target access and the watching process capability before every delivery", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const send = acknowledgeEvents();
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        handleSignalWatch({ signal: "target.status", targetId: event.targetId }, ctx);
        kernel.targets.revokeAccess(event.targetId, identity.gid);
        await deliverTargetConnectionEvent(kernel, event, "transition:revoked-access", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        expect(send).not.toHaveBeenCalled();
        kernel.targets.grantAccess(event.targetId, identity.gid);
        handleSignalWatch({ signal: "target.status", targetId: event.targetId }, ctx);
        kernel.caps.revoke(identity.gid, "signal.watch");
        await deliverTargetConnectionEvent(kernel, event, "transition:revoked-capability", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        expect(send).not.toHaveBeenCalled();
      });
    } finally { send.mockRestore(); }
  });

  it.each(["acknowledged", "failed"] as const)("preserves a replacement watch when the previous delivery is %s", async (outcome) => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const entered = deferred();
    const release = deferred();
    const send = acknowledgeEvents();
    send.mockImplementationOnce(async (_installationId, _pid, frame) => {
      if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected fixture delivery");
      entered.resolve();
      await release.promise;
      if (outcome === "failed") throw new Error("Fixture delivery failed");
      return { type: "res", id: frame.id, ok: true, data: { eventId: frame.args.eventId, runId: null, queued: false } };
    });
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        const original = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "replacement" }, ctx);
        const delivery = deliverTargetConnectionEvent(kernel, event, "transition:old", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        await entered.promise;
        const replacement = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "replacement", audience: "both" }, ctx);
        expect(replacement.watchId).toBe(original.watchId);
        release.resolve();
        await delivery;
        expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toMatchObject([
          { watchId: original.watchId, revision: 2, audience: "both", status: "active", error: null },
        ]);
        await deliverTargetConnectionEvent(kernel, event, "transition:new", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
        expect(send).toHaveBeenCalledTimes(2);
        expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toEqual([]);
      });
    } finally { release.resolve(); send.mockRestore(); }
  });

  it("does not deliver a queued past transition to watches registered after it occurred", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const entered = deferred();
    const release = deferred();
    const send = acknowledgeEvents();
    send.mockImplementationOnce(async (_installationId, _pid, frame) => {
      if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected fixture delivery");
      entered.resolve();
      await release.promise;
      return { type: "res", id: frame.id, ok: true, data: { eventId: frame.args.eventId, runId: null, queued: false } };
    });
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        const original = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "original", once: false }, ctx);
        const waits: Promise<unknown>[] = [];
        const waiting = vi.spyOn(kernel.ctx, "waitUntil").mockImplementation((promise) => { waits.push(promise); });
        try {
          kernel.connectionRuntime.broadcastTargetStatus(event.targetId, "connected");
          await entered.promise;
          kernel.connectionRuntime.broadcastTargetStatus(event.targetId, "disconnected");
          handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "later", once: false }, ctx);
          release.resolve();
          await Promise.all(waits);
          expect(send).toHaveBeenCalledTimes(2);
          for (const [, , frame] of send.mock.calls) {
            if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected fixture delivery");
            expect(frame.args.eventId.endsWith(`:${original.watchId}`)).toBe(true);
          }
        } finally { release.resolve(); waiting.mockRestore(); }
      });
    } finally { release.resolve(); send.mockRestore(); }
  });

  it("retains active watches without admitting events while the installation is restricted", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const send = acknowledgeEvents();
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        const watched = handleSignalWatch({ signal: "target.status", targetId: event.targetId, audience: "both" }, ctx);
        const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: false, code: 423, message: "Managed installation is restricted" });
        try {
          await deliverTargetConnectionEvent(kernel, event, "transition:restricted", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
          expect(send).not.toHaveBeenCalled();
          expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toMatchObject([
            { watchId: watched.watchId, status: "active", error: null },
          ]);
          gate.mockResolvedValue({ allowed: true });
          await deliverTargetConnectionEvent(kernel, event, "transition:reactivated", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
          expect(send).toHaveBeenCalledTimes(1);
        } finally { gate.mockRestore(); }
      });
    } finally { send.mockRestore(); }
  });

  it.each(["replacement", "access-revocation"] as const)("rechecks %s after asynchronous installation admission", async (mutation) => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const send = acknowledgeEvents();
    const entered = deferred();
    const release = deferred();
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "gate" }, ctx);
        const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return { allowed: true };
        });
        try {
          const delivery = deliverTargetConnectionEvent(kernel, event, "transition:before-gate", kernel.signalWatches.matchTarget(event.targetId, "target.status"));
          await entered.promise;
          if (mutation === "replacement") {
            handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "gate", audience: "both" }, ctx);
          } else {
            kernel.targets.revokeAccess(event.targetId, identity.gid);
          }
          release.resolve();
          await delivery;
          expect(send).not.toHaveBeenCalled();
          if (mutation === "replacement") {
            expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toMatchObject([{ revision: 2, status: "active" }]);
          }
        } finally { release.resolve(); gate.mockRestore(); }
      });
    } finally { release.resolve(); send.mockRestore(); }
  });

  it("derives lifecycle payloads from Kernel targets and preserves connected/disconnected order", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    const send = acknowledgeEvents();
    try {
      await runInDurableObject(stub, async (kernel: Kernel) => {
        const ctx = setup(kernel);
        handleSignalWatch({ signal: "target.status", targetId: event.targetId, once: false, audience: "model", state: { targetId: "spoof", event: "spoof" } }, ctx);
        const waits: Promise<unknown>[] = [];
        const waiting = vi.spyOn(kernel.ctx, "waitUntil").mockImplementation((promise) => { waits.push(promise); });
        try {
          kernel.connectionRuntime.broadcastTargetStatus(event.targetId, "connected");
          kernel.connectionRuntime.broadcastTargetStatus(event.targetId, "disconnected");
          await Promise.all(waits);
        } finally { waiting.mockRestore(); }
        const delivered = send.mock.calls.map(([, , frame]) => {
          if (frame.type !== "req" || frame.call !== "proc.event.deliver") throw new Error("Unexpected fixture delivery");
          return frame.args;
        });
        expect(delivered.map(({ event }) => event.payload.event)).toEqual(["connected", "disconnected"]);
        expect(delivered[0]).toMatchObject({ event: {
          audience: "model", payload: { targetId: "machine:visible", platform: "linux", label: "Fixture machine", version: "fixture-version", observedAt: expect.any(Number) },
        } });
        expect(delivered[0]?.eventId).not.toBe(delivered[1]?.eventId);
        expect(JSON.stringify(delivered)).not.toContain("spoof");
      });
    } finally { send.mockRestore(); }
  });
});
