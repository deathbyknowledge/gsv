import type {
  ProcessAdapterDeliverArgs, ProcessResourceWriteRequestFrame, ProcessResourcesRetainRequestFrame,
} from "../protocol/process-frames";
import { REQUEST_CANCEL_SIGNAL, bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  generationRun, processTestConfig, assistantResponse, deferred, okProcessResponse, runInProcess,
  ROOT_IDENTITY, drainProcessQueue, initProcess, makeAdapterDeliverReq, makeReq, offeredTools,
  testUsage, waitForRunComplete, type ProcessTestValue,
} from "./do-test-harness";

describe("proc.send", () => {
  it("reconciles repeated adapter deliveries without duplicating admission", async () => {
    const pid = "mech-adapter-delivery-idempotent";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const args: ProcessAdapterDeliverArgs = {
      runId: "run-adapter-idempotent",
      pid,
      message: "retry-safe inbound message",
      origin: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "primary",
        surface: { kind: "dm", id: "telegram-chat-1" },
        actorId: "telegram-user-1",
        messageId: "telegram-message-1",
      },
    };

    const firstRequest = makeAdapterDeliverReq(args);
    const first = await stub.recvFrame(firstRequest);
    expect(first).toMatchObject({
      type: "res",
      id: firstRequest.id,
      ok: true,
      data: {
        ok: true,
        status: "started",
        runId: args.runId,
      },
    });

    const repeatedRequest = makeAdapterDeliverReq(args);
    const repeated = await stub.recvFrame(repeatedRequest);
    expect(repeated).toMatchObject({
      type: "res",
      id: repeatedRequest.id,
      ok: true,
      data: {
        replayed: "active",
      },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((first as any).data).not.toHaveProperty("replayed");

    await runInProcess(stub, (process) => {
      expect(process.store.messages.getMessages()).toEqual([
        expect.objectContaining({
          role: "user",
          content: args.message,
          runId: args.runId,
        }),
      ]);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.runs.active).toMatchObject({ runId: args.runId });
    });

    await runInProcess(stub, (process) => {
      process.runs.active = null;
    });
    const recordedRequest = makeAdapterDeliverReq(args);
    const recorded = await stub.recvFrame(recordedRequest);
    expect(recorded).toMatchObject({
      type: "res",
      id: recordedRequest.id,
      ok: true,
      data: {
        ok: true,
        runId: args.runId,
        replayed: "recorded",
      },
    });
  });

  it("queues process messages and preserves their run ids", async () => {
    const pid = "mech-send-queued";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    // Start first run
    const res1 = await okProcessResponse(
      stub,
      makeReq("proc.send", { message: "First message" }),
    );
    expect(res1.ok).toBe(true);

    // Send second message while run is active — should be queued
    const res2 = await okProcessResponse(
      stub,
      makeReq("proc.send", {
        message: "Second message",
        origin: { kind: "process", sourcePid: "child" },
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((res2.data as any).queued).toBe(true);

    // Fire alarm for run 1 — fails (no AI binding in tests), finishRun dequeues
    // "Second message" and starts run 2
    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub);

    // Fire alarm for run 2 — fails again, finishRun finds empty queue, done
    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub);

    await runInProcess(stub, (process) => {
      const store = process.store;
      const msgs = store.messages.getMessages();
      const userMsgs = msgs.filter((m: any) => m.role === "user");
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs[0].content).toBe("First message");
      expect(userMsgs[1].content).toBe("Second message");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect(userMsgs[0].runId).toBe((res1.data as any).runId);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect(userMsgs[1].runId).toBe((res2.data as any).runId);
      expect(store.queue.queueSize()).toBe(0);
      expect(store.state.getValue("currentRun")).toBeNull();
    });
  });

  it("coalesces overlapping ticks onto the next durable generation", async () => {
    const stub = await initProcess("mech-single-active-tick", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: blocked, resolve: releaseTick } = deferred();
      const { promise: started, resolve: markTickStarted } = deferred();
      const { promise: completed, resolve: markTickCompleted } = deferred();
      process.run.runTick = vi.fn(async () => {
        markTickStarted();
        await blocked;
        markTickCompleted();
      });
      process.run.schedule = vi.fn(async () => ({ id: "next-tick" }));
      process.runs.active = { runId: "run-once" };

      const first = process.run.tick({ runId: "run-once", generation: 0 });
      await started;
      await process.run.tick({ runId: "run-once", generation: 0 });
      await process.run.tick({ runId: "run-once", generation: 1 });
      expect(process.run.runTick).toHaveBeenCalledTimes(1);

      releaseTick();
      await Promise.all([first, completed]);
      await vi.waitFor(() =>
        expect(process.run.schedule).toHaveBeenCalledWith(
          expect.any(Date),
          "tick",
          { runId: "run-once", generation: 2 },
          { idempotent: true },
        ),
      );
      process.runs.active = null;
    });
  });

  it("terminalizes an uncaught background tick failure", async () => {
    const stub = await initProcess("mech-tick-failure", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.runs.active = { runId: "run-failure" };
      process.run.runTick = vi.fn(async () => {
        throw new Error("kernel unavailable");
      });

      await process.run.tick({ runId: "run-failure", generation: 0 });
      await vi.waitFor(() => {
        expect(process.runs.active).toBeNull();
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.finished",
          expect.objectContaining({
            runId: "run-failure",
            status: "error",
            reason: "tick.error",
          }),
        );
      });
    });
  });

  it("keeps user takeover authoritative when successor scheduling fails", async () => {
    const pid = "mech-send-takeover-schedule-failure";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });
      process.store.messages.appendMessage("assistant", "", {
        runId: "run-old",
        toolCalls: JSON.stringify([
          { type: "toolCall", id: "call-old", name: "Read", arguments: { path: "/slow" } },
        ]),
      });
      process.store.tools.register("dispatch-old", "call-old", "run-old", "fs.read", {
        path: "/slow",
      });
      process.runs.active = { runId: "run-old" };

      const result = await process.controller.handleProcSend({
        message: "new direction",
        origin: { kind: "client", connectionId: "client-1" },
      });
      expect(result).toMatchObject({ ok: true, status: "started" });
      await vi.waitFor(() => expect(process.runs.active).toBeNull());

      expect(process.store.messages.getMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "toolResult", toolCallId: "call-old" }),
          expect.objectContaining({
            role: "user",
            content: "new direction",
            runId: result.runId,
          }),
          expect.objectContaining({
            role: "system",
            runId: result.runId,
            content: expect.stringContaining("scheduler unavailable"),
          }),
        ]),
      );
    });
  });

  it("does not resurrect a process when teardown wins asynchronous send preparation", async () => {
    const stub = await initProcess("mech-send-after-kill", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: preparationBlocked, resolve: releasePreparation } = deferred();
      const { promise: preparationStarted, resolve: markPreparationStarted } = deferred();
      process.resources.resolveIncomingMedia = vi.fn(async () => {
        markPreparationStarted();
        await preparationBlocked;
        return [];
      });
      const sending = process.controller.handleProcSend({
        message: "too late",
        origin: { kind: "client", connectionId: "client-1" },
      });
      await preparationStarted;
      process.store.state.deleteValue("identity");
      releasePreparation();

      await expect(sending).resolves.toEqual({
        ok: false,
        error: "Process no longer exists",
      });
      expect(process.runs.active).toBeNull();
    });
  });

  it("terminalizes a generated tool block and ignores its late result", async () => {
    const pid = "mech-send-live-tool-takeover";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: dispatchBlocked, resolve: releaseDispatch } = deferred();
      const { promise: dispatchStarted, resolve: markDispatchStarted } = deferred();
      let oldDispatchId = "";

      process.sendSignal = vi.fn();
      process.run.schedule = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
        oldDispatchId = dispatchId;
        markDispatchStarted();
        await dispatchBlocked;
      });
      process.generation = {
        async generate() {
          return assistantResponse([
              { type: "toolCall", id: "call-live-1", name: "Read", arguments: { path: "/one" } },
              { type: "toolCall", id: "call-live-2", name: "Read", arguments: { path: "/two" } },
          ], {
              usage: testUsage(),
              stopReason: "toolUse"
          });
        },
        async generateText() {
          return "";
        },
      };
      process.store.messages.appendMessage("user", "read both files", {
        runId: "run-live-tools",
      });
      process.runs.active = generationRun("run-live-tools", processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        tools: offeredTools("Read"),
        systemPrompt: "Test system prompt."
      });

      const ticking = process.run.runTick("run-live-tools");
      await dispatchStarted;
      const liveToolResults = process.store.tools.getResults("run-live-tools");
      expect(oldDispatchId).not.toBe("call-live-1");
      expect(
        liveToolResults.map((result: any) => ({
          id: result.id,
          status: result.status,
        })),
      ).toEqual([
        { id: "call-live-1", status: "pending" },
        { id: "call-live-2", status: "registered" },
      ]);

      const takeover = await process.controller.handleProcSend({
        message: "stop and do this instead",
        origin: { kind: "client", connectionId: "client-1" },
      });
      const nextRunId = takeover.runId;
      expect(
        process.store.messages
          .getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => message.toolCallId),
      ).toEqual(["call-live-1", "call-live-2"]);

      releaseDispatch();
      await ticking;
      let lateBodyCancelled = false;
      await process.controller.handleRes({
        type: "res",
        id: oldDispatchId,
        ok: true,
        data: { content: "late" },
        body: {
          stream: new ReadableStream({
            cancel() {
              lateBodyCancelled = true;
            },
          }),
          length: 4,
        },
      });

      expect(lateBodyCancelled).toBe(true);
      expect(process.store.tools.getResults("run-live-tools")).toEqual([]);
      expect(process.kernel.dispatchSyscall.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(process.kernel.dispatchSyscall.mock.calls.length).toBeLessThanOrEqual(2);
      expect(process.runs.active).toMatchObject({ runId: nextRunId });
      expect(process.run.scheduleTick).toHaveBeenCalledTimes(1);
      expect(process.run.scheduleTick).toHaveBeenCalledWith(nextRunId);
      process.runs.active = null;
    });
  });

  it("serializes back-to-back user takeovers", async () => {
    const pid = "mech-send-serialized-takeovers";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const finishedRuns: string[] = [];
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      const recordRunFinish = process.run.recordRunFinish.bind(process.run);
      process.run.recordRunFinish = vi.fn((run: { runId: string }, options: any) => {
        finishedRuns.push(run.runId);
        return recordRunFinish(run, options);
      });
      process.runs.active = { runId: "run-original" };

      const first = process.controller.handleProcSend({
        message: "first takeover",
        origin: { kind: "client", connectionId: "client-1" },
      });
      const second = process.controller.handleProcSend({
        message: "second takeover",
        origin: { kind: "client", connectionId: "client-1" },
      });
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(finishedRuns).toEqual(["run-original", firstResult.runId]);
      expect(process.runs.active.runId).toBe(secondResult.runId);
      process.runs.active = null;
    });
  });

  it("rejects out-of-scope media before changing the active run", async () => {
    const pid = "mech-send-foreign-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const foreignKey = `var/media/0/another-process/${crypto.randomUUID()}`;
    await env.STORAGE.put(foreignKey, new Uint8Array([1, 2, 3]));

    try {
      const result = await runInProcess(stub, async (process) => {
        process.runs.active = { runId: "run-existing" };
        const response = await process.controller.handleProcSend({
          message: "read this",
          media: [{ type: "image", mimeType: "image/png", key: foreignKey }],
          origin: { kind: "client", connectionId: "client-1" },
        });
        return {
          response,
          currentRun: process.runs.active,
          messages: process.store.messages.getMessages(),
        };
      });

      expect(result).toEqual({
        response: { ok: false, error: "media key is outside this process" },
        currentRun: { runId: "run-existing" },
        messages: [],
      });
      expect(await env.STORAGE.head(foreignKey)).not.toBeNull();
    } finally {
      await env.STORAGE.delete(foreignKey);
    }
  });

  it.each([false, true])(
    "keeps a newer user run authoritative when earlier media fails=%s",
    async (fails) => {
      const pid = `mech-send-media-race-${fails}`;
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInProcess(stub, async (process) => {
        const { promise: mediaBlocked, resolve: releaseMedia } = deferred();
        const { promise: mediaStarted, resolve: markMediaStarted } = deferred();
        process.sendSignal = vi.fn();
        process.run.scheduleTick = vi.fn(async () => {});
        const prepareMedia = vi.spyOn(process.resources, "prepareRunMedia");
        process.resources.resolveMediaProcessingOptions = vi.fn(async () => {
          markMediaStarted();
          await mediaBlocked;
          if (fails) {
            throw new Error("media config failed");
          }
          return { ai: process.env.AI };
        });
        const mediaKey = `var/media/0/${pid}/race.png`;
        await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
          httpMetadata: { contentType: "image/png" },
        });

        const first = await process.controller.handleProcSend({
          message: "first with media",
          media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
          origin: { kind: "client", connectionId: "client-1" },
        });
        await mediaStarted;
        expect(process.runs.active).toMatchObject({
          runId: first.runId,
          pendingMediaMessageId: expect.any(Number),
        });

        const second = await process.controller.handleProcSend({
          message: "new user direction",
          origin: { kind: "client", connectionId: "client-1" },
        });
        releaseMedia();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        await (prepareMedia.mock.results[0]?.value as Promise<void>);

        const userMessages = process.store.messages
          .getMessages()
          .filter((message: any) => message.role === "user");
        expect(userMessages[0]).toMatchObject({
          runId: first.runId,
          media: expect.any(String),
        });
        expect(process.runs.active).toMatchObject({ runId: second.runId });
        expect(
          process.store.messages
            .getMessages()
            .some(
              (message: any) =>
                message.role === "system" && message.content.includes("media config failed"),
            ),
        ).toBe(false);
        expect(process.run.scheduleTick).toHaveBeenCalledTimes(1);
        expect(process.run.scheduleTick).toHaveBeenCalledWith(second.runId);
        process.runs.active = null;
      });
    },
  );

  it("finishes a media run when its generation tick cannot be scheduled", async () => {
    const pid = "mech-send-media-schedule-failure";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });
      process.resources.resolveMediaProcessingOptions = vi.fn(async () => ({
        ai: process.env.AI,
      }));
      const prepareMedia = vi.spyOn(process.resources, "prepareRunMedia");
      const mediaKey = `var/media/0/${pid}/schedule.png`;
      await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });

      const result = await process.controller.handleProcSend({
        message: "attachment",
        media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
        origin: { kind: "client", connectionId: "client-1" },
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await (prepareMedia.mock.results[0]?.value as Promise<void>);

      expect(process.runs.active).toBeNull();
      expect(process.store.messages.getMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            runId: result.runId,
            content: expect.stringContaining("scheduler unavailable"),
          }),
        ]),
      );
      expect(process.sendSignal).toHaveBeenCalledWith(
        "proc.run.finished",
        expect.objectContaining({
          runId: result.runId,
          status: "error",
          reason: "schedule.error",
        }),
      );
    });
  });

  it("keeps process-origin media sends in admission order", async () => {
    const pid = "mech-send-process-media-fifo";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: mediaBlocked, resolve: releaseMedia } = deferred();
      const { promise: mediaStarted, resolve: markMediaStarted } = deferred();
      process.sendSignal = vi.fn();
      process.resources.resolveMediaProcessingOptions = vi.fn(
        async (media: ProcessTestValue[] | undefined) => {
          if (media?.length) {
            markMediaStarted();
            await mediaBlocked;
          }
          return { ai: process.env.AI };
        },
      );
      process.runs.active = { runId: "run-busy" };
      const mediaKey = `var/media/0/${pid}/fifo.png`;
      await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });

      const first = process.controller.handleProcSend({
        message: "first process message",
        media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
        origin: { kind: "process", sourcePid: "child-1" },
      });
      await mediaStarted;
      const second = process.controller.handleProcSend({
        message: "second process message",
        origin: { kind: "process", sourcePid: "child-2" },
      });

      releaseMedia();
      await Promise.all([first, second]);

      expect(drainProcessQueue(process.store).map((entry: any) => entry.message)).toEqual([
        "first process message",
        "second process message",
      ]);
      process.runs.active = null;
    });
  });

  it("streams an incoming resource into immutable history and hydrates image context blocks", async () => {
    const pid = "mech-send-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const upload = await stub.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.resource.write",
      args: {
        resourceId: "proof",
        mediaType: "image",
        contentType: "image/png",
        filename: "proof.png",
      },
      body: bodyFromBytes(new Uint8Array([1, 2, 3])),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    } satisfies ProcessResourceWriteRequestFrame);
    if (!upload.ok) {
      throw new Error(upload.error.message);
    }
    expect(upload.data).toMatchObject({
      resource: {
        type: "resource",
        ref: {
          size: 3,
          path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
        },
      },
    });
    const uploadedMedia = upload.data.resource;

    const res = await okProcessResponse(
      stub,
      makeReq("proc.send", {
        message: "Describe this image.",
        media: [uploadedMedia],
      }),
    );

    expect(res.ok).toBe(true);

    await vi.waitFor(async () => {
      const media = await runInProcess(stub, (process) => {
        return process.store.messages.getMessages()[0]?.media;
      });
      expect(media).toBeTruthy();
    });

    await runInProcess(stub, async (process) => {
      const store = process.store;
      const record = store.messages.getMessages()[0];
      expect(record.role).toBe("user");
      expect(record.media).toBeTruthy();

      const media = JSON.parse(record.media!);
      expect(media).toHaveLength(1);
      expect(media[0].key).toMatch(/^root\/\.gsv\/media\/archived-media:/);
      expect(media[0].path).toBe(`/${media[0].key}`);

      const stored = await env.STORAGE.get(media[0].key);
      expect(stored).not.toBeNull();
      expect(stored?.customMetadata).toMatchObject({
        uid: "0",
        gid: "0",
        mode: "400",
        purpose: expect.any(String),
      });

      const messages = await process.history.buildContextMessages();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const user = messages[0] as any;
      expect(Array.isArray(user.content)).toBe(true);
      expect(user.content[0]).toEqual({
        type: "text",
        text: ["[Directed endpoint: this GSV process.]", "Describe this image."].join("\n"),
      });
      expect(user.content[1]).toEqual({
        type: "text",
        text: `Attached image "proof.png" [image/png] 3 B\nPath: /${media[0].key}`,
      });
      expect(user.content[2].type).toBe("image");
      expect(user.content[2].mimeType).toBe("image/png");
      expect(user.content[2].data).toBe("AQID");
    });
  });

  it("externalizes tool result images before history and rehydrates model image blocks", async () => {
    const pid = "mech-tool-result-media";
    const runId = "run-tool-result-media";
    const dispatchId = "dispatch-tool-result-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    let mediaKey = "";

    try {
      await runInProcess(stub, async (process) => {
        process.runs.active = { runId };
        process.sendSignal = vi.fn(async () => {});
        process.store.tools.register(dispatchId, "call-tool-result-media", runId, "fs.read", {
          path: "/dev/camera/back/snapshot",
        });
        process.store.tools.register(
          "dispatch-tool-result-blocker",
          "call-tool-result-blocker",
          runId,
          "fs.read",
          { path: "/tmp/blocker" },
        );

        await expect(
          process.tools.resolveStartedTool(runId, dispatchId, {
            ok: true,
            path: "/dev/camera/back/snapshot",
            kind: "image",
            contentType: "image/png",
            size: 3,
            content: [
              { type: "text", text: "Read image /dev/camera/back/snapshot [image/png, 3 B]" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          }),
        ).resolves.toBe(true);

        const resolved = process.store.tools.getResults(runId)[0];
        expect(JSON.stringify(resolved.result)).not.toContain("AQID");
        expect(resolved.result).toMatchObject({
          __gsvStoredToolResult: 1,
          output: {
            content: [
              { type: "text" },
              {
                type: "image",
                mimeType: "image/png",
                path: expect.stringMatching(`^/var/media/0/${pid}/`),
                size: 3,
              },
            ],
          },
        });

        await process.tools.ingestToolResults(runId, process.store.tools.getResults(runId), {
          interruptPending: "test completed",
        });
        const record = process.store.messages
          .getMessages()
          .find((message: any) => message.toolCallId === "call-tool-result-media");
        expect(record.content).not.toContain("AQID");
        const media = JSON.parse(record.media);
        expect(media).toHaveLength(1);
        mediaKey = media[0].key;

        const stored = await env.STORAGE.get(mediaKey);
        expect(stored && [...new Uint8Array(await stored.arrayBuffer())]).toEqual([1, 2, 3]);
        expect(stored?.customMetadata).toMatchObject({
          uid: "0",
          gid: "0",
          mode: "400",
          processId: pid,
          purpose: "tool-result-media",
        });

        const messages = await process.history.buildContextMessages();
        const result = messages.find(
          (message: any) =>
            message.role === "toolResult" && message.toolCallId === "call-tool-result-media",
        );
        expect(
          result.content.some((block: any) => block.type === "image" && block.data === "AQID"),
        ).toBe(true);

        const history = await process.controller.handleProcHistory({});
        const historyResult = history.messages.find(
          (message: any) => message.content?.toolCallId === "call-tool-result-media",
        );
        expect(historyResult.content.media).toEqual([
          expect.objectContaining({
            type: "image",
            mimeType: "image/png",
            key: mediaKey,
            path: `/${mediaKey}`,
          }),
        ]);
      });
    } finally {
      if (mediaKey) await env.STORAGE.delete(mediaKey);
    }
  });

  it("cancels resource retention by request id", async () => {
    const pid = "mech-resource-retain-cancel";
    const sourcePath = "/root/resource-retain-cancel.png";
    const sourceKey = sourcePath.slice(1);
    const bytes = new Uint8Array([1, 2, 3]);
    await env.STORAGE.put(sourceKey, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const source = await env.STORAGE.head(sourceKey);
    if (!source) throw new Error("fixture source was not stored");
    const stub = await initProcess(pid, ROOT_IDENTITY);

    try {
      await runInProcess(stub, async (process, _state, instance) => {
        let retainedKey = "";
        const { promise: stored, resolve: markStored } = deferred();
        const { promise: storedGate, resolve: releaseStored } = deferred();
        const realPut = process.storage.put.bind(process.storage);
        process.storage.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
          const object = await realPut(...args);
          retainedKey = args[0];
          markStored();
          await storedGate;
          return object;
        });
        const request: ProcessResourcesRetainRequestFrame = {
          type: "req",
          id: "retain-cancelled",
          call: "proc.resources.retain",
          args: {
            batchId: "retain-cancelled",
            resources: [
              {
                type: "resource",
                ref: {
                  type: "file",
                  target: "gsv",
                  path: sourcePath,
                  revision: source.httpEtag,
                  contentType: "image/png",
                  size: bytes.byteLength,
                },
              },
            ],
          },
        };

        const retaining = instance.recvFrame(request);
        await stored;
        await instance.recvFrame({
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: request.id, reason: "Send cancelled" },
        });
        releaseStored();

        await expect(retaining).resolves.toMatchObject({
          type: "res",
          id: request.id,
          ok: false,
          error: { message: "Send cancelled" },
        });
        expect(retainedKey).toMatch(/^root\/\.gsv\/media\/archived-media:/);
        expect(await process.storage.head(retainedKey)).toBeNull();
      });
    } finally {
      await env.STORAGE.delete(sourceKey);
    }
  });

  it("does not delete another Process's retained copy when cancellation races", async () => {
    const sourcePath = "/root/resource-retain-cross-process.png";
    const sourceKey = sourcePath.slice(1);
    const bytes = new Uint8Array([4, 5, 6]);
    await env.STORAGE.put(sourceKey, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const source = await env.STORAGE.head(sourceKey);
    if (!source) throw new Error("fixture source was not stored");
    const successfulStub = await initProcess("mech-resource-retain-owner", ROOT_IDENTITY);
    const cancelledStub = await initProcess("mech-resource-retain-cancelled", ROOT_IDENTITY);
    let successfulKey = "";
    let cancelledKey = "";

    const request = (id: string): ProcessResourcesRetainRequestFrame => ({
      type: "req",
      id,
      call: "proc.resources.retain",
      args: {
        batchId: id,
        resources: [
          {
            type: "resource",
            ref: {
              type: "file",
              target: "gsv",
              path: sourcePath,
              revision: source.httpEtag,
              contentType: "image/png",
              size: bytes.byteLength,
            },
          },
        ],
      },
    });

    try {
      await runInProcess(successfulStub, async (_process, _state, instance) => {
        const response = await instance.recvFrame(request("retain-successful"));
        if (!response || response.type !== "res" || !response.ok) {
          throw new Error("successful Process did not retain the fixture");
        }
        successfulKey = response.data.resources[0].ref.path.replace(/^\/+/, "");
        expect(await env.STORAGE.head(successfulKey)).not.toBeNull();
      });

      await runInProcess(cancelledStub, async (process, _state, instance) => {
        let firstArchiveHead = true;
        const { promise: stored, resolve: markStored } = deferred();
        const { promise: storedGate, resolve: releaseStored } = deferred();
        const realHead = process.storage.head.bind(process.storage);
        process.storage.head = vi.fn(async (key: string) => {
          if (firstArchiveHead && key.startsWith("root/.gsv/media/archived-media:")) {
            firstArchiveHead = false;
            return null;
          }
          return realHead(key);
        });
        const realPut = process.storage.put.bind(process.storage);
        process.storage.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
          const object = await realPut(...args);
          cancelledKey = args[0];
          markStored();
          await storedGate;
          return object;
        });
        const retaining = instance.recvFrame(request("retain-cancelled-cross-process"));
        await stored;
        await instance.recvFrame({
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: "retain-cancelled-cross-process", reason: "Send cancelled" },
        });
        releaseStored();

        await expect(retaining).resolves.toMatchObject({
          type: "res",
          id: "retain-cancelled-cross-process",
          ok: false,
          error: { message: "Send cancelled" },
        });
        expect(cancelledKey).not.toBe(successfulKey);
        expect(await env.STORAGE.head(cancelledKey)).toBeNull();
        expect(await env.STORAGE.head(successfulKey)).not.toBeNull();
      });
    } finally {
      await env.STORAGE.delete([sourceKey, successfulKey, cancelledKey].filter(Boolean));
    }
  });

  it("rolls back an incomplete resource retention batch", async () => {
    const pid = "mech-resource-retain-batch-rollback";
    const sourcePath = "/root/resource-retain-batch.png";
    const sourceKey = sourcePath.slice(1);
    const bytes = new Uint8Array([8, 9, 10]);
    await env.STORAGE.put(sourceKey, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const source = await env.STORAGE.head(sourceKey);
    if (!source) throw new Error("fixture source was not stored");
    const stub = await initProcess(pid, ROOT_IDENTITY);

    try {
      await runInProcess(stub, async (process, _state, instance) => {
        const archivePrefix = "root/.gsv/media/archived-media:";
        const before = (await process.storage.list({ prefix: archivePrefix })).objects
          .map((object: R2Object) => object.key)
          .sort();
        const request: ProcessResourcesRetainRequestFrame = {
          type: "req",
          id: "retain-batch-rollback",
          call: "proc.resources.retain",
          args: {
            batchId: "delivery:batch-rollback",
            resources: [
              {
                type: "resource",
                ref: {
                  type: "file",
                  target: "gsv",
                  path: sourcePath,
                  revision: source.httpEtag,
                  contentType: "image/png",
                  size: bytes.byteLength,
                },
              },
              {
                type: "resource",
                ref: {
                  type: "file",
                  target: "gsv",
                  path: "/root/resource-retain-missing.png",
                  revision: "missing-revision",
                  contentType: "image/png",
                  size: bytes.byteLength,
                },
              },
            ],
          },
        };

        await expect(instance.recvFrame(request)).resolves.toMatchObject({
          type: "res",
          id: request.id,
          ok: false,
        });
        expect(
          (await process.storage.list({ prefix: archivePrefix })).objects
            .map((object: R2Object) => object.key)
            .sort(),
        ).toEqual(before);
      });
    } finally {
      await env.STORAGE.delete(sourceKey);
    }
  });
});
