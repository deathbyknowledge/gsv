import type { ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import { estimateContextInputTokens } from "./context-pressure";
import type { Context } from "@earendil-works/pi-ai";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse, deferred,
  okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq, messageAction,
  setHistoryPolicy, terminalTestConfig, terminalTestResponse, testUsage, type ProcessTestValue,
} from "./do-test-harness";

describe("process history", () => {
  it("exports through a tool-calling assistant message with its tool results", async () => {
    const sourcePid = "mech-history-export-tool-boundary";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);
    const assistantId = await runInProcess(source, (process) => {
      const store = process.store;
      store.messages.appendMessage("user", "Inspect the file.");
      const id = store.messages.appendMessage("assistant", "I will inspect it.", {
        toolCalls: JSON.stringify([
          {
            type: "toolCall",
            id: "call-export-read",
            name: "Read",
            arguments: { path: "/tmp/example.txt" },
          },
        ]),
      });
      store.messages.appendToolResult("call-export-read", "fs.read", "file contents", false);
      store.messages.appendMessage("assistant", "This must not be exported.");
      return id;
    });

    const exportResponse = await okProcessResponse(
      source,
      makeReq("proc.history.export", {
        throughMessageId: assistantId,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const exported = exportResponse.data as any;
    expect(exported).toMatchObject({
      ok: true,
      sourcePid,
      throughMessageId: assistantId,
      includedLiveSuffix: false,
    });

    const targetPid = "mech-history-import-tool-boundary";
    const target = await initProcess(targetPid, ROOT_IDENTITY);
    const importResponse = await okProcessResponse(
      target,
      makeReq("proc.history.import", {
        archivePaths: exported.archivePaths,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(importResponse.data).toMatchObject({
      ok: true,
      pid: targetPid,
      restoredMessages: 3,
    });

    await runInProcess(target, (process) => {
      expect(
        process.store.messages.getMessages().map((message: any) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
        })),
      ).toEqual([
        { role: "user", content: "Inspect the file.", toolCallId: null },
        { role: "assistant", content: "I will inspect it.", toolCallId: null },
        { role: "toolResult", content: "file contents", toolCallId: "call-export-read" },
      ]);
    });

    await env.STORAGE.delete(exported.archivePaths[0].replace(/^\/+/, ""));
  });

  it("resolves a canonical conversation run to its process input boundary", async () => {
    const sourcePid = "mech-history-export-run-boundary";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);
    const runId = "run:canonical-conversation-message";
    const userId = await runInProcess(source, (process) => {
      const store = process.store;
      const id = store.messages.appendMessage("user", "Branch from this conversation message.", {
        runId,
      });
      store.messages.appendMessage("assistant", "This reply must not be exported.", {
        runId,
      });
      return id;
    });

    const exportResponse = await okProcessResponse(
      source,
      makeReq("proc.history.export", {
        throughRunId: runId,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const exported = exportResponse.data as any;
    expect(exported).toMatchObject({
      ok: true,
      sourcePid,
      throughMessageId: userId,
      includedLiveSuffix: false,
    });

    const target = await initProcess("mech-history-import-run-boundary", ROOT_IDENTITY);
    const importResponse = await okProcessResponse(
      target,
      makeReq("proc.history.import", {
        archivePaths: exported.archivePaths,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(importResponse.data).toMatchObject({
      ok: true,
      restoredMessages: 1,
    });
    await runInProcess(target, (process) => {
      expect(
        process.store.messages.getMessages().map((message: any) => ({
          role: message.role,
          content: message.content,
          runId: message.runId,
        })),
      ).toEqual([
        {
          role: "user",
          content: "Branch from this conversation message.",
          runId,
        },
      ]);
    });

    await env.STORAGE.delete(exported.archivePaths[0].replace(/^\/+/, ""));
  });

  it("admits new work while writing a fork archive snapshot", async () => {
    const stub = await initProcess("mech-history-export-unlocked", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const messageId = process.store.messages.appendMessage("user", "Fork this snapshot.");
      const { promise: archiveStarted, resolve: markArchiveStarted } = deferred();
      const { promise: archiveBlocked, resolve: releaseArchive } = deferred();
      let archivedMessages: any[] = [];
      process.history.archiveForkMessages = vi.fn(async (_dir: string, messages: any[]) => {
        archivedMessages = messages;
        markArchiveStarted();
        await archiveBlocked;
        return "/tmp/fork-history.jsonl.gz";
      });

      const exporting = process.history.handleHistoryExport({ throughMessageId: messageId });
      await archiveStarted;

      process.run.scheduleTick = vi.fn(async () => {});
      process.sendSignal = vi.fn(async () => {});
      const sending = process.controller.handleProcSend({
        message: "Continue while exporting.",
        origin: { kind: "client", connectionId: "client-1" },
      });
      await expect(sending).resolves.toMatchObject({ ok: true, status: "started" });

      releaseArchive();
      expect(await exporting).toMatchObject({ ok: true });
      expect(archivedMessages.map((message) => message.content)).toEqual(["Fork this snapshot."]);
      process.runs.active = null;
    });
  });

  it("compacts a history prefix into an archived segment", async () => {
    const pid = "mech-conversation-compact";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const messageIds = await runInProcess(stub, (process) => {
      const store = process.store;
      process.__signals = [];
      process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
        process.__signals.push({ signal, payload });
      };
      return [
        store.messages.appendMessage("user", "old user", {}),
        store.messages.appendMessage("assistant", "old assistant", {}),
        store.messages.appendMessage("user", "keep this", {}),
      ];
    });

    const compactRes = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "The old exchange established the thread context.",
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = compactRes.data as any;

    expect(data).toMatchObject({
      ok: true,
      pid,
      archivedMessages: 2,
      summaryMessageId: messageIds[0],
      segment: {
        generation: 1,
        kind: "compaction",
        fromMessageId: messageIds[0],
        toMessageId: messageIds[1],
        summaryMessageId: messageIds[0],
      },
    });
    expect(data.archivedTo).toMatch(
      new RegExp(`/root/processes/${encodeURIComponent(pid)}/history/.+\\.jsonl\\.gz$`),
    );

    const archiveKey = data.archivedTo.replace(/^\//, "");
    expect(await env.STORAGE.get(archiveKey)).not.toBeNull();

    await runInProcess(stub, (process) => {
      const store = process.store;
      const messages = store.messages.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: messageIds[0],
        role: "system",
      });
      expect(messages[0].content).toContain("Process history compacted.");
      expect(messages[0].content).toContain(data.archivedTo);
      expect(messages[0].content).toContain("The old exchange established the thread context.");
      expect(messages[1]).toMatchObject({
        id: messageIds[2],
        role: "user",
        content: "keep this",
      });
      expect(process.__signals).toEqual([
        {
          signal: "proc.changed",
          payload: expect.objectContaining({
            event: "history.compacted",
            pid,
            archivedMessages: 2,
            archivedTo: data.archivedTo,
            summaryMessageId: messageIds[0],
            segment: expect.objectContaining({
              id: data.segment.id,
            }),
          }),
        },
      ]);
    });

    const segmentsRes = await okProcessResponse(stub, makeReq("proc.history.segments", {}));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((segmentsRes.data as any).segments).toEqual([
      expect.objectContaining({
        id: data.segment.id,
        archivePath: data.archivedTo,
        summaryMessageId: messageIds[0],
      }),
    ]);
  });

  it("builds bounded compaction input from complete JSON records", async () => {
    const pid = "mech-conversation-compact-jsonl";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    let transcript = "";

    await runInProcess(stub, (process) => {
      const store = process.store;
      for (let index = 0; index < 5; index += 1) {
        store.messages.appendMessage(
          "user",
          `${index}:${"x".repeat(index === 0 ? 50_000 : 10_000)}`,
          {},
        );
      }
      store.messages.appendMessage("user", "keep", {});
      process.runs.active = {
        runId: "config-source",
        config: terminalTestConfig(pid),
      };
      const checkpointConfig = process.runs.active.config;
      process.runs.active = null;
      process.history.resolveCheckpointConfig = async () => checkpointConfig;
      process.generation = {
        async generateText(request: any) {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const content = request.context.messages[0].content as string;
          transcript = content
            .slice("Process history segment JSONL:\n".length)
            .split("\n\nWrite the replacement summary", 1)[0];
          return "Summary.";
        },
      };
    });

    const response = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 1,
        generateSummary: true,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(response.data).toMatchObject({ ok: true, archivedMessages: 5 });
    expect(transcript.length).toBeLessThanOrEqual(24_000);
    const records = transcript.split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ record_truncated: true }),
        expect.objectContaining({ omitted_messages: expect.any(Number) }),
      ]),
    );

    await runInProcess(stub, (process) => {
      process.runs.active = null;
    });
  });

  it("discards a generated compaction when its history changes", async () => {
    const pid = "mech-conversation-compact-stale";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      process.store.messages.appendMessage("user", "old", {});
      process.store.messages.appendMessage("user", "keep", {});
      process.runs.active = {
        runId: "config-source",
        config: terminalTestConfig(pid),
      };
      const checkpointConfig = process.runs.active.config;
      process.runs.active = null;
      process.history.resolveCheckpointConfig = async () => checkpointConfig;
      process.generation = {
        async generateText() {
          process.store.resetHistory();
          return "Stale summary.";
        },
      };
    });

    const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
    const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix })).objects.map(
      (object) => object.key,
    );
    const response = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 1,
        generateSummary: true,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(response.data).toEqual({ ok: false, error: "History changed during compaction" });
    expect(
      (await env.STORAGE.list({ prefix: archivePrefix })).objects.map((object) => object.key),
    ).toEqual(archivesBefore);
    await runInProcess(stub, (process) => {
      expect(process.store.history.listHistorySegments()).toHaveLength(0);
      process.runs.active = null;
    });
  });

  it("rejects a concurrent compaction after another summary replaces its prefix", async () => {
    const pid = "mech-conversation-compact-concurrent";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
    const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix })).objects.map(
      (object) => object.key,
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const result = await runInProcess(stub, async (process) => {
      let generationCalls = 0;
      const { promise: firstBlocked, resolve: releaseFirst } = deferred();
      const { promise: firstStarted, resolve: markFirstStarted } = deferred();
      process.store.messages.appendMessage("user", "old", {});
      process.store.messages.appendMessage("user", "keep", {});
      process.runs.active = {
        runId: "config-source",
        config: terminalTestConfig(pid),
      };
      const checkpointConfig = process.runs.active.config;
      process.runs.active = null;
      process.history.resolveCheckpointConfig = async () => checkpointConfig;
      process.generation = {
        async generateText() {
          generationCalls += 1;
          if (generationCalls === 1) {
            markFirstStarted();
            await firstBlocked;
            return "First summary.";
          }
          return "Second summary.";
        },
      };

      const first = process.recvFrame(
        makeReq("proc.history.compact", {
          keepLast: 1,
          generateSummary: true,
        }),
      );
      await firstStarted;
      const second = await okProcessResponse(
        process,
        makeReq("proc.history.compact", {
          keepLast: 1,
          generateSummary: true,
          // SAFETY: test fixture is constructed with the asserted domain shape.
        }),
      );
      releaseFirst();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const stale = (await first) as ResponseOkFrame;
      const messages = process.store.messages.getMessages();
      const segments = process.store.history.listHistorySegments();
      process.runs.active = null;
      return { second, stale, messages, segments };
    });

    expect(result.second.data).toMatchObject({ ok: true, archivedMessages: 1 });
    expect(result.stale.data).toEqual({ ok: false, error: "History changed during compaction" });
    expect(result.messages[0].content).toContain("Second summary.");
    expect(result.segments).toHaveLength(1);
    expect(
      (await env.STORAGE.list({ prefix: archivePrefix })).objects.filter(
        (object) => !archivesBefore.includes(object.key),
      ),
    ).toHaveLength(1);
  });

  it("rolls back the summary when recording its segment fails", async () => {
    const pid = "mech-conversation-compact-transaction";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("user", "old", {});
      store.messages.appendMessage("user", "keep", {});
      store.history.recordHistorySegment = () => {
        throw new Error("segment insert failed");
      };
    });

    const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
    const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix })).objects.map(
      (object) => object.key,
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await stub.recvFrame(
      makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "Summary.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    )) as ResponseFrame;
    expect(response).toMatchObject({
      ok: false,
      error: { message: "segment insert failed" },
    });
    expect(
      (await env.STORAGE.list({ prefix: archivePrefix })).objects.map((object) => object.key),
    ).toEqual(archivesBefore);
    await runInProcess(stub, (process) => {
      expect(process.store.messages.getMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "old" }),
          expect.objectContaining({ role: "user", content: "keep" }),
        ]),
      );
    });
  });

  it("reads compacted segment archives with pagination", async () => {
    const pid = "mech-conversation-segment-read";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("user", "old user", { createdAt: 10 });
      store.messages.appendMessage("assistant", "old assistant", { createdAt: 20 });
      store.messages.appendToolResult("tool-1", "fs.read", "permission denied", true);
      store.messages.appendMessage("user", "keep this", { createdAt: 30 });
    });

    const compactRes = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "Earlier context.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const compactData = compactRes.data as any;

    const firstPageRes = await okProcessResponse(
      stub,
      makeReq("proc.history.segment.read", {
        segmentId: compactData.segment.id,
        limit: 1,
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const firstPage = firstPageRes.data as any;
    expect(firstPage).toMatchObject({
      ok: true,
      pid,
      messageCount: 3,
      truncated: true,
      segment: {
        id: compactData.segment.id,
        archivePath: compactData.archivedTo,
      },
    });
    expect(firstPage.messages).toEqual([
      {
        id: expect.any(Number),
        role: "user",
        content: "old user",
        timestamp: 10,
      },
    ]);

    const secondPageRes = await okProcessResponse(
      stub,
      makeReq("proc.history.segment.read", {
        segmentId: compactData.segment.id,
        limit: 1,
        offset: 1,
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((secondPageRes.data as any).messages).toEqual([
      {
        id: expect.any(Number),
        role: "assistant",
        content: {
          text: "old assistant",
          thinking: [],
          toolCalls: [],
          // SAFETY: test fixture is constructed with the asserted domain shape.
        },
        timestamp: 20,
      },
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((secondPageRes.data as any).truncated).toBe(true);

    const toolResultPageRes = await okProcessResponse(
      stub,
      makeReq("proc.history.segment.read", {
        segmentId: compactData.segment.id,
        limit: 1,
        offset: 2,
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((toolResultPageRes.data as any).messages).toEqual([
      {
        id: expect.any(Number),
        role: "toolResult",
        content: {
          toolName: "Read",
          isError: true,
          outcome: "failed",
          toolCallId: "tool-1",
          output: "permission denied",
        },
        timestamp: expect.any(Number),
      },
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((toolResultPageRes.data as any).truncated).toBe(false);
  });

  it("retains assistant media references when reading a compacted segment", async () => {
    const pid = "mech-conversation-segment-assistant-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const activeKey = `var/media/0/${pid}/result.png`;
    await env.STORAGE.put(activeKey, new Uint8Array([7, 8, 9]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        uid: "0",
        gid: "0",
        mode: "400",
        processId: pid,
      },
    });
    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("assistant", "Here is the result.", {
        createdAt: 20,
        media: JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            filename: "result.png",
            size: 3,
            key: activeKey,
            path: `/${activeKey}`,
          },
        ]),
      });
      store.messages.appendMessage("user", "keep this", {
        createdAt: 30,
      });
    });

    const compactRes = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "Earlier context.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const segment = (compactRes.data as any).segment;
    const segmentRes = await okProcessResponse(
      stub,
      makeReq("proc.history.segment.read", {
        segmentId: segment.id,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const media = (segmentRes.data as any).messages[0].content.media[0];

    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((segmentRes.data as any).messages[0]).toMatchObject({
      role: "assistant",
      content: {
        text: "Here is the result.",
        thinking: [],
        toolCalls: [],
      },
      timestamp: 20,
    });
    expect(media).toMatchObject({
      type: "image",
      mimeType: "image/png",
      filename: "result.png",
      size: 3,
      key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
    });
    expect(media.path).toBe(`/${media.key}`);
    expect(await env.STORAGE.head(activeKey)).toBeNull();

    const archived = await env.STORAGE.get(media.key);
    expect(archived && [...new Uint8Array(await archived.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  it("rejects compaction while the process is active", async () => {
    const pid = "mech-conversation-compact-active";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("user", "active message");
      process.runs.active = {
        runId: "run-active-compact",
      };
    });

    const compactRes = await okProcessResponse(
      stub,
      makeReq("proc.history.compact", {
        keepLast: 0,
        summary: "Should fail.",
      }),
    );
    expect(compactRes.data).toEqual({
      ok: false,
      error: "Process is active",
    });

    await runInProcess(stub, (process) => {
      process.runs.active = null;
    });
  });

  it("cancels manual archive upload by request id", async () => {
    const pid = "mech-conversation-compact-cancel";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: started, resolve: markStarted } = deferred();
      process.store.messages.appendMessage("user", "old", {});
      process.store.messages.appendMessage("user", "keep", {});
      process.history.archiveMessageRecords = async (
        _key: string,
        _messages: ProcessTestValue[],
        signal: AbortSignal,
      ) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };

      const requestId = "compact-cancel-1";
      const execution = process.recvFrame({
        type: "req",
        id: requestId,
        call: "proc.history.compact",
        args: { keepLast: 1, summary: "Summary." },
      });
      await started;
      await process.recvFrame({
        type: "sig",
        signal: REQUEST_CANCEL_SIGNAL,
        payload: { id: requestId, reason: "new user message" },
      });

      await expect(execution).resolves.toMatchObject({
        type: "res",
        id: requestId,
        ok: true,
        data: { ok: false, error: "Compaction was cancelled" },
      });
      expect(process.store.history.listHistorySegments()).toHaveLength(0);
    });
  });

  it("gets and sets process history context policy", async () => {
    const pid = "mech-conversation-policy";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const defaultRes = await okProcessResponse(stub, makeReq("proc.history.policy.get", {}));
    expect(defaultRes.data).toMatchObject({
      ok: true,
      pid,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.9,
        compactToPressure: 0.4,
        updatedAt: 0,
      },
    });

    const setRes = await okProcessResponse(
      stub,
      makeReq("proc.history.policy.set", {
        overflow: "auto-compact",
        compactAtPressure: 0.82,
        compactToPressure: 0.35,
      }),
    );
    expect(setRes.data).toMatchObject({
      ok: true,
      pid,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.82,
        compactToPressure: 0.35,
      },
    });

    const nextRes = await okProcessResponse(stub, makeReq("proc.history.policy.get", {}));
    expect(nextRes.data).toMatchObject({
      ok: true,
      pid,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.82,
        compactToPressure: 0.35,
      },
    });
  });

  it("defaults old stored keep-last policies to the pressure target", async () => {
    const pid = "mech-conversation-policy-legacy-keep-last";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.state.setValue(
        "historyPolicy",
        JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          keepLast: 80,
          updatedAt: 123,
        }),
      );
    });

    // SAFETY: this request is a proc.history.policy.get frame with a successful fixture response.
    const response = await okProcessResponse(stub, makeReq("proc.history.policy.get", {}));
    expect(response.data).toMatchObject({
      ok: true,
      pid,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.9,
        compactToPressure: 0.4,
        updatedAt: 123,
      },
    });
  });

  it("auto-compacts once before falling back while the rebuilt context still fits", async () => {
    const pid = "mech-conversation-auto-compact";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const emitted = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      let summaryCalls = 0;
      mockGeneration(process, async (request: any) => {
        generationCalls += 1;
        const serialized = JSON.stringify(request.context);
        expect(serialized).toContain("Context that must stay live.");
        expect(serialized).toContain("Auto compact summary.");
        expect(serialized).not.toContain("old context A");
        if (generationCalls === 1) {
          return assistantResponse([], {
            provider: request.config.provider,
            model: request.config.model,
            stopReason: "error",
            errorMessage: "Custom provider HTTP 403: not authenticated",
            usage: testUsage(1, 0)
          });
        }
        return assistantResponse([
          { type: "text", text: "after compaction" },
          messageAction("after compaction", "auto-compaction-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: {
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 110,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          }
        });
      }, async (request: any) => {
        summaryCalls += 1;
        expect(request.options).toMatchObject({
          maxTokens: 768,
          reasoning: "off",
          timeoutMs: 180000,
        });
        expect(JSON.stringify(request.context)).toContain("old context A");
        return "Auto compact summary.";
      });

      process.store.messages.appendMessage("user", `old context A ${"x".repeat(4000)}`);
      process.store.messages.appendMessage("assistant", `old context B ${"y".repeat(4000)}`);
      process.store.messages.appendMessage("user", "Context that must stay live.", {
        runId: "run-auto-compact",
      });
      setHistoryPolicy(process);
      process.runs.active = generationRun("run-auto-compact", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/test/model",
        maxTokens: 100,
        contextWindowTokens: 1000,
        generationTimeoutMs: 180000,
        fallbacks: [
          {
            provider: "openrouter",
            model: "fallback-model",
            apiKey: "fallback-key",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            generationTimeoutMs: 180000,
          },
        ]
      }));
      await process.run.runTick("run-auto-compact");
      return {
        emitted,
        generationCalls,
        summaryCalls,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(emitted.generationCalls).toBe(2);
    expect(emitted.summaryCalls).toBe(1);
    expect(
      emitted.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["system", expect.stringContaining("Auto compact summary.")],
      ["user", "Context that must stay live."],
      ["assistant", "after compaction"],
    ]);
    expect(emitted.segments).toHaveLength(1);
    expect(emitted.segments[0]).toMatchObject({
      kind: "compaction",
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const lifecycleEvents = emitted.emitted
      .filter((entry) => entry.signal === "proc.changed")
      // SAFETY: test fixture is constructed with the asserted domain shape.
      .map((entry) => (entry.payload as any).event)
      .filter(Boolean);
    expect(lifecycleEvents).toEqual(["history.compacted", "history.auto_compacted"]);
  });

  it("compacts a large recent history to the pressure target instead of recompacting only its summary", async () => {
    const pid = "mech-conversation-auto-compact-pressure-target";
    const runId = "run-auto-compact-pressure-target";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const generationContexts: Context[] = [];
      process.sendSignal = async () => {};
      mockGeneration(process, async (request: any) => {
        generationContexts.push(request.context);
        return terminalTestResponse([
          { type: "text", text: "done" },
          messageAction("done", "pressure-target-message"),
        ]);
      }, async () => {
        return "Pressure-target summary.";
      });

      process.store.messages.appendMessage(
        "system",
        [
          "Process history compacted.",
          "",
          "Archived messages: 200",
          "Archive: /home/root/processes/prior.jsonl.gz",
          "",
          "Summary:",
          "Prior compacted history.",
        ].join("\n"),
      );
      for (let index = 0; index < 79; index += 1) {
        process.store.messages.appendMessage(
          index % 2 === 0 ? "user" : "assistant",
          `large recent message ${index} ${"x".repeat(6000)}`,
        );
      }
      process.store.messages.appendMessage("user", "Current input must stay live.", { runId });
      setHistoryPolicy(process);
      process.runs.active = generationRun(runId, {
        ...terminalTestConfig(pid),
        generationTimeoutMs: 180000,
      });

      await process.run.runTick(runId);
      return {
        generationContext: generationContexts[0],
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(result.generationContext).toBeDefined();
    if (!result.generationContext) {
      throw new Error("Expected automatic compaction to reach model generation");
    }
    expect(
      estimateContextInputTokens(result.generationContext) / (128000 - 8192),
    ).toBeLessThanOrEqual(0.4);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      kind: "compaction",
      fromMessageId: 1,
    });
    expect(result.segments[0]!.toMessageId).toBeGreaterThan(1);
    expect(
      result.messages.some(
        (message: any) =>
          message.role === "user" && message.content === "Current input must stay live.",
      ),
    ).toBe(true);
  });
});
