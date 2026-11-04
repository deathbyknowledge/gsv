import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { getDurableObjectByName } from "../shared/durable-object";
import * as utils from "../shared/utils";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import { SignalWatchStore } from "./signal-watches";
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

afterEach(() => vi.restoreAllMocks());

/** A Kernel with the fixture's processes and targets; the test runs each event pass itself. */
async function fixture(work: (kernel: Kernel, ctx: KernelContext) => Promise<void>) {
  const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
  await runInDurableObject(stub, async (kernel: Kernel) => {
    vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
    try {
      await work(kernel, setup(kernel));
    } finally {
      // Test files share modules, so nothing this Kernel scheduled may run during a later test.
      kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
      await kernel.ctx.storage.deleteAlarm();
    }
  });
}

/** A spy that answers every Kernel; tests read only the calls their own Kernel made. */
function processes() {
  const deliver = vi.spyOn(utils, "deliverEventToProcess").mockImplementation(async (_installationId, _pid, args) => (
    { eventId: args.eventId, runId: null, queued: false, messageId: 1 }
  ));
  return {
    deliver,
    delivered: (kernel: Kernel) => deliver.mock.calls
      .filter(([installationId]) => installationId === kernel.installationId)
      .map(([, pid, args]) => ({ pid, ...args })),
  };
}

/** One runner pass, as the kick's alarm would run it. */
async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

/** Lets every waiting delivery go on the next pass, as its retry would. */
function retryNow(kernel: Kernel) {
  kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE state = 'pending'");
}

function change(kernel: Kernel, connection: "connected" | "disconnected" = "connected") {
  kernel.connectionRuntime.broadcastTargetStatus(event.targetId, connection);
}

function targetEvents(kernel: Kernel) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; subject: string; owner_uid: number; body_json: string;
    consumer: string; lane: string | null; state: string; attempt_count: number; last_error: string | null;
  }>(
    `SELECT e.seq, e.subject, e.owner_uid, e.body_json, d.consumer, d.lane, d.state, d.attempt_count, d.last_error
     FROM events e JOIN deliveries d ON d.seq = e.seq WHERE e.type = 'target.status' ORDER BY e.seq`,
  ).toArray().map(({ body_json, ...row }) => ({ ...row, body: JSON.parse(body_json) }));
}

function watchState(kernel: Kernel, watchId: string) {
  return kernel.ctx.storage.sql.exec<{ revision: number; status: string; error: string | null }>(
    "SELECT revision, status, error FROM signal_watches WHERE watch_id = ?", watchId,
  ).toArray()[0] ?? null;
}

const event = { targetId: "machine:visible", event: "connected", platform: "linux", observedAt: 100 } as const;
const UNAUTHORIZED = "target watch authorization no longer permits delivery";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("registered target event watches", () => {
  it("retires old process watches while retaining target watch state across the migration", async () => {
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
      runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter(({ id }) => id <= 40));
      expect(state.storage.sql.exec("SELECT * FROM signal_watches").toArray())
        .toEqual(before.map((row) => ({ ...row, source_target_id: null, event_audience: null, revision: 1 })));
      const store = new SignalWatchStore(state.storage.sql);
      store.upsert({
        uid: 7000, target: { kind: "process", processId: "proc:observer" },
        signal: "target.status", sourceTargetId: "machine:visible", audience: "both",
        key: "retained", state: { retained: true }, once: false,
      });
      const retained = state.storage.sql.exec("SELECT * FROM signal_watches WHERE source_target_id IS NOT NULL").toArray();
      runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
      expect(state.storage.sql.exec("SELECT * FROM signal_watches").toArray()).toEqual(retained);
      expect(store.matchTarget("machine:visible", "target.status")).toMatchObject([
        { targetProcessId: "proc:observer", sourceTargetId: "machine:visible", audience: "both", state: { retained: true } },
      ]);
    });
  });

  it("authorizes only an exact visible target and a registered connection source", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(stub, (kernel: Kernel) => {
      const ctx = setup(kernel);
      for (const args of [
        { signal: "target.status", targetId: "machine:private" },
        { signal: "target.status", targetId: "missing" },
        { signal: "custom.machine", targetId: "machine:visible" },
        { signal: "proc.run.finished", processId: "proc:foreign" },
        { signal: "proc.run.finished", processId: "proc:observer" },
        { signal: "proc.run.finished", processId: "proc:child", audience: "person" as const },
      ]) {
        expect(() => {
          // @ts-expect-error Invalid source shapes intentionally violate the public contract.
          handleSignalWatch(args, ctx);
        }).toThrow();
      }
      const watched = handleSignalWatch({ signal: "target.status", targetId: "machine:visible", key: "target:status", once: false }, ctx);
      expect(kernel.signalWatches.matchTarget("machine:visible", "target.status")).toMatchObject([
        { watchId: watched.watchId, uid: 7000, targetProcessId: "proc:observer", sourceTargetId: "machine:visible", audience: "person" },
      ]);
      handleSignalWatch({ signal: "target.status", targetId: "machine:visible", key: "target:status", audience: "both" }, ctx);
      expect(kernel.signalWatches.matchTarget("machine:visible", "target.status")).toMatchObject([{ watchId: watched.watchId, audience: "both" }]);
      expect(handleSignalUnwatch({ key: "target:status" }, ctx)).toEqual({ removed: 1 });
    });
  });

  it("does not turn process output into watched frames even with an old registration present", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(stub, async (kernel: Kernel, state) => {
      setup(kernel);
      state.storage.sql.exec(
        `INSERT INTO signal_watches (watch_id, uid, target_type, target_process_id, signal, process_id,
          state_json, once_only, status, created_at, updated_at)
         VALUES ('retired-watch', 7000, 'process', 'proc:observer', 'proc.run.finished', 'proc:child',
          'null', 1, 'active', 1, 1)`,
      );
      const send = vi.spyOn(utils, "sendFrameToProcess");
      const deliver = vi.spyOn(utils, "deliverEventToProcess");
      const broadcast = vi.spyOn(kernel.processOutput, "broadcastProcessSignal").mockImplementation(() => {});
      const frame = {
        type: "sig", signal: "proc.run.finished", payload: { pid: "proc:child", runId: "run:child", timestamp: Date.now() },
      } as const;
      try {
        await kernel.processOutput.handleProcessSignal("proc:child", frame, frame);
        expect(send).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith(7000, "proc:child", null, frame);
      } finally {
        send.mockRestore();
        deliver.mockRestore();
        broadcast.mockRestore();
      }
    });
  });

  it("appends one event per watch for its process, from Kernel target state, and delivers it on the runner's pass", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const watch = handleSignalWatch({
        signal: "target.status", targetId: event.targetId, once: false, audience: "model", state: { targetId: "spoof", event: "spoof" },
      }, ctx);
      change(kernel);
      const connection = {
        targetId: "machine:visible", event: "connected", platform: "linux", label: "Fixture machine", version: "fixture-version",
        observedAt: expect.any(Number),
      };
      const [appended] = targetEvents(kernel);
      expect(targetEvents(kernel)).toEqual([{
        seq: appended!.seq, subject: "target:machine:visible", owner_uid: 7000,
        consumer: "proc:proc:observer", lane: "background", state: "pending", attempt_count: 0, last_error: null,
        body: { watchId: watch.watchId, revision: 1, pid: "proc:observer", connection },
      }]);
      expect(delivered(kernel)).toEqual([]);

      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([{
        pid: "proc:observer",
        eventId: `evt_${appended!.seq}:proc:proc:observer`,
        event: { kind: "target.connection", payload: connection, audience: "model", severity: "info" },
        admission: { idle: "start", busy: "join" },
      }]);
      expect(JSON.stringify(delivered(kernel))).not.toContain("spoof");
      expect(targetEvents(kernel)).toMatchObject([{ state: "delivered" }]);
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(1);
      expect(watchState(kernel, watch.watchId)).toEqual({ revision: 1, status: "active", error: null });
    });
  });

  it("replaces a change still waiting, so each watching process hears how the target is now", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId, once: false }, ctx);
      const removed = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "removed", once: false }, ctx);
      change(kernel, "connected");
      expect(handleSignalUnwatch({ key: "removed" }, ctx)).toEqual({ removed: 1 });
      change(kernel, "disconnected");
      const replaced = { state: "withdrawn", last_error: "a newer connection change replaced it", body: { connection: { event: "connected" } } };
      expect(targetEvents(kernel).filter(({ state }) => state === "withdrawn")).toHaveLength(2);
      expect(targetEvents(kernel)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ...replaced, body: expect.objectContaining({ watchId: watch.watchId }) }),
        expect.objectContaining({ ...replaced, body: expect.objectContaining({ watchId: removed.watchId }) }),
      ]));
      expect(targetEvents(kernel).filter(({ state }) => state === "pending")).toMatchObject([
        { body: { watchId: watch.watchId, connection: { event: "disconnected" } } },
      ]);
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(1);
      expect(delivered(kernel)).toMatchObject([{ event: { payload: { event: "disconnected" } } }]);
      expect(watchState(kernel, watch.watchId)).toMatchObject({ status: "active" });
    });
  });

  it("keeps a change and its watch across eviction until the change goes", async () => {
    const stub = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    let watchId = "";
    await runInDurableObject(stub, (kernel: Kernel) => {
      vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
      watchId = handleSignalWatch({ signal: "target.status", targetId: event.targetId }, setup(kernel)).watchId;
      change(kernel);
      // Offline already, so the restarted Kernel has no newer change to append.
      kernel.targets.setOnline(event.targetId, false);
    });
    await evictDurableObject(stub);
    const { delivered } = processes();
    await runInDurableObject(stub, async (kernel: Kernel) => {
      vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
      try {
        expect(watchState(kernel, watchId)).toMatchObject({ status: "active" });
        await runEvents(kernel);
        expect(delivered(kernel)).toMatchObject([{ pid: "proc:observer", event: { payload: { event: "connected" } } }]);
        // A one-time watch ends with the change it waited for.
        expect(watchState(kernel, watchId)).toBeNull();
      } finally {
        kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
        await kernel.ctx.storage.deleteAlarm();
      }
    });
  });

  it.each([
    ["resetting", true], ["resetting", false],
    ["error", true], ["error", false],
  ] as const)("retries a change whose process was %s with once=%s, keeping the watch until the change goes", async (failure, once) => {
    await fixture(async (kernel, ctx) => {
      const { deliver, delivered } = processes();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deliver.mockImplementationOnce(async () => {
        if (failure === "error") throw new Error("Fixture Process temporarily unavailable");
        return { unavailable: "transitioning", message: "Process lifecycle is resetting" };
      });
      const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId, once }, ctx);
      change(kernel);
      await runEvents(kernel);
      expect(targetEvents(kernel)).toMatchObject([{ state: "pending", attempt_count: 1 }]);
      expect(watchState(kernel, watch.watchId)).toEqual({ revision: 1, status: "active", error: null });

      retryNow(kernel);
      await runEvents(kernel);
      const [first, retried] = delivered(kernel);
      expect(retried?.eventId).toBe(first?.eventId);
      expect(targetEvents(kernel)).toMatchObject([{ state: "delivered" }]);
      expect(watchState(kernel, watch.watchId)).toEqual(once ? null : { revision: 1, status: "active", error: null });
    });
  });

  it("keeps a one-time watch whose process ignored the change, for the next one", async () => {
    await fixture(async (kernel, ctx) => {
      const { deliver, delivered } = processes();
      deliver.mockImplementationOnce(async (_installationId, _pid, args) => ({ eventId: args.eventId, runId: null, queued: false, ignored: true }));
      const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId, once: true }, ctx);
      change(kernel, "connected");
      await runEvents(kernel);
      expect(watchState(kernel, watch.watchId)).toEqual({ revision: 1, status: "active", error: null });
      change(kernel, "disconnected");
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(2);
      expect(delivered(kernel)).toMatchObject([{ event: { payload: { event: "connected" } } }, { event: { payload: { event: "disconnected" } } }]);
      expect(watchState(kernel, watch.watchId)).toBeNull();
    });
  });

  it("rechecks target access and the watching process's capability at every delivery, and fails a watch that lost them", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const access = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "access" }, ctx);
      change(kernel);
      kernel.targets.revokeAccess(event.targetId, identity.gid);
      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      expect(targetEvents(kernel)).toMatchObject([{ state: "withdrawn", last_error: UNAUTHORIZED }]);
      expect(watchState(kernel, access.watchId)).toEqual({ revision: 1, status: "failed", error: UNAUTHORIZED });

      kernel.targets.grantAccess(event.targetId, identity.gid);
      const capability = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "capability" }, ctx);
      change(kernel);
      kernel.caps.revoke(identity.gid, "signal.watch");
      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      expect(watchState(kernel, capability.watchId)).toEqual({ revision: 1, status: "failed", error: UNAUTHORIZED });
    });
  });

  it("fails a watch whose process is gone", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId, once: false }, ctx);
      change(kernel);
      kernel.procs.kill("proc:observer");
      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      expect(targetEvents(kernel)).toMatchObject([{ state: "withdrawn", last_error: "the process is gone" }]);
      expect(watchState(kernel, watch.watchId)).toEqual({ revision: 1, status: "failed", error: "the process is gone" });
    });
  });

  it.each(["acknowledged", "failed", "resetting", "ignored"] as const)("keeps a watch replaced while its change was %s on the way", async (outcome) => {
    await fixture(async (kernel, ctx) => {
      const { deliver, delivered } = processes();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const entered = deferred();
      const release = deferred();
      deliver.mockImplementationOnce(async (_installationId, _pid, args) => {
        entered.resolve();
        await release.promise;
        if (outcome === "failed") throw new Error("Process no longer exists");
        if (outcome === "resetting") return { unavailable: "transitioning", message: "Process lifecycle is resetting" };
        return { eventId: args.eventId, runId: null, queued: false, ignored: outcome === "ignored" };
      });
      const original = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "replacement" }, ctx);
      change(kernel, "connected");
      const pass = runEvents(kernel);
      await entered.promise;
      const replacement = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "replacement", audience: "both" }, ctx);
      expect(replacement.watchId).toBe(original.watchId);
      release.resolve();
      await pass;
      expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toMatchObject([
        { watchId: original.watchId, revision: 2, audience: "both", status: "active", error: null },
      ]);
      // A retry of the earlier change is withdrawn: the watch it was for changed.
      retryNow(kernel);
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(1);

      change(kernel, "disconnected");
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(2);
      expect(delivered(kernel)[1]).toMatchObject({ event: { audience: "both", payload: { event: "disconnected" } } });
      expect(kernel.signalWatches.matchTarget(event.targetId, "target.status")).toEqual([]);
    });
  });

  it("does not hand a past change to a watch made after it", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const original = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "original", once: false }, ctx);
      change(kernel, "connected");
      const later = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "later", once: false }, ctx);
      await runEvents(kernel);
      expect(targetEvents(kernel).map(({ body }) => body.watchId)).toEqual([original.watchId]);
      expect(delivered(kernel)).toHaveLength(1);
      change(kernel, "disconnected");
      await runEvents(kernel);
      expect(targetEvents(kernel).map(({ body }) => body.watchId).sort()).toEqual([original.watchId, original.watchId, later.watchId].sort());
      expect(delivered(kernel)).toHaveLength(3);
    });
  });

  it("holds changes while the installation is restricted, keeping their watches", async () => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const watched = handleSignalWatch({ signal: "target.status", targetId: event.targetId, audience: "both" }, ctx);
      const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: false, code: 423, message: "Managed installation is restricted" });
      change(kernel);
      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      expect(targetEvents(kernel)).toMatchObject([{ state: "pending", attempt_count: 0 }]);
      expect(watchState(kernel, watched.watchId)).toEqual({ revision: 1, status: "active", error: null });
      gate.mockResolvedValue({ allowed: true });
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(1);
    });
  });

  it.each(["replacement", "access-revocation"] as const)("reads the watch again after the installation gate, as after a %s", async (mutation) => {
    await fixture(async (kernel, ctx) => {
      const { delivered } = processes();
      const entered = deferred();
      const release = deferred();
      const watch = handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "gate" }, ctx);
      change(kernel);
      vi.spyOn(kernel.onboarding, "managedWorkGate").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { allowed: true };
      });
      const pass = runEvents(kernel);
      await entered.promise;
      if (mutation === "replacement") {
        handleSignalWatch({ signal: "target.status", targetId: event.targetId, key: "gate", audience: "both" }, ctx);
      } else {
        kernel.targets.revokeAccess(event.targetId, identity.gid);
      }
      release.resolve();
      await pass;
      expect(delivered(kernel)).toEqual([]);
      expect(watchState(kernel, watch.watchId)).toEqual(mutation === "replacement"
        ? { revision: 2, status: "active", error: null }
        : { revision: 1, status: "failed", error: UNAUTHORIZED });
    });
  });
});
