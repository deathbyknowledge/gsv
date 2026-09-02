import { processDurableObjectName } from "../installation/routing";
import { installationStoragePrefix } from "../installation/storage";
import { getProcessByPid } from "../shared/utils";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  generationRun, mockGeneration, processTestConfig, assistantResponse, deferred, okProcessResponse,
  runInProcess, ROOT_IDENTITY, initProcess, makeReq, testUsage,
} from "./do-test-harness";

describe("proc.kill", () => {
  it("deletes only the killed managed installation's process media", async () => {
    const installationId = "inst_managed_kill_media";
    const otherInstallationId = "inst_other_kill_media";
    const pid = "mech-managed-kill-media";
    const logicalKey = `var/media/0/${pid}/pending.png`;
    const ownKey = `${installationStoragePrefix(installationId)}${logicalKey}`;
    const otherKey = `${installationStoragePrefix(otherInstallationId)}${logicalKey}`;
    const stub = env.PROCESS.get(
      env.PROCESS.idFromName(processDurableObjectName(installationId, pid)),
    );
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
      }),
    );
    await env.STORAGE.put(ownKey, new Uint8Array([1]));
    await env.STORAGE.put(otherKey, new Uint8Array([2]));

    await expect(stub.recvFrame(makeReq("proc.kill", { archive: false }))).resolves.toMatchObject(
      {
        ok: true,
        data: { ok: true, pid, archivedMessages: 0, archives: [] },
      },
    );
    expect(await env.STORAGE.head(ownKey)).toBeNull();
    expect(await env.STORAGE.head(otherKey)).not.toBeNull();
    await env.STORAGE.delete(otherKey);
  });

  it("rehomes archived media so a fresh executor can hydrate and read it", async () => {
    const pid = "mech-kill-archive-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const activeKey = `var/media/0/${pid}/proof.png`;
    await env.STORAGE.put(activeKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        uid: "0",
        gid: "0",
        mode: "400",
        processId: pid,
      },
    });
    await runInProcess(stub, (process) => {
      process.store.messages.appendMessage("user", "Keep this image.", {
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            filename: "proof.png",
            size: 3,
            key: activeKey,
            path: `/${activeKey}`,
          },
        ]),
      });
    });

    const killed = await okProcessResponse(stub, makeReq("proc.kill", {}));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const archive = (killed.data as any).archives[0];
    expect(archive).toBeTruthy();
    expect(await env.STORAGE.head(activeKey)).toBeNull();

    const resumedPid = "mech-resume-archive-media";
    const resumed = await getProcessByPid(resumedPid);
    const initialized = await okProcessResponse(
      resumed,
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(initialized.ok).toBe(true);
    const imported = await okProcessResponse(
      resumed,
      makeReq("proc.history.import", {
        archivePaths: [archive.path],
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(imported.data).toMatchObject({ ok: true, pid: resumedPid, restoredMessages: 1 });

    const history = await okProcessResponse(resumed, makeReq("proc.history", {}));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const media = (history.data as any).messages[0].content.media[0];
    expect(media).toMatchObject({
      filename: "proof.png",
      key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
    });
    expect(media.path).toBe(`/${media.key}`);

    const restored = await env.STORAGE.get(media.key);
    expect(restored && [...new Uint8Array(await restored.arrayBuffer())]).toEqual([1, 2, 3]);

    await env.STORAGE.delete([archive.path.replace(/^\//, ""), media.key]);
    await resumed.recvFrame(makeReq("proc.kill", { archive: false }));
  });

  it("can dispose an executor whose identity initialization never completed", async () => {
    const pid = "mech-kill-uninitialized";
    const stub = await getProcessByPid(pid);

    const killed = await stub.recvFrame(makeReq("proc.kill", { pid, archive: false }));
    expect(killed).toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 0, archives: [] },
    });
    await expect(
      stub.recvFrame(makeReq("proc.setidentity", { identity: ROOT_IDENTITY })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 410 },
    });
  });

  it("preserves live execution state when history archival fails", async () => {
    const pid = "mech-kill-archive-failure";
    const runId = "run-kill-archive-failure";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const failed = await runInProcess(stub, async (process, state) => {
      process.runs.active = { runId };
      process.store.messages.appendMessage("user", "survive archive failure", { runId });
      process.store.queue.enqueue("queued-after-archive-failure", "queued work must survive");
      process.store.tools.register(
        "dispatch-archive-failure",
        "call-archive-failure",
        runId,
        "fs.read",
        { path: "/tmp/archive" },
      );
      process.store.tools.setPendingHil({
        requestId: "hil-archive-failure",
        runId,
        toolCallId: "call-archive-failure",
        toolName: "Read",
        syscall: "fs.read",
        args: { path: "/tmp/archive" },
        createdAt: Date.now(),
      });
      process.history.archiveMessageRecords = vi.fn(async () => {
        throw new Error("injected archive failure");
      });
      process.sendSignal = vi.fn(async () => {});

      const response = await process.recvFrame(makeReq("proc.kill", {}));
      return {
        response,
        killed: process.killed,
        currentRun: process.runs.active,
        tools: process.store.tools.getResults(runId),
        pendingHil: process.store.tools.getPendingHilForRun(runId),
        queueSize: process.store.queue.queueSize(),
        finishCalls: process.sendSignal.mock.calls.length,
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
      };
    });

    expect(failed).toMatchObject({
      response: { ok: false, error: { message: "injected archive failure" } },
      killed: false,
      currentRun: { runId },
      tools: [
        expect.objectContaining({
          dispatchId: "dispatch-archive-failure",
          status: "registered",
        }),
      ],
      pendingHil: { requestId: "hil-archive-failure", runId },
      queueSize: 1,
      finishCalls: 0,
      tombstone: undefined,
    });

    await evictDurableObject(stub);
    await expect(
      runInProcess(stub, (process) => {
        return {
          currentRun: process.runs.active,
          tools: process.store.tools.getResults(runId),
          pendingHil: process.store.tools.getPendingHilForRun(runId),
          queueSize: process.store.queue.queueSize(),
        };
      }),
    ).resolves.toMatchObject({
      currentRun: { runId },
      tools: [
        expect.objectContaining({
          dispatchId: "dispatch-archive-failure",
          status: "registered",
        }),
      ],
      pendingHil: { requestId: "hil-archive-failure", runId },
      queueSize: 1,
    });
    await expect(stub.recvFrame(makeReq("proc.kill", { archive: false }))).resolves.toMatchObject(
      { ok: true, data: { ok: true, pid } },
    );
  });

  it("fences provider output once kill archival begins", async () => {
    const pid = "mech-kill-stable-archive";
    const runId = "run-kill-stable-archive";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const { promise: generationBlocked, resolve: releaseGeneration } = deferred();
      const { promise: generationStarted, resolve: markGenerationStarted } = deferred();
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      mockGeneration(process, async () => {
        markGenerationStarted();
        await generationBlocked;
        return assistantResponse([{ type: "text", text: "provider completed during archive" }], {
          usage: testUsage()
        });
      }, async () => {
        return "";
      });
      process.sendSignal = vi.fn(async () => {});
      const archiveMessageRecords = process.history.archiveMessageRecords.bind(process.history);
      let archiveAttempts = 0;
      const archiveSnapshots: any[][] = [];
      process.history.archiveMessageRecords = vi.fn(async (...args: any[]) => {
        archiveAttempts += 1;
        archiveSnapshots.push(args[1]);
        if (archiveAttempts === 1) {
          markArchiveStarted();
          await archiveBlocked;
          return;
        }
        await archiveMessageRecords(...args);
      });
      const activeMediaKey = `var/media/0/${pid}/stable.png`;
      await process.env.STORAGE.put(activeMediaKey, new Uint8Array([4, 5, 6]), {
        httpMetadata: { contentType: "image/png" },
        customMetadata: {
          uid: "0",
          gid: "0",
          mode: "400",
          processId: pid,
        },
      });
      process.store.messages.appendMessage("user", "answer before kill", {
        runId,
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            filename: "stable.png",
            size: 3,
            key: activeMediaKey,
            path: `/${activeMediaKey}`,
          },
        ]),
        origin: JSON.stringify({
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "telegram:user:1",
          surface: { kind: "dm", id: "chat-1" },
        }),
      });
      process.store.messages.appendMessage("assistant", "checking", {
        runId,
        toolCalls: JSON.stringify({
          toolCalls: [
            {
              type: "toolCall",
              id: "historical-call",
              name: "Read",
              arguments: { path: "/tmp/stable" },
            },
          ],
        }),
      });
      process.store.messages.appendToolResult(
        "historical-call",
        "fs.read",
        "stable result",
        false,
        runId,
        "completed",
      );
      process.runs.active = generationRun(runId, processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        mcpServers: []
      });

      const ticking = process.run.runTick(runId);
      await generationStarted;
      const killing = process.recvFrame(makeReq("proc.kill", {}));
      await archiveStarted;
      releaseGeneration();
      await ticking;
      expect(process.store.messages.getMessages({ limit: null })).toHaveLength(3);
      releaseArchive();
      const response = await killing;
      const archivePath = response.data.archives[0].path;
      const archived = archiveSnapshots.at(-1)!;
      const archivedMedia = await process.env.STORAGE.list({
        prefix: "root/.gsv/media/archived-media:",
      });
      await process.env.STORAGE.delete([
        archivePath.replace(/^\//, ""),
        ...archivedMedia.objects.map((object: any) => object.key),
      ]);
      return {
        response,
        archiveAttempts,
        contents: archived.map((message: any) => message.content),
        origin: JSON.parse(archived[0].origin),
        media: JSON.parse(archived[0].media),
        toolCalls: JSON.parse(archived[1].toolCalls).toolCalls,
      };
    });

    expect(result.response).toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 3 },
    });
    expect(result.archiveAttempts).toBe(1);
    expect(result.contents).toEqual(["answer before kill", "checking", "stable result"]);
    expect(result.origin).toMatchObject({
      kind: "adapter",
      adapter: "telegram",
      surface: { kind: "dm", id: "chat-1" },
    });
    expect(result.media).toEqual([
      expect.objectContaining({ key: expect.stringContaining("stable.png") }),
    ]);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ id: "historical-call", name: "Read" }),
    ]);
  });

  it("serializes concurrent kills behind one terminal archive commit", async () => {
    const pid = "mech-kill-concurrent-commit";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process, state) => {
      process.store.messages.appendMessage("user", "archive exactly once");
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      process.history.archiveMessageRecords = vi.fn(async () => {
        markArchiveStarted();
        await archiveBlocked;
      });
      const transactionSync = vi.spyOn(state.storage, "transactionSync");

      const first = process.recvFrame(makeReq("proc.kill", {}));
      await archiveStarted;
      const second = process.recvFrame(makeReq("proc.kill", {}));
      releaseArchive();
      const responses = await Promise.all([first, second]);

      return {
        responses,
        archiveCalls: process.history.archiveMessageRecords.mock.calls.length,
        terminalCommits: transactionSync.mock.calls.length,
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
      };
    });

    expect(result.archiveCalls).toBe(1);
    expect(result.terminalCommits).toBe(1);
    expect(result.responses[0]).toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 1 },
    });
    expect(result.responses[1].data).toEqual(result.responses[0].data);
    expect(result.tombstone).toMatchObject({
      pid,
      cleanup: "completed",
      result: result.responses[0].data,
    });
  });

  it("ignores a provider completion released after the terminal commit", async () => {
    const pid = "mech-kill-late-provider";
    const runId = "run-kill-late-provider";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: generationBlocked, resolve: releaseGeneration } = deferred();
      const { promise: generationStarted, resolve: markGenerationStarted } = deferred();
      mockGeneration(process, async () => {
        markGenerationStarted();
        await generationBlocked;
        return assistantResponse([{ type: "text", text: "late provider output" }], {
          usage: testUsage()
        });
      }, async () => {
        return "";
      });
      process.sendSignal = vi.fn(async () => {});
      process.store.messages.appendMessage("user", "kill while provider is blocked", { runId });
      process.runs.active = generationRun(runId, processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        mcpServers: []
      });

      const ticking = process.run.runTick(runId);
      await generationStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseGeneration();
      await expect(ticking).resolves.toBeUndefined();
      await expect(process.recvFrame(makeReq("proc.history", {}))).resolves.toMatchObject({
        ok: false,
        error: { code: 410 },
      });
    });
  });

  it("rejects a queued runtime send released after the terminal commit", async () => {
    const pid = "mech-kill-queued-runtime-send";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const releaseAdmission = await process.controller.acquireQueuedSendAdmission();
      const acquireQueuedSendAdmission = process.controller.acquireQueuedSendAdmission.bind(
        process.controller,
      );
      const { promise: admissionStarted, resolve: markAdmissionStarted } = deferred();
      process.controller.acquireQueuedSendAdmission = vi.fn(async () => {
        markAdmissionStarted();
        return await acquireQueuedSendAdmission();
      });

      const sending = process.controller.handleProcSend({
        message: "queued scheduler work",
        origin: { kind: "scheduler", scheduleId: "schedule-after-kill" },
      });
      await admissionStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseAdmission();
      await expect(sending).resolves.toEqual({
        ok: false,
        error: "Process no longer exists",
      });
    });
  });

  it("ignores context media hydration released after the terminal commit", async () => {
    const pid = "mech-kill-late-context-media";
    const runId = "run-kill-late-context-media";
    const key = `var/media/0/${pid}/context.png`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const { promise: readBlocked, resolve: releaseRead } = deferred();
      const { promise: readStarted, resolve: markReadStarted } = deferred();
      process.storage = {
        get: vi.fn(async (requestedKey: string) => {
          const object = await originalStorage.get(requestedKey);
          markReadStarted();
          await readBlocked;
          return object;
        }),
        list: (...args: any[]) => originalStorage.list(...args),
        delete: (...args: any[]) => originalStorage.delete(...args),
      };
      process.sendSignal = vi.fn(async () => {});
      process.store.messages.appendMessage("user", "inspect the image", {
        runId,
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            key,
            path: `/${key}`,
            size: 3,
          },
        ]),
      });
      process.runs.active = generationRun(runId, processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        mcpServers: []
      });

      const ticking = process.run.runTick(runId);
      await readStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseRead();
      await expect(ticking).resolves.toBeUndefined();
      process.storage = originalStorage;
    });
  });

  it("ignores tool body materialization released after the terminal commit", async () => {
    const pid = "mech-kill-late-tool-body";
    const runId = "run-kill-late-tool-body";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: bodyBlocked, resolve: releaseBody } = deferred();
      const { promise: bodyStarted, resolve: markBodyStarted } = deferred();
      let cancelled = false;
      process.runs.active = { runId };
      process.store.tools.register(
        "dispatch-kill-late-body",
        "call-kill-late-body",
        runId,
        "fs.read",
        { path: "/tmp/late" },
      );
      process.store.tools.markDispatched("dispatch-kill-late-body");
      process.sendSignal = vi.fn(async () => {});

      const handling = process.controller.handleRes({
        type: "res",
        id: "dispatch-kill-late-body",
        ok: true,
        data: {
          ok: true,
          path: "/tmp/late",
          kind: "text",
          contentType: "text/plain",
          size: 1,
          lines: 1,
        },
        body: {
          stream: new ReadableStream({
            pull() {
              markBodyStarted();
              return bodyBlocked;
            },
            cancel() {
              cancelled = true;
            },
          }),
          length: 1,
        },
      });
      await bodyStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseBody();
      await expect(handling).resolves.toBeUndefined();
      expect(cancelled).toBe(true);
    });
  });

  it("ignores pending finish delivery released after the terminal commit", async () => {
    const pid = "mech-kill-late-finish-delivery";
    const runId = "run-kill-late-finish-delivery";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: signalBlocked, resolve: releaseSignal } = deferred();
      const { promise: signalStarted, resolve: markSignalStarted } = deferred();
      process.store.state.setValue(
        "pendingRunFinishes",
        JSON.stringify([
          {
            pid,
            runId,
            status: "ok",
            reason: "turn.complete",
            text: "done",
            queuedCount: 0,
            timestamp: 1,
          },
        ]),
      );
      process.sendSignal = vi.fn(async (signal: string) => {
        if (signal === "proc.run.finished") {
          markSignalStarted();
          await signalBlocked;
        }
      });

      const delivery = process.finishDelivery.deliver(runId);
      await signalStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseSignal();
      await expect(delivery).resolves.toBeUndefined();
    });
  });

  it("ignores a schedule rejection delivered after the terminal commit", async () => {
    const pid = "mech-kill-late-schedule";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      let rejectSchedule!: (error: Error) => void;
      const { promise: scheduleStarted, resolve: markScheduleStarted } = deferred();
      const scheduled = new Promise<void>((_resolve, reject) => {
        rejectSchedule = reject;
      });
      process.run.scheduleTick = vi.fn(() => {
        markScheduleStarted();
        return scheduled;
      });
      process.sendSignal = vi.fn(async () => {});
      const finishRun = vi.spyOn(process.run, "finishRun");

      const sending = process.controller.handleProcSend({
        message: "schedule after kill",
        origin: { kind: "client", connectionId: "client-1" },
      });
      await scheduleStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      rejectSchedule(new Error("late scheduler rejection"));
      await scheduled.catch(() => {});
      await expect(sending).resolves.toMatchObject({ ok: true, status: "started" });
      expect(finishRun).not.toHaveBeenCalled();
    });
  });

  it("stops a requested-id media write whose head resolves after kill", async () => {
    const pid = "mech-kill-late-media-head";
    const mediaId = "requested-after-kill";
    const key = `var/media/0/${pid}/${mediaId}`;
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const originalStorage = process.storage;
      const { promise: headBlocked, resolve: releaseHead } = deferred();
      const { promise: headStarted, resolve: markHeadStarted } = deferred();
      process.storage = {
        head: vi.fn(async (requestedKey: string) => {
          if (requestedKey === key) {
            markHeadStarted();
            await headBlocked;
            return null;
          }
          return await originalStorage.head(requestedKey);
        }),
        list: (...args: any[]) => originalStorage.list(...args),
        delete: (...args: any[]) => originalStorage.delete(...args),
        put: (...args: any[]) => originalStorage.put(...args),
      };
      const writing = process.resources.storeIncomingResource(
        { type: "image", mimeType: "image/png", mediaId },
        bodyFromBytes(new Uint8Array([1])),
      );
      await headStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseHead();
      await expect(writing).resolves.toEqual({
        ok: false,
        error: "Process reset during media upload",
      });
      process.storage = originalStorage;
    });
  });

  it("persists cleanup debt and retries it without reviving the process", async () => {
    const pid = "mech-kill-finish-failure";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const killed = await runInProcess(stub, async (process, state) => {
      const originalStorage = process.storage;
      const mediaDelete = vi.fn(async () => {
        expect(state.storage.kv.get("__gsv_process_killed__")).toMatchObject({
          pid,
          cleanup: "pending",
        });
        throw new Error("media delete unavailable");
      });
      process.storage = {
        list: vi.fn(async () => ({
          objects: [{ key: `var/media/0/${pid}/pending.png` }],
          truncated: false,
        })),
        delete: mediaDelete,
      };
      process.runs.active = { runId: "run-kill-failure" };
      process.sendSignal = vi.fn(async () => {
        expect(state.storage.kv.get("__gsv_process_killed__")).toMatchObject({
          pid,
          cleanup: "pending",
        });
        throw new Error("finish route unavailable");
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      const deleteAlarm = vi
        .spyOn(state.storage, "deleteAlarm")
        .mockRejectedValue(new Error("alarm cleanup unavailable"));

      try {
        const response = await process.recvFrame(makeReq("proc.kill", { archive: false }));
        return {
          response,
          killed: process.killed,
          mediaDeleteCalls: mediaDelete.mock.calls.length,
          finishCalls: process.sendSignal.mock.calls.length,
          tombstone: state.storage.kv.get("__gsv_process_killed__"),
        };
      } finally {
        deleteAlarm.mockRestore();
        process.storage = originalStorage;
      }
    });

    expect(killed).toMatchObject({
      response: {
        ok: false,
        error: { message: "Process was killed but terminal cleanup is pending" },
      },
      killed: true,
      mediaDeleteCalls: 1,
      finishCalls: 1,
      tombstone: {
        version: 1,
        pid,
        uid: 0,
        result: { ok: true, pid, archivedMessages: 0, archives: [] },
        cleanup: "pending",
      },
    });
    await expect(stub.recvFrame(makeReq("proc.history", {}))).resolves.toMatchObject({
      ok: false,
      error: { code: 410, message: "Process no longer exists" },
    });
    await evictDurableObject(stub);
    await expect(
      stub.recvFrame(makeReq("proc.kill", { pid, archive: false })),
    ).resolves.toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 0, archives: [] },
    });
    await expect(
      runInProcess(stub, (_instance, state) => state.storage.kv.get("__gsv_process_killed__")),
    ).resolves.toMatchObject({
      pid,
      cleanup: "completed",
    });
  });

  it("coalesces concurrent retries of pending terminal cleanup", async () => {
    const pid = "mech-kill-concurrent-cleanup";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process, state) => {
      const originalStorage = process.storage;
      let listCalls = 0;
      const { promise: retryStarted, resolve: markRetryStarted } = deferred();
      const { promise: retryBlocked, resolve: releaseRetry } = deferred();
      const list = vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return {
            objects: [{ key: `var/media/0/${pid}/pending.png` }],
            truncated: false,
          };
        }
        markRetryStarted();
        await retryBlocked;
        return { objects: [], truncated: false };
      });
      process.storage = {
        list,
        delete: vi.fn(async () => {
          throw new Error("media delete unavailable");
        }),
      };

      const initial = await process.recvFrame(makeReq("proc.kill", { archive: false }));
      const firstRetry = process.recvFrame(makeReq("proc.kill", { archive: false }));
      await retryStarted;
      const secondRetry = process.recvFrame(makeReq("proc.kill", { archive: false }));
      releaseRetry();
      const retries = await Promise.all([firstRetry, secondRetry]);
      const tombstone = state.storage.kv.get("__gsv_process_killed__");
      process.storage = originalStorage;
      return { initial, retries, listCalls, tombstone };
    });

    expect(result.initial).toMatchObject({
      ok: false,
      error: { message: "Process was killed but terminal cleanup is pending" },
    });
    expect(result.listCalls).toBe(2);
    expect(result.retries[0]).toMatchObject({
      ok: true,
      data: { ok: true, pid, archivedMessages: 0, archives: [] },
    });
    expect(result.retries[1].data).toEqual(result.retries[0].data);
    expect(result.tombstone).toMatchObject({
      pid,
      cleanup: "completed",
      pendingCleanup: [],
    });
  });

  it("keeps finish notification best-effort after the terminal commit", async () => {
    const pid = "mech-kill-best-effort-finish";
    const runId = "run-kill-best-effort-finish";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const first = await runInProcess(stub, async (process, state) => {
      process.runs.active = { runId };
      process.sendSignal = vi.fn(async () => {
        throw new Error("finish transport unavailable");
      });
      const response = await process.recvFrame(makeReq("proc.kill", { archive: false }));
      return {
        response,
        finishCalls: process.sendSignal.mock.calls.length,
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
      };
    });

    expect(first).toMatchObject({
      response: {
        ok: true,
        data: { ok: true, pid, archivedMessages: 0, archives: [] },
      },
      finishCalls: 1,
      tombstone: { pid, cleanup: "completed", pendingCleanup: [] },
    });

    await evictDurableObject(stub);
    const replay = await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      const response = await process.recvFrame(makeReq("proc.kill", { pid, archive: false }));
      return { response, finishCalls: process.sendSignal.mock.calls.length };
    });
    expect(replay.response.data).toEqual(first.response.data);
    expect(replay.finishCalls).toBe(0);
  });

  it("archives the active run terminal boundary in its context epoch", async () => {
    const pid = "mech-kill-context-epoch-boundary";
    const runId = "run-kill-context-epoch-boundary";
    const epochId = "epoch-kill-boundary";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage("user", "archive the active run", { runId });
      process.store.epochs.createContextEpoch({
        id: epochId,
        generation: process.store.state.getHistoryGeneration(),
        systemPrompt: "Frozen test prompt.",
        r12yRevision: 0,
        r12yCount: 0,
        r12yBaseline: [],
        sourceManifest: { version: 1 },
        observedProjection: {
          version: 1,
          runtime: { date: "2026-08-28", timezone: "UTC" },
          targets: [],
          mcpServers: [],
          skills: { mode: "off", entries: [] },
        },
        now: 100,
      });
      process.runs.active = { runId };
      process.sendSignal = vi.fn(async () => {});
      const epochKey = `${process.history.historyArchiveDir()}/epochs/${epochId}.json.gz`;

      const response = await process.recvFrame(makeReq("proc.kill", {}));
      const archived = await process.env.STORAGE.get(epochKey);
      if (!archived) throw new Error("Expected killed context epoch archive");
      const manifest = await new Response(
        archived.body.pipeThrough(new DecompressionStream("gzip")),
      ).json();
      return { response, manifest };
    });

    expect(result.response).toMatchObject({
      ok: true,
      data: {
        ok: true,
        pid,
        archivedMessages: 1,
        contextEpochArchives: [expect.stringMatching(`/epochs/${epochId}\\.json\\.gz$`)],
      },
    });
    expect(result.manifest).toMatchObject({
      epoch: {
        id: epochId,
        systemPrompt: "Frozen test prompt.",
        processActivity: [
          expect.objectContaining({
            run_id: runId,
            content: "archive the active run",
          }),
        ],
        runBoundaries: [
          expect.objectContaining({
            pid,
            runId,
            status: "aborted",
            reason: "process.kill",
          }),
        ],
      },
    });
  });
});
