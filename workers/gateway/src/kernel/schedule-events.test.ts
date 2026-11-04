import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity, ScheduleTarget } from "@humansandmachines/gsv/protocol";
import * as processTransport from "../shared/utils";
import type { Kernel } from "./do";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const WORKER = "proc:worker";
const OTHER = "proc:other";
const PRINCIPAL = { kind: "user", uid: OWNER.uid, username: OWNER.username } as const;
const TELEGRAM = {
  kind: "adapter", adapter: "telegram", accountId: "bot", actorId: "telegram:user:42", surface: { kind: "dm", id: "chat-42" },
} as const;

afterEach(() => vi.restoreAllMocks());

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    // The tests run each firing and pass themselves; no alarm runs one behind them.
    vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
    try {
      kernel.caps.seed();
      kernel.auth.addUser({ username: OWNER.username, uid: OWNER.uid, gid: OWNER.gid, gecos: "Sam", home: OWNER.home, shell: "/bin/init" });
      kernel.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      kernel.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      kernel.procs.spawn(WORKER, OWNER, { ownerUid: OWNER.uid, profile: "task", label: "worker" });
      kernel.procs.spawn(OTHER, OWNER, { ownerUid: OWNER.uid, profile: "task", label: "other" });
      await work(kernel);
    } finally {
      // Test files share modules, so nothing this Kernel scheduled may run during a later test.
      kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
      await kernel.ctx.storage.deleteAlarm();
    }
  });
}

/** A spy that answers every Kernel; tests read only the calls their own Kernel made. */
function processes() {
  const deliver = vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation(async (_installation, _pid, args) => (
    { eventId: args.eventId, runId: args.eventId, queued: false }
  ));
  const framed = vi.spyOn(processTransport, "sendFrameToProcess");
  return {
    delivered: (kernel: Kernel) => deliver.mock.calls.filter(([installationId]) => installationId === kernel.installationId),
    framed: (kernel: Kernel) => framed.mock.calls.filter(([installationId]) => installationId === kernel.installationId),
  };
}

/** A schedule for the worker, due now. */
function schedule(kernel: Kernel, target: Partial<Extract<ScheduleTarget, { kind: "process.event" }>> = {}) {
  const now = Date.now();
  const record = kernel.schedules.create({
    ownerUid: OWNER.uid, creator: PRINCIPAL, runAs: PRINCIPAL, name: "oven check", enabled: true,
    expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
    target: { kind: "process.event", pid: WORKER, message: "Check the oven.", data: { oven: "kitchen" }, ...target },
    now,
  });
  kernel.ctx.storage.sql.exec("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?", now - 1_000, record.id);
  return record;
}

/** One runner pass, which the timer's kick runs in the same alarm. */
async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

function firings(kernel: Kernel) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; subject: string; idempotency_key: string; actor_json: string; body_json: string;
    consumer: string; lane: string | null; state: string; last_error: string | null;
  }>(
    `SELECT e.seq, e.subject, e.idempotency_key, e.actor_json, e.body_json, d.consumer, d.lane, d.state, d.last_error
     FROM events e JOIN deliveries d ON d.seq = e.seq WHERE e.type = 'schedule.fired' ORDER BY e.seq`,
  ).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
}

describe("schedule firings on the event log", () => {
  it("appends one firing for its process, then delivers the schedule as it stands from the log", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const record = schedule(kernel);
      await kernel.scheduleRuntime.onScheduleDue(record.id);

      const [firing] = firings(kernel);
      expect(firings(kernel)).toEqual([{
        seq: firing!.seq, subject: `schedule:${record.id}`, idempotency_key: `${record.id}:due:${firing!.body.scheduledAtMs}`,
        actor: { kind: "schedule", scheduleId: record.id },
        body: { scheduleId: record.id, pid: WORKER, scheduledAtMs: expect.any(Number), firedAtMs: expect.any(Number) },
        consumer: `proc:${WORKER}`, lane: "background", state: "pending", last_error: null,
      }]);
      // The timer only appends; the runner it kicked makes the call.
      expect(delivered(kernel)).toEqual([]);
      expect(framed(kernel)).toEqual([]);
      expect(kernel.schedules.get(record.id)?.state).toMatchObject({ lastStatus: "ok", runCount: 1 });
      expect(kernel.schedules.history(record.id)[0]?.result).toEqual({ kind: "process.event", pid: WORKER, eventId: `evt_${firing!.seq}` });

      // A change made while the firing waited goes with it.
      kernel.schedules.update(record.id, { target: { kind: "process.event", pid: WORKER, message: "Check the oven again." }, now: Date.now() });
      await runEvents(kernel);
      const runId = `evt_${firing!.seq}:proc:${WORKER}`;
      expect(delivered(kernel)).toEqual([[kernel.installationId, WORKER, {
        eventId: runId,
        event: {
          kind: "schedule.fired", severity: "info", audience: "model",
          payload: {
            runId, scheduleId: record.id, scheduleName: "oven check", message: "Check the oven again.",
            scheduledAtMs: firing!.body.scheduledAtMs, firedAtMs: firing!.body.firedAtMs,
          },
        },
        admission: { idle: "start", busy: "join" },
      }]]);
      expect(firings(kernel)[0]).toMatchObject({ state: "delivered" });
    });
  });

  it("appends nothing when an occurrence fires again", async () => {
    processes();
    await fixture(async (kernel) => {
      const record = schedule(kernel);
      const first = await kernel.scheduleRuntime.dispatchScheduleTarget(record, 1_000, 1_100, "due:1000");
      const again = await kernel.scheduleRuntime.dispatchScheduleTarget(record, 1_000, 1_200, "due:1000");
      expect(again).toEqual(first);
      expect(firings(kernel)).toHaveLength(1);
    });
  });

  it("lets a newer firing replace one still waiting", async () => {
    processes();
    await fixture(async (kernel) => {
      const record = schedule(kernel);
      await kernel.scheduleRuntime.dispatchScheduleTarget(record, 1_000, 1_100, "due:1000");
      await kernel.scheduleRuntime.dispatchScheduleTarget(record, 61_000, 61_100, "due:61000");
      // The same occurrence again leaves the newer firing waiting.
      await kernel.scheduleRuntime.dispatchScheduleTarget(record, 61_000, 61_200, "due:61000");
      expect(firings(kernel).map(({ idempotency_key, state, last_error }) => ({ idempotency_key, state, last_error }))).toEqual([
        { idempotency_key: `${record.id}:due:1000`, state: "withdrawn", last_error: "a newer firing of its schedule replaced it" },
        { idempotency_key: `${record.id}:due:61000`, state: "pending", last_error: null },
      ]);
    });
  });

  it("gives a firing with a reply destination its own run there, after any current run", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      kernel.adapters.identityLinks.link("telegram", "bot", "telegram:user:42", OWNER.uid, OWNER.uid, { surfaceKind: "dm", surfaceId: "chat-42" });
      const record = schedule(kernel, { replyTo: TELEGRAM });
      await kernel.scheduleRuntime.onScheduleDue(record.id);
      await runEvents(kernel);

      const [firing] = firings(kernel);
      const runId = `evt_${firing!.seq}:proc:${WORKER}`;
      expect(delivered(kernel)).toEqual([[kernel.installationId, WORKER, expect.objectContaining({
        eventId: runId,
        event: expect.objectContaining({ payload: expect.objectContaining({ runId, replyTo: TELEGRAM }) }),
        admission: { idle: "start", busy: "after" },
      })]]);
      expect(kernel.runRoutes.get(runId)).toMatchObject({ kind: "adapter", processId: WORKER, uid: OWNER.uid, destination: TELEGRAM });
    });
  });

  it("keeps a reply firing's route through a failed attempt and retries under the same run", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      kernel.adapters.identityLinks.link("telegram", "bot", "telegram:user:42", OWNER.uid, OWNER.uid, { surfaceKind: "dm", surfaceId: "chat-42" });
      const record = schedule(kernel, { replyTo: TELEGRAM });
      await kernel.scheduleRuntime.onScheduleDue(record.id);
      const [firing] = firings(kernel);
      const runId = `evt_${firing!.seq}:proc:${WORKER}`;

      // The call may have reached the process before it failed, so its run keeps the route.
      vi.mocked(processTransport.deliverEventToProcess).mockRejectedValueOnce(new Error("Network connection lost."));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await runEvents(kernel);
      expect(firings(kernel)[0]).toMatchObject({ state: "pending", last_error: "Network connection lost." });
      expect(kernel.runRoutes.get(runId)).toMatchObject({ processId: WORKER, destination: TELEGRAM });

      kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE seq = ?", firing!.seq);
      await runEvents(kernel);
      expect(delivered(kernel).map(([, , args]) => args.eventId)).toEqual([runId, runId]);
      expect(firings(kernel)[0]).toMatchObject({ state: "delivered" });
      expect(kernel.runRoutes.get(runId)).toMatchObject({ processId: WORKER, destination: TELEGRAM });
    });
  });

  it("withdraws a firing once its schedule is removed or goes to another process", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const removed = schedule(kernel);
      await kernel.scheduleRuntime.onScheduleDue(removed.id);
      kernel.schedules.remove(removed.id);
      const moved = schedule(kernel);
      await kernel.scheduleRuntime.onScheduleDue(moved.id);
      kernel.schedules.update(moved.id, { target: { kind: "process.event", pid: OTHER, message: "Check the oven." }, now: Date.now() });

      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      expect(firings(kernel).map(({ state, last_error }) => ({ state, last_error }))).toEqual([
        { state: "withdrawn", last_error: "its schedule was removed" },
        { state: "withdrawn", last_error: "its schedule no longer goes to this process" },
      ]);
    });
  });

  it("withdraws a reply firing whose destination is no longer allowed", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      kernel.adapters.identityLinks.link("telegram", "bot", "telegram:user:42", OWNER.uid, OWNER.uid, { surfaceKind: "dm", surfaceId: "chat-42" });
      const record = schedule(kernel, { replyTo: TELEGRAM });
      await kernel.scheduleRuntime.onScheduleDue(record.id);
      kernel.adapters.identityLinks.unlink("telegram", "bot", "telegram:user:42");

      await runEvents(kernel);
      expect(delivered(kernel)).toEqual([]);
      const [firing] = firings(kernel);
      expect(firing).toMatchObject({ state: "withdrawn", last_error: "its reply destination is no longer allowed" });
      expect(kernel.runRoutes.get(`evt_${firing!.seq}:proc:${WORKER}`)).toBeNull();
    });
  });
});
