import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionOrigin } from "@humansandmachines/gsv/protocol";
import type { InternalRequestFrame } from "../protocol/process-frames";
import type { Process } from "./do";
import { deferred, initProcess, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";

afterEach(() => vi.restoreAllMocks());

function targetEvent(eventId: string): InternalRequestFrame<"proc.event.deliver"> {
  return {
    type: "req", id: `request:${eventId}`, call: "proc.event.deliver",
    args: {
      eventId,
      event: {
        kind: "target.connection", severity: "info", audience: "model",
        payload: { targetId: "laptop", platform: "linux", event: "connected", observedAt: Date.now() },
      },
    },
  };
}

function suppressExternalWork(process: Process) {
  vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
  return vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
}

const slackOrigin: InteractionOrigin = {
  kind: "adapter", adapter: "slack", accountId: "fixture", actorId: "fixture-user",
  surface: { kind: "thread", id: "fixture-channel", threadId: "fixture-thread" },
};

describe("durable runtime continuations", () => {
  it("updates Slack destination guidance after history without writing a continuation message", async () => {
    const stub = await initProcess("history-continuation-slack-guidance", ROOT_IDENTITY);
    const successor = await runInProcess(stub, async (process: Process) => {
      suppressExternalWork(process);
      process.store.messages.appendMessage("user", "Check this from Slack.", {
        runId: "slack-run", origin: JSON.stringify(slackOrigin),
      });
      process.runs.active = { runId: "slack-run" };
      await process.controller.handleReq(targetEvent("event:slack-guidance"));
      const before = await process.history.buildContextMessages();
      expect(before).toHaveLength(2);
      expect(before[0]?.content).toContain("[Directed endpoint: this Slack thread.]");
      expect(before[1]?.content).toBe("[GSV EVENT]\nTarget `laptop` connected.");
      const records = process.store.messages.getRecords();

      await process.run.finishRun("slack-run", { reason: "run.yielded", status: "ok", resultText: null });

      const context = await process.history.buildContextMessages();
      expect(context.slice(0, -1)).toEqual(before);
      expect(context.at(-1)).toEqual({
        role: "user", content: "[Directed endpoint: this GSV process.]", timestamp: before[1]!.timestamp,
      });
      expect(await process.history.buildContextMessages()).toEqual(context);
      expect(process.store.messages.getRecords()).toEqual(records);
      expect(process.store.messages.getMessages()).toHaveLength(2);
      return process.runs.active?.runId;
    });

    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      expect(process.runs.active).toEqual({ runId: successor, continuation: true });
      expect((await process.history.buildContextMessages()).at(-1)?.content).toBe("[Directed endpoint: this GSV process.]");
      expect(process.store.messages.getRecords()).toHaveLength(2);
      process.runs.active = null;
      expect(await process.history.buildContextMessages()).toHaveLength(2);
    });
  });

  it.each(["schedule", "client"] as const)("puts continuation guidance after a later queued %s input", async (source) => {
    const stub = await initProcess(`history-continuation-later-${source}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      suppressExternalWork(process);
      process.store.messages.appendMessage("user", "Start in Slack.", {
        runId: "slack-run", origin: JSON.stringify(slackOrigin),
      });
      process.runs.active = { runId: "slack-run" };
      if (source === "schedule") {
        await process.controller.handleProcScheduleDeliver({
          scheduleId: "schedule:queued", runId: "queued-input", firedAtMs: Date.now(), message: "Send the reminder.",
          replyTo: {
            kind: "adapter", adapter: "telegram", accountId: "fixture", actorId: "fixture-user",
            surface: { kind: "dm", id: "fixture-chat" },
          },
        });
      } else {
        process.store.queue.enqueue("queued-input", "Continue from the client.", {
          origin: JSON.stringify({ kind: "client", connectionId: "fixture-client", clientId: "gsv-ui" }),
        });
      }
      await process.controller.handleIpcSignal("ipc.reply", {
        callId: `call:${source}`, sourceRunId: "earlier-run", targetPid: "worker",
        createdAt: Date.now(), response: { text: "Delegated work completed." },
      });
      expect(process.store.queue.queueSize()).toBe(2);

      await process.run.finishRun("slack-run", { reason: "run.yielded", status: "ok", resultText: null });

      expect(process.runs.active).toEqual({ runId: "queued-input" });
      const before = await process.history.buildContextMessages();
      expect(before).toHaveLength(3);
      expect(before[1]?.content).toContain("Delegated work completed.");
      expect(before[2]?.content).toContain(source === "schedule"
        ? "Reply destination: this Telegram direct message."
        : "[Directed endpoint: this GSV client.]");
      const records = process.store.messages.getRecords();

      await process.run.finishRun("queued-input", { reason: "run.yielded", status: "ok", resultText: null });

      expect(process.runs.active?.continuation).toBe(true);
      const after = await process.history.buildContextMessages();
      expect(after.slice(0, -1)).toEqual(before);
      expect(after.at(-1)?.content).toBe("[Directed endpoint: this GSV process.]");
      expect(process.store.messages.getRecords()).toEqual(records);
      expect(process.store.queue.queueSize()).toBe(0);
      process.runs.active = null;
    });
  });

  it("continues after a busy target event without adding a second history record", async () => {
    const stub = await initProcess("history-continuation-target", ROOT_IDENTITY);
    const event = targetEvent("event:continuation-target");
    const successor = await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      process.runs.active = { runId: "busy-run" };
      expect(await process.controller.handleReq(event)).toMatchObject({ ok: true, data: { runId: "busy-run" } });
      expect(await process.controller.handleReq(event)).toMatchObject({ ok: true, data: { runId: "busy-run" } });
      expect(process.runs.active).toMatchObject({ pendingRuntimeEvents: 1 });
      expect(process.store.queue.queueSize()).toBe(0);
      const records = process.store.messages.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: "event", payload: event.args.event });

      await process.run.finishRun("busy-run", { reason: "run.yielded", status: "ok", resultText: null });

      const runId = process.runs.active?.runId;
      expect(runId).toBeTypeOf("string");
      expect(runId).not.toBe("busy-run");
      expect(scheduled).toHaveBeenCalledExactlyOnceWith(runId);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getRecords()).toEqual(records);
      expect(await process.history.buildContextMessages()).toHaveLength(1);
      return runId;
    });

    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      suppressExternalWork(process);
      expect(process.runs.active).toEqual({ runId: successor, continuation: true });
      expect(await process.controller.handleReq(event)).toMatchObject({ ok: true, data: { runId: "busy-run" } });
      expect(process.store.messages.getRecords()).toHaveLength(1);
      expect(process.store.queue.queueSize()).toBe(0);
      await process.run.finishRun(successor!, { reason: "run.yielded", status: "ok", resultText: null });
      expect(process.runs.active).toBeNull();
    });
  });

  it("lets an existing queued message consume the event without creating another run", async () => {
    const stub = await initProcess("history-continuation-message", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      process.runs.active = { runId: "busy-run" };
      await process.controller.handleReq(targetEvent("event:queued-message"));
      process.store.queue.enqueue("next-message", "Continue my work.");

      await process.run.finishRun("busy-run", { reason: "run.yielded", status: "ok", resultText: null });

      expect(process.runs.active).toEqual({ runId: "next-message" });
      expect(scheduled).toHaveBeenCalledExactlyOnceWith("next-message");
      expect(process.store.queue.queueSize()).toBe(0);
      const records = process.store.messages.getRecords();
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.kind)).toEqual(["event", "message"]);
      expect(await process.history.buildContextMessages()).toHaveLength(2);

      await process.run.finishRun("next-message", { reason: "run.yielded", status: "ok", resultText: null });
      expect(process.runs.active).toBeNull();
      expect(process.store.messages.getRecords()).toEqual(records);
      expect(scheduled).toHaveBeenCalledTimes(1);
    });
  });

  it("retains an event arriving after the context snapshot for a silent successor", async () => {
    const stub = await initProcess("history-continuation-context-race", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      const epoch = process.store.epochs.createContextEpoch({
        id: "continuation-context", generation: process.store.state.getHistoryGeneration(),
        systemPrompt: "Synthetic context fixture.", r12yRevision: 0, r12yCount: 0,
        r12yBaseline: [], sourceManifest: {}, observedProjection: {}, now: Date.now(),
      });
      process.runs.active = { runId: "snapshot-run", contextEpochId: epoch.id };
      await process.controller.handleReq(targetEvent("event:before-snapshot"));
      const { promise: snapshotTaken, resolve: markSnapshotTaken } = deferred();
      const { promise: snapshotBlocked, resolve: releaseSnapshot } = deferred();
      const buildMessages = process.history.buildContextMessages.bind(process.history);
      vi.spyOn(process.history, "buildContextMessages").mockImplementationOnce(async (...args) => {
        const messages = await buildMessages(...args);
        markSnapshotTaken();
        await snapshotBlocked;
        return messages;
      });
      const building = process.run.buildRunTickContext("snapshot-run", {
        run: process.runs.active, activeConfig: terminalTestConfig(process.pid), workTools: [], tools: [],
        context: { systemPrompt: "", messages: [] }, contextState: null, autoCompactionPressure: null,
      }, { recoverResponsibilities: false, refreshProjection: false });
      await snapshotTaken;
      try {
        const lateEvent = targetEvent("event:after-snapshot");
        lateEvent.args.event.payload.targetId = "desktop";
        await process.controller.handleReq(lateEvent);
        expect(process.runs.active?.pendingRuntimeEvents).toBe(2);
      } finally {
        releaseSnapshot();
      }
      const context = await building;
      expect(context?.messages).toHaveLength(1);
      expect(JSON.stringify(context?.messages)).toContain("Target `laptop` connected.");
      expect(JSON.stringify(context?.messages)).not.toContain("desktop");
      expect(process.runs.active?.pendingRuntimeEvents).toBe(1);
      const records = process.store.messages.getRecords();
      expect(records).toHaveLength(2);

      await process.run.finishRun("snapshot-run", { reason: "run.yielded", status: "ok", resultText: null });

      expect(process.runs.active?.runId).not.toBe("snapshot-run");
      expect(scheduled).toHaveBeenCalledExactlyOnceWith(process.runs.active?.runId);
      expect(process.store.messages.getRecords()).toEqual(records);
      const nextContext = await process.history.buildContextMessages();
      expect(nextContext).toHaveLength(2);
      expect(JSON.stringify(nextContext)).toContain("Target `desktop` connected.");
      process.runs.active = null;
    });
  });

  it("keeps a cross-run IPC continuation and reply deduplication across eviction", async () => {
    const stub = await initProcess("history-continuation-ipc", ROOT_IDENTITY);
    const reply = {
      callId: "call:continuation", sourceRunId: "earlier-run", targetPid: "worker",
      createdAt: Date.now(), response: { text: "Completed the delegated work." },
    };
    await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      process.runs.active = { runId: "other-run" };
      await process.controller.handleIpcSignal("ipc.reply", reply);
      expect(process.runs.active).toEqual({ runId: "other-run" });
      expect(process.store.queue.queueSize()).toBe(1);
      expect(process.store.messages.getRecords()).toHaveLength(1);
      expect(scheduled).not.toHaveBeenCalled();
    });

    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      await process.controller.handleIpcSignal("ipc.reply", reply);
      expect(process.store.queue.queueSize()).toBe(1);
      const records = process.store.messages.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: "event", payload: { kind: "ipc.reply", payload: reply } });

      await process.run.finishRun("other-run", { reason: "run.yielded", status: "ok", resultText: null });

      expect(process.runs.active?.runId).not.toBe("other-run");
      expect(scheduled).toHaveBeenCalledExactlyOnceWith(process.runs.active?.runId);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getRecords()).toEqual(records);
      await process.controller.handleIpcSignal("ipc.reply", reply);
      expect(process.store.messages.getRecords()).toEqual(records);
      expect(process.store.queue.queueSize()).toBe(0);
      process.runs.active = null;
    });
  });

  it("promotes an old queued wake silently while preserving an already retained wake event", async () => {
    const stub = await initProcess("history-continuation-upgrade", ROOT_IDENTITY);
    const oldText = "A runtime event arrived while you were busy. Review the GSV event above.";
    const oldEvent = {
      kind: "event" as const,
      payload: {
        kind: "runtime.wake" as const, payload: { source: "process", reason: "pending-events", pendingEvents: 1 },
        severity: "info" as const, audience: "model" as const,
      },
    };
    const original = await runInProcess(stub, (process: Process) => {
      process.store.messages.appendMessage("system", oldText, { runId: "historical-run", record: oldEvent });
      process.store.queue.enqueue("pre-upgrade-wake", oldText, { role: "system", kind: "runtime.wake", record: oldEvent });
      return process.store.messages.getRecords();
    });

    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      const scheduled = suppressExternalWork(process);
      expect(await process.controller.promoteNextQueuedRun()).toBe("pre-upgrade-wake");
      expect(process.runs.active).toEqual({ runId: "pre-upgrade-wake", continuation: true });
      expect(scheduled).toHaveBeenCalledExactlyOnceWith("pre-upgrade-wake");
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getRecords()).toEqual(original);
      expect(process.store.messages.getMessages()[0]?.content).toBe(oldText);
      process.runs.active = null;
    });
  });

  it.each(["reset", "kill"] as const)("clears a queued continuation on %s across eviction", async (action) => {
    const stub = await initProcess(`history-continuation-${action}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      suppressExternalWork(process);
      process.store.queue.enqueueContinuation("discarded-continuation");
      expect(process.store.queue.queueSize()).toBe(1);
      if (action === "reset") await process.controller.handleProcReset();
      else await process.controller.handleProcKill({ archive: false });
      if (action === "reset") {
        expect(process.store.queue.queueSize()).toBe(0);
        expect(process.runs.active).toBeNull();
      } else {
        expect(process.store.sql.exec("SELECT name FROM sqlite_master WHERE name = 'message_queue'").toArray()).toEqual([]);
        expect(process.killed).toBe(true);
      }
    });

    await evictDurableObject(stub);
    await runInProcess(stub, (process: Process) => {
      if (action === "reset") {
        expect(process.store.queue.queueSize()).toBe(0);
        expect(process.controller.claimNextQueuedRun()).toBeNull();
        expect(process.runs.active).toBeNull();
      } else {
        expect(process.store.sql.exec("SELECT name FROM sqlite_master WHERE name = 'message_queue'").toArray()).toEqual([]);
      }
      expect(process.isInitialized()).toBe(action === "reset");
    });
  });
});
