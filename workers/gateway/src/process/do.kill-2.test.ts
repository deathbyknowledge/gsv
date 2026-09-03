import type { ProcessResourceWriteRequestFrame } from "../protocol/process-frames";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, deferred, runInProcess, ROOT_IDENTITY, initProcess, makeReq, type ProcessTestValue,
} from "./do-test-harness";

describe("proc.kill", () => {
  it("delivers persisted output media before deleting live process media", async () => {
    const pid = "mech-kill-finish-media-order";
    const runId = "run-kill-finish-media-order";
    const key = `var/media/0/${pid}/scratch.png`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const uploaded = await stub.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.resource.write",
      args: {
        resourceId: "reply.png",
        mediaType: "image",
        contentType: "image/png",
      },
      body: bodyFromBytes(new Uint8Array([7, 8, 9])),
    } satisfies ProcessResourceWriteRequestFrame);
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    const resource = uploaded.data.resource;
    await env.STORAGE.put(key, new Uint8Array([7, 8, 9]), {
      httpMetadata: { contentType: "image/png" },
    });

    const result = await runInProcess(stub, async (process) => {
      const media = [
        {
          type: "image",
          mimeType: "image/png",
          key: resource.ref.path.replace(/^\/+/, ""),
          path: resource.ref.path,
          size: resource.ref.size,
          revision: resource.ref.revision,
        },
      ];
      let mediaPresentDuringFinish = false;
      let finishPayload: any = null;
      const { promise: finishBlocked, resolve: releaseFinish } = deferred();
      const { promise: finishStarted, resolve: markFinishStarted } = deferred();
      process.runs.active = {
        runId,
        outputMedia: media,
        outputMediaPersisted: true,
      };
      process.sendSignal = vi.fn(async (signal: string, payload: ProcessTestValue) => {
        if (signal === "proc.run.finished") {
          finishPayload = payload;
          mediaPresentDuringFinish = (await process.env.STORAGE.head(key)) !== null;
          markFinishStarted();
          await finishBlocked;
        }
      });

      const first = process.recvFrame(makeReq("proc.kill", { archive: false }));
      await finishStarted;
      const second = process.recvFrame(makeReq("proc.kill", { archive: false }));
      const mediaPresentDuringRetry = (await process.env.STORAGE.head(key)) !== null;
      releaseFinish();
      const responses = await Promise.all([first, second]);
      return {
        responses,
        finishPayload,
        mediaPresentDuringFinish,
        mediaPresentDuringRetry,
      };
    });

    expect(result.responses[0]).toMatchObject({ ok: true, data: { ok: true, pid } });
    expect(result.responses[1].data).toEqual(result.responses[0].data);
    expect(result.mediaPresentDuringFinish).toBe(true);
    expect(result.mediaPresentDuringRetry).toBe(true);
    expect(result.finishPayload).toMatchObject({
      pid,
      runId,
      result: {
        media: [{ type: "resource", ref: { path: resource.ref.path } }],
      },
    });
    expect(await env.STORAGE.head(key)).toBeNull();
    expect(await env.STORAGE.head(resource.ref.path.replace(/^\/+/, ""))).not.toBeNull();
  });

  it("finishes the active run and leaves the executor empty and dead", async () => {
    const pid = "mech-kill-runtime";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const runId = "run-kill-runtime";

    const killed = await runInProcess(stub, async (process, state) => {
      const emitted = captureSignals(process);
      process.runs.active = { runId };
      process.store.tools.register("dispatch-kill-1", "call-kill-1", runId, "fs.read", {
        path: "/tmp/test.txt",
      });
      process.store.tools.markDispatched("dispatch-kill-1");
      process.store.queue.enqueue("queued-kill", "queued before kill");
      process.store.messages.appendMessage("user", "hello before kill");
      await state.storage.setAlarm(Date.now() + 60_000);

      const response = await process.recvFrame(makeReq("proc.kill", { archive: false }));
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
      return {
        response,
        emitted,
        alarm: await state.storage.getAlarm(),
        tables,
        keys: [...(await state.storage.list()).keys()],
      };
    });

    expect(killed.response).toMatchObject({
      ok: true,
      data: {
        ok: true,
        pid,
        archivedMessages: 0,
        archives: [],
      },
    });
    expect(killed.emitted).toContainEqual({
      signal: "proc.run.finished",
      payload: expect.objectContaining({
        pid,
        runId,
        status: "aborted",
        reason: "process.kill",
        aborted: true,
        queuedCount: 0,
      }),
    });
    expect(killed.emitted.map(({ signal }) => signal)).toEqual([
      "proc.run.tool.finished",
      "proc.run.finished",
    ]);
    expect(killed.emitted[0]).toEqual({
      signal: "proc.run.tool.finished",
      payload: {
        pid,
        runId,
        executionId: "dispatch-kill-1",
        callId: "call-kill-1",
        outcome: "cancelled",
        timestamp: expect.any(Number),
      },
    });
    expect(killed.alarm).toBeNull();
    expect(killed.keys).toEqual(["__gsv_process_killed__"]);
    expect(killed.tables).not.toEqual(
      expect.arrayContaining(["conversations", "messages", "process_kv"]),
    );

    const reuse = await stub.recvFrame(makeReq("proc.setidentity", { identity: ROOT_IDENTITY }));
    expect(reuse).toMatchObject({
      ok: false,
      error: { code: 410, message: "Process no longer exists" },
    });
  });

  it("keeps a killed pid dead after Durable Object eviction", async () => {
    const pid = "mech-kill-eviction";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await expect(
      stub.recvFrame(makeReq("proc.kill", { pid, archive: false })),
    ).resolves.toMatchObject({
      ok: true,
      data: { ok: true, pid },
    });

    await evictDurableObject(stub);

    await expect(
      stub.recvFrame(makeReq("proc.kill", { pid, archive: false })),
    ).resolves.toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 0, archives: [] },
    });

    await expect(
      stub.recvFrame(makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 410, message: "Process no longer exists" },
    });
    await expect(
      runInProcess(stub, (process, state) => ({
        // SAFETY: test fixture is constructed with the asserted domain shape.
        killed: process.killed,
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
        tables: state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name),
      })),
    ).resolves.toEqual({
      killed: true,
      tombstone: expect.objectContaining({
        version: 1,
        pid,
        cleanup: "completed",
        result: expect.objectContaining({ ok: true, pid }),
      }),
      tables: expect.not.arrayContaining(["conversations", "messages", "process_kv"]),
    });
  });

  it("rolls back the storage wipe when the terminal commit fails", async () => {
    const pid = "mech-kill-atomic-rollback";
    const runId = "run-kill-atomic-rollback";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const alarmAt = Date.now() + 60_000;

    const failed = await runInProcess(stub, async (process, state) => {
      process.runs.active = { runId };
      process.store.messages.appendMessage("user", "survive the failed kill", { runId });
      process.store.queue.enqueue("queued-after-failed-kill", "queued work must survive");
      process.store.tools.register(
        "dispatch-terminal-failure",
        "call-terminal-failure",
        runId,
        "fs.read",
        { path: "/tmp/terminal" },
      );
      process.store.tools.setPendingHil({
        requestId: "hil-terminal-failure",
        runId,
        toolCallId: "call-terminal-failure",
        toolName: "Read",
        syscall: "fs.read",
        args: { path: "/tmp/terminal" },
        createdAt: Date.now(),
      });
      process.sendSignal = vi.fn(async () => {});
      state.storage.kv.put("kill-rollback-sentinel", "present");
      await state.storage.setAlarm(alarmAt);

      const realTransactionSync = state.storage.transactionSync.bind(state.storage);
      const transactionSpy = vi
        .spyOn(state.storage, "transactionSync")
        .mockImplementation((closure) =>
          realTransactionSync(() => {
            closure();
            throw new Error("injected terminal commit failure");
          }),
        );
      let response;
      try {
        response = await process.recvFrame(makeReq("proc.kill", { pid, archive: false }));
      } finally {
        transactionSpy.mockRestore();
      }

      return {
        response,
        killed: process.killed,
        alarm: await state.storage.getAlarm(),
        sentinel: state.storage.kv.get("kill-rollback-sentinel"),
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
        queueSize: process.store.queue.queueSize(),
        currentRun: process.runs.active,
        tools: process.store.tools.getResults(runId),
        pendingHil: process.store.tools.getPendingHilForRun(runId),
        finishCalls: process.sendSignal.mock.calls.length,
        tables: state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name),
      };
    });

    expect(failed).toMatchObject({
      response: {
        ok: false,
        error: { message: "injected terminal commit failure" },
      },
      killed: false,
      alarm: alarmAt,
      sentinel: "present",
      tombstone: undefined,
      queueSize: 1,
      currentRun: { runId },
      tools: [
        expect.objectContaining({
          dispatchId: "dispatch-terminal-failure",
          status: "registered",
        }),
      ],
      pendingHil: { requestId: "hil-terminal-failure", runId },
      finishCalls: 0,
      tables: expect.arrayContaining(["messages", "process_kv"]),
    });

    await evictDurableObject(stub);
    const recovered = await runInProcess(stub, (process) => {
      return {
        messages: process.store.messages.getMessages(),
        queueSize: process.store.queue.queueSize(),
        currentRun: process.runs.active,
        tools: process.store.tools.getResults(runId),
        pendingHil: process.store.tools.getPendingHilForRun(runId),
      };
    });
    expect(recovered.messages).toEqual([
      expect.objectContaining({ content: "survive the failed kill" }),
    ]);
    expect(recovered.queueSize).toBe(1);
    expect(recovered.currentRun).toMatchObject({ runId });
    expect(recovered.tools).toEqual([
      expect.objectContaining({
        dispatchId: "dispatch-terminal-failure",
        status: "registered",
      }),
    ]);
    expect(recovered.pendingHil).toMatchObject({
      requestId: "hil-terminal-failure",
      runId,
    });

    await expect(
      stub.recvFrame(makeReq("proc.kill", { pid, archive: false })),
    ).resolves.toMatchObject({
      ok: true,
      data: { ok: true, pid },
    });
    await evictDurableObject(stub);
    await expect(
      stub.recvFrame(makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 410, message: "Process no longer exists" },
    });
  });
});
