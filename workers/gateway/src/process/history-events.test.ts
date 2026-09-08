import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { procHistoryEventSchema } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { InternalRequestFrame } from "../protocol/process-frames";
import { decodeWireFrameJson } from "../protocol/decode-wire-frame";
import { deferred, initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { PROCESS_RESET_AT_KEY } from "./internal/lifecycle";

afterEach(() => vi.restoreAllMocks());

function request(eventId: string, audience: "model" | "person" | "both" = "person"): InternalRequestFrame<"proc.event.deliver"> {
  return {
    type: "req", id: `request:${eventId}`, call: "proc.event.deliver", args: {
      eventId, event: {
        kind: "target.connection", severity: "info", audience,
        payload: { targetId: "laptop", label: "My laptop", platform: "linux", event: "disconnected", observedAt: 1000 },
      },
    },
  };
}

describe("registered Process events", () => {
  it("delivers and deduplicates an idle notice across eviction without a model run", async () => {
    const stub = await initProcess("history-events-notice", ROOT_IDENTITY);
    const first = await stub.recvFrame(request("event:first"));
    expect(first).toMatchObject({ ok: true, data: { eventId: "event:first", runId: null, queued: false, messageId: 1 } });
    await evictDurableObject(stub);
    expect(await stub.recvFrame(request("event:first"))).toEqual(first);
    await runInProcess(stub, async (process: Process) => {
      expect(process.runs.active).toBeNull();
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getRecords()).toHaveLength(1);
      expect(process.store.messages.getRecords()[0]).toMatchObject({ kind: "event", payload: request("event:first").args.event });
      expect(await process.history.buildContextMessages()).toEqual([]);
      const history = await process.controller.handleProcHistory({ format: 2 });
      expect(history).toMatchObject({ historyRevision: 1, messageCount: 1 });
    });
  });

  it("leaves active-run state unchanged for a person notice", async () => {
    const stub = await initProcess("history-events-active-notice", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId: "active", pendingRuntimeEvents: 3 };
      const active = process.runs.active;
      const schedule = vi.spyOn(process.controller, "scheduleRunOrFinish");
      const result = await process.controller.handleReq(request("event:busy"));
      expect(result).toMatchObject({ ok: true, data: { runId: null, queued: false } });
      expect(process.runs.active).toEqual(active);
      expect(schedule).not.toHaveBeenCalled();
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getRecords()[0]?.runId).toBeNull();
    });
  });

  it.each(["model", "both"] as const)("admits %s events through the existing runtime wake path once", async (audience) => {
    const stub = await initProcess(`history-events-${audience}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const schedule = vi.spyOn(process.controller, "scheduleRunOrFinish").mockResolvedValue(true);
      const frame = request(`event:${audience}`, audience);
      expect(await process.controller.handleReq(frame)).toMatchObject({ ok: true, data: { runId: frame.args.eventId, queued: false } });
      expect(await process.controller.handleReq(frame)).toMatchObject({ ok: true, data: { runId: frame.args.eventId, queued: false } });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(process.store.messages.getRecords()).toHaveLength(1);
      const messages = await process.history.buildContextMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe([
        "[GSV EVENT]",
        "[Directed endpoint: this GSV process.]",
        "Target `laptop` disconnected.",
      ].join("\n"));
    });
  });

  it.each(["person", "model", "both"] as const)("rejects %s events during reset archival and admits the same event afterward", async (audience) => {
    const stub = await initProcess(`history-events-reset-archive-${audience}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      const archiveHistoryMessages = process.history.archiveHistoryMessages.bind(process.history);
      vi.spyOn(process.history, "archiveHistoryMessages").mockImplementation(async (archiveId) => {
        markArchiveStarted();
        await archiveBlocked;
        return await archiveHistoryMessages(archiveId);
      });
      const schedule = vi.spyOn(process.controller, "scheduleRunOrFinish").mockResolvedValue(true);
      process.store.messages.appendMessage("user", "before reset");
      const originalRecords = process.store.messages.getRecords();
      const resetting = process.controller.handleProcReset();
      await archiveStarted;
      const resetAt = Number(process.store.state.getValue(PROCESS_RESET_AT_KEY));
      const frame = request(`event:reset-archive:${audience}`, audience);
      frame.args.event.payload.observedAt = resetAt + 1;
      try {
        expect(resetAt).toBeGreaterThan(0);
        expect(process.lifecyclePhase).toBe("resetting");
        expect(process.isInitialized()).toBe(false);
        expect(await process.recvFrame(frame)).toMatchObject({
          ok: false, error: { code: 409, message: "Process lifecycle is resetting" },
        });
        expect(await process.controller.handleReq(frame)).toMatchObject({
          ok: false, error: { message: "Process no longer exists" },
        });
        expect(process.store.messages.getRecords()).toEqual(originalRecords);
        expect(process.store.state.getValue("eventNoticeReceipts")).toBeNull();
        expect(process.controller.runtimeEventAdmission(frame.args.eventId)).toBeNull();
        expect(process.store.queue.queueSize()).toBe(0);
        expect(process.runs.active).toBeNull();
        expect(schedule).not.toHaveBeenCalled();
      } finally {
        releaseArchive();
      }
      const reset = await resetting;
      expect(reset).toMatchObject({ ok: true, archivedMessages: 1 });
      if (!reset.ok || !reset.archivedTo) throw new Error("Reset did not archive its original history");
      expect(await process.history.readArchivedMessageRecords(reset.archivedTo)).toMatchObject([
        { role: "user", content: "before reset" },
      ]);
      expect(process.isInitialized()).toBe(true);
      expect(process.store.messages.getRecords()).toEqual([]);

      const stale = request(`event:stale-before-reset:${audience}`, audience);
      stale.args.event.payload.observedAt = resetAt;
      expect(await process.recvFrame(stale)).toMatchObject({
        ok: true, data: { eventId: stale.args.eventId, ignored: true, runId: null, queued: false },
      });
      expect(process.store.messages.getRecords()).toEqual([]);
      expect(process.store.state.getValue("eventNoticeReceipts")).toBeNull();
      expect(process.controller.runtimeEventAdmission(stale.args.eventId)).toBeNull();
      expect(schedule).not.toHaveBeenCalled();

      const delivered = await process.recvFrame(frame);
      expect(delivered).toMatchObject({
        ok: true, data: { eventId: frame.args.eventId, runId: audience === "person" ? null : frame.args.eventId, queued: false },
      });
      expect(await process.recvFrame(frame)).toEqual(delivered);
      expect(process.store.messages.getRecords()).toMatchObject([
        { kind: "event", payload: frame.args.event },
      ]);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(schedule).toHaveBeenCalledTimes(audience === "person" ? 0 : 1);
      expect(process.runs.active?.runId ?? null).toBe(audience === "person" ? null : frame.args.eventId);
      expect(await process.history.buildContextMessages()).toHaveLength(audience === "person" ? 0 : 1);
    });
  });

  it("rejects stale transitions after reset and preserves killed-process terminal state", async () => {
    const stub = await initProcess("history-events-reset", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.store.state.setValue(PROCESS_RESET_AT_KEY, "1000");
      process.store.resetHistory();
      expect(await process.controller.handleReq(request("event:stale"))).toMatchObject({ ok: true, data: { ignored: true, runId: null } });
      expect(process.store.messages.messageCount()).toBe(0);
      const future = request("event:current");
      future.args.event.payload.observedAt = 1001;
      expect(await process.controller.handleReq(future)).toMatchObject({ ok: true, data: { messageId: 1 } });
      await process.controller.handleProcKill({ archive: false });
    });
    await evictDurableObject(stub);
    expect(await stub.recvFrame(request("event:killed"))).toMatchObject({ ok: false });
  });

  it("validates registered payloads and keeps event delivery off the public wire", async () => {
    const frame = request("event:private");
    expect(() => decodeWireFrameJson(JSON.stringify(frame))).toThrow();
    expect(() => procHistoryEventSchema.parse({ ...frame.args.event, payload: { targetId: "spoofed" } })).toThrow();
    const stub = await initProcess("history-events-invalid", ROOT_IDENTITY);
    const invalid = { ...frame, args: { ...frame.args, event: { ...frame.args.event, severity: "error" } } };
    // SAFETY: malformed internal frame deliberately tests the Process admission boundary.
    const result = await stub.recvFrame(invalid as InternalRequestFrame<"proc.event.deliver">);
    expect(result).toMatchObject({ ok: false });
    await runInProcess(stub, (process: Process) => expect(process.store.messages.messageCount()).toBe(0));
  });
});
