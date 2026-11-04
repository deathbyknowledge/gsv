import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import * as processTransport from "../shared/utils";
import type { Kernel } from "./do";
import { handleProcIpcCall, handleProcIpcSend } from "./proc-handlers";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const CALLER = "caller";
const TARGET = "target";
const CALLER_RUN = "caller-run";
const REPLACED = { unavailable: "transitioning", message: "Process is being replaced" } as const;

afterEach(() => vi.restoreAllMocks());

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    // The tests run each pass themselves; no alarm runs one behind them.
    vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
    try {
      kernel.caps.seed();
      kernel.auth.addUser({ username: OWNER.username, uid: OWNER.uid, gid: OWNER.gid, gecos: "Sam", home: OWNER.home, shell: "/bin/init" });
      kernel.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      kernel.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      kernel.procs.spawn(CALLER, OWNER, { ownerUid: OWNER.uid, profile: "task", label: "caller" });
      kernel.procs.spawn(TARGET, OWNER, { ownerUid: OWNER.uid, profile: "task", label: "target" });
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
  const framed = vi.spyOn(processTransport, "sendFrameToProcess").mockResolvedValue(null);
  return {
    deliver,
    delivered: (kernel: Kernel, pid?: string) => deliver.mock.calls
      .filter(([installationId, to]) => installationId === kernel.installationId && (pid === undefined || to === pid)),
    framed: (kernel: Kernel) => framed.mock.calls.filter(([installationId]) => installationId === kernel.installationId),
  };
}

/** The caller's context inside one of its runs, as its syscalls see it. */
function caller(kernel: Kernel) {
  const ctx = kernel.buildProcessContext(CALLER, CALLER_RUN);
  if (!ctx) throw new Error("the caller is not registered");
  return ctx;
}

/** One runner pass, as the kick's alarm would run it. */
async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

/** Lets every waiting delivery go on the next pass, as its retry would. */
function retryNow(kernel: Kernel) {
  kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE state = 'pending'");
}

function ipcEvents(kernel: Kernel) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; type: string; subject: string; idempotency_key: string; actor_json: string; body_json: string;
    consumer: string; lane: string | null; state: string; last_error: string | null; run_id: string | null;
  }>(
    `SELECT e.seq, e.type, e.subject, e.idempotency_key, e.actor_json, e.body_json,
       d.consumer, d.lane, d.state, d.last_error, d.run_id
     FROM events e JOIN deliveries d ON d.seq = e.seq WHERE e.type LIKE 'ipc.%' ORDER BY e.seq`,
  ).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
}

/** A run's end, as its Process signals it. */
function finished(runId: string, status: "ok" | "error" | "aborted", text: string | null = null) {
  return { type: "sig", signal: "proc.run.finished", payload: { runId, status, result: { text } } } as const;
}

async function call(kernel: Kernel, options: Parameters<typeof handleProcIpcCall>[2] = {}, timeoutMs = 60_000) {
  const called = await handleProcIpcCall({ pid: TARGET, message: "Check the oven.", timeoutMs }, caller(kernel), options);
  if (!called.ok) throw new Error(called.error);
  return called;
}

describe("process IPC on the event log", () => {
  it("delivers a message in the call that sends it, under its delivery's run id", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const sent = await handleProcIpcSend({ pid: TARGET, message: "Summarize the build.", metadata: { kind: "status" } }, caller(kernel));

      const [event] = ipcEvents(kernel);
      const runId = `evt_${event!.seq}:proc:${TARGET}`;
      expect(sent).toEqual({ ok: true, status: "started", pid: TARGET, sourcePid: CALLER, runId });
      const source = expect.objectContaining({ uid: OWNER.uid, username: OWNER.username });
      expect(ipcEvents(kernel)).toEqual([{
        seq: event!.seq, type: "ipc.message", subject: `ipc:${event!.idempotency_key}`, idempotency_key: event!.idempotency_key,
        actor: { kind: "process", pid: CALLER },
        body: { targetPid: TARGET, sourcePid: CALLER, source, message: "Summarize the build.", metadata: { kind: "status" } },
        consumer: `proc:${TARGET}`, lane: "background", state: "delivered", last_error: null, run_id: runId,
      }]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, TARGET, {
        eventId: runId,
        message: {
          sourcePid: CALLER, source, message: "Summarize the build.", metadata: { kind: "status" },
          origin: { kind: "process", sourcePid: CALLER, uid: OWNER.uid }, sentAt: expect.any(Number),
        },
        admission: { idle: "start", busy: "after" },
      }]]);
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("answers queued when the target can't take a message now, and the runner delivers it later", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deliver.mockResolvedValueOnce(REPLACED);
      const sent = await handleProcIpcSend({ pid: TARGET, message: "Hello." }, caller(kernel));

      const [event] = ipcEvents(kernel);
      const runId = `evt_${event!.seq}:proc:${TARGET}`;
      expect(sent).toEqual({ ok: true, status: "started", pid: TARGET, sourcePid: CALLER, runId, queued: true });
      expect(event).toMatchObject({ state: "pending", last_error: "Process is being replaced" });

      retryNow(kernel);
      await runEvents(kernel);
      expect(delivered(kernel).map(([, , args]) => args.eventId)).toEqual([runId, runId]);
      expect(ipcEvents(kernel)[0]).toMatchObject({ state: "delivered", run_id: runId });
    });
  });

  it("keeps a message behind an older one still waiting for the same process", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deliver.mockResolvedValueOnce(REPLACED);
      await handleProcIpcSend({ pid: TARGET, message: "First." }, caller(kernel));
      const second = await handleProcIpcSend({ pid: TARGET, message: "Second." }, caller(kernel));

      expect(second).toMatchObject({ ok: true, queued: true });
      expect(delivered(kernel)).toHaveLength(1);
      retryNow(kernel);
      await runEvents(kernel);
      // SAFETY: these deliveries all carry a process's message.
      const messages = delivered(kernel).map(([, , args]) => (args as { message: { message: string } }).message.message);
      expect(messages).toEqual(["First.", "First.", "Second."]);
    });
  });

  it("refuses a message the log can't hold before anything is sent or scheduled", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const message = "x".repeat(70_000);
      const sent = await handleProcIpcSend({ pid: TARGET, message }, caller(kernel));
      const called = await handleProcIpcCall({ pid: TARGET, message }, caller(kernel));

      for (const result of [sent, called]) expect(result).toEqual({ ok: false, error: expect.stringContaining("64 KiB") });
      expect(ipcEvents(kernel)).toEqual([]);
      expect(delivered(kernel)).toEqual([]);
      expect(framed(kernel)).toEqual([]);
      const sql = kernel.ctx.storage.sql;
      expect(sql.exec("SELECT count(*) AS count FROM ipc_calls").one().count).toBe(0);
      expect(sql.exec("SELECT count(*) AS count FROM cf_agents_schedules WHERE callback = 'onIpcCallTimeout'").one().count).toBe(0);
    });
  });

  it("starts a call in the call that makes it, then answers the asking run from the call's row", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const called = await call(kernel);
      const [forward] = ipcEvents(kernel);
      const callId = forward!.idempotency_key;
      const runId = `evt_${forward!.seq}:proc:${TARGET}`;
      expect(called).toEqual({ ok: true, status: "started", callId, pid: TARGET, sourcePid: CALLER, runId, deadlineAt: expect.any(Number) });
      expect(forward).toMatchObject({
        type: "ipc.call", subject: `ipc:${callId}`, actor: { kind: "process", pid: CALLER },
        body: { targetPid: TARGET, sourcePid: CALLER, message: "Check the oven.", call: { callId, deadlineAt: called.deadlineAt } },
        consumer: `proc:${TARGET}`, lane: "background", state: "delivered",
      });
      expect(delivered(kernel)[0]![2]).toEqual({
        eventId: runId,
        message: expect.objectContaining({ message: "Check the oven.", call: { callId, deadlineAt: called.deadlineAt } }),
        admission: { idle: "start", busy: "after" },
      });
      expect(kernel.ipcCalls.get(callId)).toMatchObject({ status: "pending", sourceRunId: CALLER_RUN, targetRunId: runId });

      // The target's run ends, and its answer goes to the caller through the log.
      await kernel.ipc.completeIpcCallsForProcessSignal(TARGET, finished(runId, "ok", "The oven is off."));
      const reply = ipcEvents(kernel)[1];
      expect(reply).toMatchObject({
        type: "ipc.reply", subject: `ipc:${callId}`, idempotency_key: callId, actor: { kind: "process", pid: TARGET },
        body: { callId, sourcePid: CALLER }, consumer: `proc:${CALLER}`, lane: "background", state: "pending",
      });
      await runEvents(kernel);
      expect(delivered(kernel, CALLER)).toEqual([[kernel.installationId, CALLER, {
        eventId: `evt_${reply!.seq}:proc:${CALLER}`,
        event: {
          kind: "ipc.reply", severity: "info", audience: "model",
          payload: {
            callId, targetPid: TARGET, sourceRunId: CALLER_RUN, createdAt: expect.any(Number), deadlineAt: called.deadlineAt,
            response: { text: "The oven is off.", usage: null },
          },
        },
        admission: { idle: "start", busy: "join", joinRun: CALLER_RUN },
      }]]);
      // The caller's Process holds the answer now, so the call's row is gone.
      expect(kernel.ipcCalls.get(callId)).toBeNull();
    });
  });

  it("times out a call its target never received: the call is withdrawn and the caller hears", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deliver.mockResolvedValueOnce(REPLACED);
      const called = await call(kernel, {}, 1_000);
      expect(called.queued).toBe(true);

      kernel.ctx.storage.sql.exec("UPDATE ipc_calls SET deadline_at = 0 WHERE call_id = ?", called.callId);
      await kernel.ipc.onIpcCallTimeout(called.callId);
      retryNow(kernel);
      await runEvents(kernel);

      expect(ipcEvents(kernel).map(({ type, consumer, state, last_error }) => ({ type, consumer, state, last_error }))).toEqual([
        { type: "ipc.call", consumer: `proc:${TARGET}`, state: "withdrawn", last_error: "the call already ended" },
        { type: "ipc.timeout", consumer: `proc:${CALLER}`, state: "delivered", last_error: null },
      ]);
      expect(delivered(kernel, TARGET)).toHaveLength(1);
      expect(delivered(kernel, CALLER)[0]![2]).toMatchObject({
        event: {
          kind: "ipc.timeout", severity: "error", audience: "model",
          payload: { callId: called.callId, targetPid: TARGET, sourceRunId: CALLER_RUN, error: "IPC call timed out" },
        },
        admission: { idle: "start", busy: "join", joinRun: CALLER_RUN },
      });
      expect(kernel.ipcCalls.get(called.callId)).toBeNull();
    });
  });

  it("delivers a supervised call's check-in to the asking run", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const called = await call(kernel, { superviseAfterTimeout: true });
      await kernel.ipc.onIpcCallTimeout(
        { callId: called.callId, mode: "supervise", intervalMs: 60_000, checkInCount: 0 }, { id: `task:${crypto.randomUUID()}` },
      );

      const checkIn = ipcEvents(kernel)[1];
      expect(checkIn).toMatchObject({
        type: "ipc.overdue", subject: `ipc:${called.callId}`, idempotency_key: `${called.callId}:1`, actor: { kind: "kernel" },
        body: { callId: called.callId, sourcePid: CALLER, checkedAt: expect.any(Number), nextCheckAt: expect.any(Number), checkInCount: 1 },
        consumer: `proc:${CALLER}`, lane: "background", state: "pending",
      });
      await runEvents(kernel);
      expect(delivered(kernel, CALLER)[0]![2]).toEqual({
        eventId: `evt_${checkIn!.seq}:proc:${CALLER}`,
        event: {
          kind: "ipc.overdue", severity: "info", audience: "model",
          payload: {
            callId: called.callId, targetPid: TARGET, sourceRunId: CALLER_RUN, createdAt: expect.any(Number),
            deadlineAt: checkIn!.body.checkedAt, nextCheckAt: checkIn!.body.nextCheckAt, checkInCount: 1,
          },
        },
        admission: { idle: "start", busy: "join", joinRun: CALLER_RUN },
      });
      expect(kernel.ipcCalls.get(called.callId)).toMatchObject({ status: "pending", deadlineAt: checkIn!.body.nextCheckAt });
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("replaces a check-in still waiting with a newer one, and drops it once the call is answered", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const called = await call(kernel, { superviseAfterTimeout: true });
      const task = { id: `task:${crypto.randomUUID()}` };
      await kernel.ipc.onIpcCallTimeout({ callId: called.callId, mode: "supervise", intervalMs: 60_000, checkInCount: 0 }, task);
      await kernel.ipc.onIpcCallTimeout({ callId: called.callId, mode: "supervise", intervalMs: 60_000, checkInCount: 1 }, task);
      const checkIns = () => ipcEvents(kernel).filter(({ type }) => type === "ipc.overdue")
        .map(({ idempotency_key, state, last_error }) => ({ idempotency_key, state, last_error }));
      expect(checkIns()).toEqual([
        { idempotency_key: `${called.callId}:1`, state: "withdrawn", last_error: "a newer check-in replaced it" },
        { idempotency_key: `${called.callId}:2`, state: "pending", last_error: null },
      ]);

      // The target answers before the newer check-in goes out, so the caller gets only the answer.
      await kernel.ipc.completeIpcCallsForProcessSignal(TARGET, finished(called.runId, "ok", "Bread is ready."));
      await runEvents(kernel);
      expect(checkIns()[1]).toEqual({ idempotency_key: `${called.callId}:2`, state: "withdrawn", last_error: "the call already ended" });
      // SAFETY: deliveries to the caller all carry a history event.
      const kinds = delivered(kernel, CALLER).map(([, , args]) => (args as { event: { kind: string } }).event.kind);
      expect(kinds).toEqual(["ipc.reply"]);
    });
  });

  it("withdraws an answer once the asking run was aborted", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const called = await call(kernel);
      await kernel.ipc.completeIpcCallsForProcessSignal(TARGET, finished(called.runId, "ok", "The oven is off."));
      await kernel.ipc.completeIpcCallsForProcessSignal(CALLER, finished(CALLER_RUN, "aborted"));
      await runEvents(kernel);

      expect(ipcEvents(kernel).find(({ type }) => type === "ipc.reply")).toMatchObject({ state: "withdrawn", last_error: "the call was cancelled" });
      expect(delivered(kernel, CALLER)).toEqual([]);
    });
  });

  it("returns delegated work, and drops the answer with its call, when the asking process is gone", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const returned = vi.spyOn(kernel.ipc, "returnDelegatedResponsibility");
      const called = await call(kernel);
      // The caller was replaced, as Ship is; the ledger, not the old pid, takes the work back.
      kernel.procs.kill(CALLER);
      await kernel.ipc.completeIpcCallsForProcessSignal(TARGET, finished(called.runId, "ok", "The oven is off."));
      await runEvents(kernel);

      expect(returned).toHaveBeenCalledWith(expect.objectContaining({ callId: called.callId, status: "completed" }));
      expect(ipcEvents(kernel).find(({ type }) => type === "ipc.reply")).toMatchObject({ state: "withdrawn", last_error: "the process is gone" });
      expect(delivered(kernel, CALLER)).toEqual([]);
      expect(kernel.ipcCalls.get(called.callId)).toBeNull();
    });
  });

  it("answers a call with an error when its target is reset", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const called = await call(kernel);
      kernel.ipc.failIpcCallsByTarget(OWNER.uid, TARGET, "Target process was reset");
      await runEvents(kernel);

      expect(delivered(kernel, CALLER)[0]![2]).toMatchObject({
        event: { kind: "ipc.reply", severity: "error", payload: { callId: called.callId, error: "Target process was reset", response: null } },
      });
      expect(kernel.ipcCalls.get(called.callId)).toBeNull();
    });
  });
});
