import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { procHistoryEventSchema } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { InternalRequestFrame } from "../protocol/process-frames";
import { decodeWireFrameJson } from "../protocol/decode-wire-frame";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
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
      expect(messages[0]?.content).toContain('[GSV EVENT]\nTarget "My laptop" disconnected.');
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
