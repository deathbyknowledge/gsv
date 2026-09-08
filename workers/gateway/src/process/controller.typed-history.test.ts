import { describe, expect, it, vi } from "vitest";
import {
  procHistoryRecordDataSchema, type ProcHistoryRecordData, type ProcIpcDeliverArgs,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { ProcessScheduleDeliverArgs } from "../protocol/process-frames";
import {
  initProcess, ROOT_IDENTITY, runInProcess,
} from "./do-test-harness";

function storedRecords(process: Process): ProcHistoryRecordData[] {
  return process.store.sql.exec<{ kind: string; payload_json: string }>(
    "SELECT kind, payload_json FROM messages ORDER BY id",
  ).toArray().map((row) => procHistoryRecordDataSchema.parse({
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
  }));
}

function isolateAdmission(process: Process): void {
  vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
  vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
  vi.spyOn(process, "maybeStartTaskTitleGeneration").mockImplementation(() => {});
}

describe("typed controller history producers", () => {
  it("retains canonical interaction identity on direct and queued input", async () => {
    const stub = await initProcess("typed-input-origin", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      const directInteraction = { conversationId: "conversation-1", messageId: "message-1" };
      await process.controller.handleProcSend({
        message: "Direct input",
        origin: { kind: "client", connectionId: "client-1" },
        interaction: directInteraction,
      }, "direct-run");
      const queuedInteraction = { conversationId: "conversation-2", messageId: "message-2" };
      await process.controller.handleProcSend({
        message: "Queued input",
        origin: { kind: "process", sourcePid: "parent-1" },
        interaction: queuedInteraction,
      }, "queued-run");

      expect(process.store.queue.queueSize()).toBe(1);
      process.runs.active = null;
      process.controller.claimNextQueuedRun();
      expect(storedRecords(process)).toMatchObject([
        {
          kind: "message",
          payload: {
            direction: "in",
            text: "Direct input",
            conversationId: "conversation-1",
            conversationMessageId: "message-1",
            origin: {
              kind: "conversation.message",
              interaction: { kind: "client", connectionId: "client-1" },
              provenance: directInteraction,
            },
          },
        },
        {
          kind: "message",
          payload: {
            direction: "in",
            text: "Queued input",
            conversationId: "conversation-2",
            conversationMessageId: "message-2",
            origin: {
              kind: "conversation.message",
              interaction: { kind: "process", sourcePid: "parent-1" },
              provenance: queuedInteraction,
            },
          },
        },
      ]);
      process.runs.active = null;
      await process.controller.handleProcSend({
        message: "Immediate background input",
        origin: { kind: "process", sourcePid: "parent-1" },
        interaction: { conversationId: "conversation-3", messageId: "message-3" },
      }, "immediate-background-run");
      expect(storedRecords(process).at(-1)).toMatchObject({
        kind: "message",
        payload: { conversationId: "conversation-3", conversationMessageId: "message-3" },
      });
    });
  });

  it("retains IPC source data through queue promotion", async () => {
    const stub = await initProcess("typed-ipc-origin", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      const delivery: ProcIpcDeliverArgs = {
        runId: "ipc-run-1",
        sourcePid: "parent-1",
        source: ROOT_IDENTITY,
        message: "Research the queue contract",
        metadata: { priority: "normal" },
        sentAt: 1_000,
      };
      await process.controller.handleProcIpcDeliver(delivery);
      await process.controller.handleProcIpcDeliver({ ...delivery, runId: "ipc-run-2" });
      process.runs.active = null;
      process.controller.claimNextQueuedRun();
      const records = storedRecords(process);
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record).toMatchObject({
          kind: "message",
          payload: {
            origin: {
              interaction: { kind: "process", sourcePid: "parent-1", uid: 0 },
              provenance: {
                source: "process",
                eventType: "ipc.message",
                delivery: {
                  sourcePid: delivery.sourcePid,
                  source: ROOT_IDENTITY,
                  message: delivery.message,
                  metadata: delivery.metadata,
                  sentAt: delivery.sentAt,
                },
              },
            },
          },
        });
      }
      expect(process.store.messages.getMessages()[0]?.content).toContain("Message from root (parent-1).");
    });
  });

  it("preserves typed schedules across direct admission and durable queue promotion", async () => {
    const stub = await initProcess("typed-schedule-queue", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      const event = {
        runId: "schedule-run-1",
        scheduleId: "schedule-1",
        scheduleName: "nightly",
        message: "Inspect the machines",
        data: { machine: "laptop" },
        scheduledAtMs: 1_000,
        firedAtMs: 2_000,
      };
      await process.controller.handleProcScheduleDeliver(event);
      const queuedEvent: ProcessScheduleDeliverArgs = {
        ...event,
        runId: "schedule-run-2",
        replyTo: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "primary",
          surface: { kind: "dm", id: "chat-1" },
          actorId: "actor-1",
        },
      };
      await process.controller.handleProcScheduleDeliver(queuedEvent);
      expect(process.store.queue.queueSize()).toBe(1);
      process.runs.active = null;
      process.controller.claimNextQueuedRun();
      expect(storedRecords(process)).toEqual([event, queuedEvent].map((payload) => ({
        kind: "event",
        payload: { kind: "schedule.fired", payload, severity: "info", audience: "model" },
      })));
      expect(process.store.messages.getMessages()[0]?.content).toContain("Scheduled event `nightly` fired.");
    });
  });

  it("records adapter work return as structured data after queueing", async () => {
    const stub = await initProcess("typed-work-return", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      process.runs.active = { runId: "busy-run" };
      await process.controller.handleProcessRuntimeEventDeliver({
        eventId: "work-return-1",
        event: { type: "adapter.work.returned", workPid: "work-1" },
      });
      process.runs.active = null;
      process.controller.claimNextQueuedRun();
      expect(storedRecords(process)).toEqual([{
        kind: "event",
        payload: {
          kind: "adapter.work.returned",
          payload: { eventId: "work-return-1", workPid: "work-1" },
          severity: "info",
          audience: "model",
        },
      }]);
    });
  });

  it("records watched signal fields without treating transport metadata as event payload", async () => {
    const stub = await initProcess("typed-watched-signal", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      await process.controller.handleSig({
        type: "sig",
        signal: "machine.changed",
        payload: {
          watched: true,
          sourcePid: "machine-1",
          watch: { key: "status", state: { online: true } },
          payload: { online: false },
          transportField: "ignored",
        },
      });
      expect(storedRecords(process)).toEqual([{
        kind: "event",
        payload: {
          kind: "signal.watched",
          payload: {
            signal: "machine.changed",
            sourcePid: "machine-1",
            watch: { key: "status", state: { online: true } },
            payload: { online: false },
          },
          severity: "info",
          audience: "model",
        },
      }]);
    });
  });

  it.each(["ipc.reply", "ipc.overdue", "ipc.timeout"])(
    "persists %s data and the queued wake independently",
    async (signal) => {
      const stub = await initProcess(`typed-${signal}`, ROOT_IDENTITY);
      await runInProcess(stub, async (process: Process) => {
        isolateAdmission(process);
        process.runs.active = { runId: "another-run" };
        const payload = {
          callId: "call-1",
          targetPid: "child-1",
          sourceRunId: "origin-run",
          checkInCount: 2,
          response: { text: "Work complete", artifact: { path: "/result.txt" } },
        };
        await process.controller.handleIpcSignal(signal, payload);
        await process.controller.handleIpcSignal(signal, payload);
        expect(process.store.queue.queueSize()).toBe(1);
        process.runs.active = null;
        process.controller.claimNextQueuedRun();
        expect(storedRecords(process)).toEqual([
          {
            kind: "event",
            payload: {
              kind: signal,
              payload,
              severity: signal === "ipc.timeout" ? "error" : "info",
              audience: "model",
            },
          },
          {
            kind: "event",
            payload: {
              kind: "runtime.wake",
              payload: { source: "process", reason: signal },
              severity: "info",
              audience: "model",
            },
          },
        ]);
      });
    },
  );

  it("persists a delivery failure exactly once with severity and audience", async () => {
    const stub = await initProcess("typed-delivery-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      const notice = { noticeId: "notice-1", runId: "run-1", message: "Provider rejected delivery" };
      await process.controller.handleSig({ type: "sig", signal: "proc.delivery.notice", payload: notice });
      await process.controller.handleSig({ type: "sig", signal: "proc.delivery.notice", payload: notice });
      expect(storedRecords(process)).toEqual([{
        kind: "event",
        payload: {
          kind: "delivery.failed",
          payload: { phase: "message", noticeId: notice.noticeId, runId: notice.runId, error: notice.message },
          severity: "error",
          audience: "both",
        },
      }]);
    });
  });

  it("records scheduling failure from the original error", async () => {
    const stub = await initProcess("typed-scheduling-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      isolateAdmission(process);
      vi.mocked(process.run.scheduleTick).mockRejectedValue(new Error("alarm unavailable"));
      process.runs.active = { runId: "run-1" };
      await process.controller.scheduleRunOrFinish("run-1", "Failed to schedule process run");
      expect(storedRecords(process)).toEqual([{
        kind: "event",
        payload: {
          kind: "runtime.failed",
          payload: {
            reason: "schedule.error",
            error: "alarm unavailable",
            prefix: "Failed to schedule process run",
          },
          severity: "error",
          audience: "both",
        },
      }]);
      expect(process.store.messages.getMessages()[0]?.content).toBe(
        "Failed to schedule process run: alarm unavailable",
      );
    });
  });
});
