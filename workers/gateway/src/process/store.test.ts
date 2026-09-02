import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { getProcessByPid } from "../shared/utils";
import { normalizeUsageState } from "./store";

it("includes cached tokens when reconstructing a missing usage total", () => {
  expect(
    normalizeUsageState({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
    })?.totalTokens,
  ).toBe(960);
});

describe("ProcessStore", () => {
  describe("history", () => {
    it("stores one immutable context baseline and revisioned delta projections", async () => {
      const stub = await getProcessByPid("history-context-epoch");
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture exercises the internal ProcessStore contract.
        const store = (instance as any).store;
        const responsibility = {
          id: "r12y:00000000-0000-4000-8000-000000000001",
          ownerUid: 1000,
          title: "Finish the handoff",
          source: { kind: "account", uid: 1000, username: "hank" },
          assignee: { kind: "ship" },
          state: "open",
          priority: "normal",
          revision: 1,
          createdAtMs: 100,
          updatedAtMs: 100,
        };
        const epoch = store.epochs.createContextEpoch({
          id: "epoch-1",
          generation: 1,
          systemPrompt: "exact prompt",
          r12yRevision: 1,
          r12yCount: 1,
          r12yBaseline: [responsibility],
          sourceManifest: { version: 2 },
          observedProjection: {
            version: 1,
            runtime: { date: "2026-08-28", timezone: "UTC" },
            targets: [],
            mcpServers: [],
            skills: { mode: "off", entries: [] },
          },
          now: 100,
        });
        const transition = {
          revision: 2,
          responsibilityId: responsibility.id,
          kind: "updated",
          beforeState: "open",
          afterState: "active",
          changedFields: ["state"],
          actor: { kind: "process", processId: "proc:ship" },
          record: { ...responsibility, state: "active", revision: 2, updatedAtMs: 200 },
          createdAtMs: 200,
        };

        expect(epoch).toMatchObject({
          systemPrompt: "exact prompt",
          r12yRevision: 1,
          r12yCount: 1,
          observedR12yRevision: 1,
        });
        expect(
          store.epochs.appendContextEpochTransition(
            epoch.id,
            transition,
            "Responsibility changed.",
            "run-1",
          ),
        ).toBe(2);
        expect(
          store.epochs.appendContextEpochTransition(
            epoch.id,
            transition,
            "must not duplicate",
            "run-1",
          ),
        ).toBe(2);
        expect(store.epochs.listContextEpochTransitions(epoch.id)).toEqual([transition]);
        const nextProjection = {
          version: 1,
          runtime: { date: "2026-08-29", timezone: "UTC" },
          targets: [],
          mcpServers: [],
          skills: { mode: "off", entries: [] },
        };
        store.epochs.appendContextEpochMessage({
          epochId: epoch.id,
          kind: "context.projection",
          observedProjection: nextProjection,
          content: "Current date: 2026-08-29",
          runId: "run-1",
          createdAt: 225,
        });
        expect(store.epochs.getLiveContextEpoch().observedProjection).toEqual(nextProjection);
        store.epochs.recordContextEpochRun(
          "run-1",
          {
            runId: "run-1",
            status: "ok",
            delivery: { kind: "message", conversationId: "conv:ship", messageId: "msg:1" },
          },
          250,
        );
        store.epochs.recordContextEpochRun("run-1", { runId: "run-1", status: "error" }, 251);
        expect(store.epochs.listContextEpochRuns(epoch.id)).toEqual([
          {
            runId: "run-1",
            status: "ok",
            delivery: { kind: "message", conversationId: "conv:ship", messageId: "msg:1" },
          },
        ]);
        expect(store.messages.getMessages().map((message: any) => message.content)).toEqual([
          "Responsibility changed.",
          "Current date: 2026-08-29",
        ]);

        store.epochs.deleteContextEpochOwnedMessages(epoch.id);
        expect(store.messages.getMessages()).toEqual([]);
        expect(
          store.epochs.closeLiveContextEpoch("process.reset", 300, "/epoch.json.gz"),
        ).toMatchObject({
          id: epoch.id,
          state: "closed",
          observedR12yRevision: 2,
          archivePath: "/epoch.json.gz",
        });
      });
    });

    it("resets history by clearing messages and incrementing generation", async () => {
      const stub = await getProcessByPid("history-reset");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "old message");

        expect(store.resetHistory()).toBe(2);
        expect(store.messages.messageCount()).toBe(0);
        expect(store.state.getHistoryGeneration()).toBe(2);
      });
    });

    it("compacts a history prefix and records a segment", async () => {
      const stub = await getProcessByPid("history-compact-store");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const firstId = store.messages.appendMessage("user", "old one");
        const secondId = store.messages.appendMessage("assistant", "old two");
        const thirdId = store.messages.appendMessage("user", "keep me");

        const prefix = store.history.getHistoryPrefixMessages({ keepLast: 1 });
        expect(prefix.map((message: any) => message.id)).toEqual([firstId, secondId]);

        const summaryId = store.history.compactHistoryPrefix({
          generation: 1,
          fromMessageId: firstId,
          toMessageId: secondId,
          summary: "History compacted.\n\nSummary:\nOld work.",
        });
        const segment = store.history.recordHistorySegment({
          id: "segment-1",
          generation: 1,
          kind: "compaction",
          fromMessageId: firstId,
          toMessageId: secondId,
          archivePath: "/var/sessions/root/pid/history/segment-1.jsonl.gz",
          summaryMessageId: summaryId,
        });

        expect(segment.summaryMessageId).toBe(firstId);
        expect(store.history.listHistorySegments()).toEqual([
          expect.objectContaining({
            id: "segment-1",
            kind: "compaction",
            fromMessageId: firstId,
            toMessageId: secondId,
            summaryMessageId: firstId,
          }),
        ]);
        expect(store.history.getHistorySegment("segment-1")).toMatchObject({ id: "segment-1" });
        const messages = store.messages.getMessages();
        expect(messages.map((message: any) => [message.id, message.role, message.content])).toEqual(
          [
            [firstId, "system", "History compacted.\n\nSummary:\nOld work."],
            [thirdId, "user", "keep me"],
          ],
        );
      });
    });

    it("keeps parallel tool exchanges on one side of a compaction boundary", async () => {
      const stub = await getProcessByPid("history-compact-tool-boundary");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const oldUserId = store.messages.appendMessage("user", "old");
        const assistantId = store.messages.appendMessage("assistant", "checking", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
            { type: "toolCall", id: "call-2", name: "Read", arguments: {} },
          ]),
        });
        const eventId = store.messages.appendMessage("system", "still working");
        const secondResultId = store.messages.appendToolResult("call-2", "fs.read", "two", false);
        const firstResultId = store.messages.appendToolResult("call-1", "fs.read", "one", false);
        store.messages.appendMessage("assistant", "done");
        store.messages.appendMessage("user", "new");

        expect(
          store.history
            .getHistoryPrefixMessages({
              keepLast: 3,
            })
            .map((message: any) => message.id),
        ).toEqual([oldUserId]);

        expect(
          store.history
            .getHistoryPrefixMessages({
              throughMessageId: assistantId,
            })
            .map((message: any) => message.id),
        ).toEqual([oldUserId, assistantId, eventId, secondResultId, firstResultId]);
      });
    });

    it("closes legacy tool exchanges with empty call ids at compaction boundaries", async () => {
      const stub = await getProcessByPid("history-compact-empty-tool-call-id");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const summaryId = store.messages.appendMessage("system", "Process history compacted.");
        const assistantId = store.messages.appendMessage("assistant", "", {
          toolCalls: JSON.stringify([{ type: "toolCall", id: "", name: "", arguments: {} }]),
        });
        const resultId = store.messages.appendToolResult(
          "",
          "",
          'Tool "" was not offered for this generation',
          true,
        );
        const completedUserId = store.messages.appendMessage("user", "completed input");
        const completedAssistantId = store.messages.appendMessage(
          "assistant",
          "completed response",
        );
        store.messages.appendMessage("user", "active input", { runId: "active-run" });

        expect(
          store.history
            .getHistoryPrefixMessages({
              throughMessageId: completedAssistantId,
            })
            .map((message: any) => message.id),
        ).toEqual([summaryId, assistantId, resultId, completedUserId, completedAssistantId]);
      });
    });
  });

  // ---------- Message CRUD ----------

  describe("messages", () => {
    it("appendMessage stores and retrieves a user message", async () => {
      const stub = await getProcessByPid("msg-crud-1");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "hello world");
        const msgs = store.messages.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("user");
        expect(msgs[0].content).toBe("hello world");
        expect(msgs[0].toolCalls).toBeNull();
        expect(msgs[0].toolCallId).toBeNull();
      });
    });

    it("appendMessage stores optional media metadata", async () => {
      const stub = await getProcessByPid("msg-crud-media");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "look at this", {
          media: JSON.stringify([
            {
              type: "image",
              mimeType: "image/png",
              key: "var/media/0/pid/123.png",
            },
          ]),
        });
        const msgs = store.messages.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].media).toBeTruthy();
      });
    });

    it("appendMessage stores optional run ids", async () => {
      const stub = await getProcessByPid("msg-crud-run-id");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "hello from a run", { runId: "run-message-1" });
        const msgs = store.messages.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].runId).toBe("run-message-1");
      });
    });

    it("appendMessage stores assistant usage metadata and accumulates history usage", async () => {
      const stub = await getProcessByPid("msg-crud-usage-metadata");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const id = store.messages.appendMessage("assistant", "priced response", {
          metadata: {
            provider: {
              api: "workers-ai-binding",
              provider: "workers-ai",
              model: "@cf/nvidia/nemotron-3-120b-a12b",
              stopReason: "stop",
            },
            usage: {
              inputTokens: 1000,
              outputTokens: 250,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1250,
              cost: {
                input: 0.0005,
                output: 0.000375,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.000875,
                currency: "USD",
                source: "model-pricing",
              },
            },
          },
        });

        const message = store.messages.getMessages()[0];
        expect(id).toBe(message.id);
        expect(JSON.parse(message.metadata)).toMatchObject({
          provider: { provider: "workers-ai" },
          usage: { inputTokens: 1000, outputTokens: 250 },
        });
        expect(store.state.getHistoryUsage()).toMatchObject({
          inputTokens: 1000,
          outputTokens: 250,
          totalTokens: 1250,
          cost: { total: 0.000875, source: "model-pricing" },
          generations: 1,
        });

        // SAFETY: test fixture is constructed with the asserted domain shape.
        const piMessage = store.messages.toMessages()[0] as any;
        expect(piMessage.provider).toBe("workers-ai");
        expect(piMessage.model).toBe("@cf/nvidia/nemotron-3-120b-a12b");
        expect(piMessage.usage.cost.total).toBe(0.000875);
      });
    });

    it("exposes assistant usage only inside the exact generation context", async () => {
      const stub = await getProcessByPid("msg-context-epoch-usage");
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test exercises ProcessStore's provider-accounting projection.
        const store = (instance as any).store;
        store.messages.appendMessage("assistant", "old epoch", {
          metadata: {
            contextEpochId: "epoch-a",
            generationContextId: "generation-context:interactive",
            provider: { provider: "openai", model: "gpt-test" },
            usage: {
              inputTokens: 900,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1000,
              cost: null,
            },
          },
        });

        // SAFETY: both fixtures are assistant records created immediately above.
        const matching = store.messages.toMessages({
          contextEpochId: "epoch-a",
          generationContextId: "generation-context:interactive",
        })[0] as any;
        // SAFETY: both fixtures are assistant records created immediately above.
        const different = store.messages.toMessages({ contextEpochId: "epoch-b" })[0] as any;
        // SAFETY: both fixtures are assistant records created immediately above.
        const delegated = store.messages.toMessages({
          contextEpochId: "epoch-a",
          generationContextId: "generation-context:delegated",
        })[0] as any;
        expect(matching.usage.totalTokens).toBe(1000);
        expect(different.usage.totalTokens).toBe(0);
        expect(delegated.usage.totalTokens).toBe(0);
        expect(JSON.parse(store.messages.getMessages()[0].metadata)).toMatchObject({
          contextEpochId: "epoch-a",
          generationContextId: "generation-context:interactive",
        });
      });
    });

    it("appendMessage stores assistant message with tool calls", async () => {
      const stub = await getProcessByPid("msg-crud-2");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const toolCalls = JSON.stringify([
          { type: "toolCall", id: "call_1", name: "Read", arguments: { path: "/etc/hostname" } },
        ]);
        store.messages.appendMessage("assistant", "Let me read that file.", { toolCalls });
        const msgs = store.messages.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("assistant");
        expect(msgs[0].content).toBe("Let me read that file.");
        expect(msgs[0].toolCalls).toBe(toolCalls);
      });
    });

    it("messageCount returns correct count", async () => {
      const stub = await getProcessByPid("msg-count");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.messages.messageCount()).toBe(0);
        store.messages.appendMessage("user", "one");
        store.messages.appendMessage("assistant", "two");
        store.messages.appendMessage("user", "three");
        expect(store.messages.messageCount()).toBe(3);
      });
    });

    it("getMessages respects limit and offset", async () => {
      const stub = await getProcessByPid("msg-pagination");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 5; i++) {
          store.messages.appendMessage("user", `msg-${i}`);
        }
        const page = store.messages.getMessages({ limit: 2, offset: 1 });
        expect(page).toHaveLength(2);
        expect(page[0].content).toBe("msg-1");
        expect(page[1].content).toBe("msg-2");
      });
    });

    it("getMessages uses a bounded default and requires explicit unbounded reads", async () => {
      const stub = await getProcessByPid("msg-no-implicit-limit");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 205; i++) {
          store.messages.appendMessage("user", `msg-${i}`);
        }
        const defaultMessages = store.messages.getMessages();
        expect(defaultMessages).toHaveLength(200);
        expect(defaultMessages[199].content).toBe("msg-199");

        const allMessages = store.messages.getMessages({ limit: null });
        expect(allMessages).toHaveLength(205);
        expect(allMessages[204].content).toBe("msg-204");
      });
    });

    it("messageStats returns count and last message id without reading rows", async () => {
      const stub = await getProcessByPid("msg-stats");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.messages.messageStats()).toEqual({
          count: 0,
          firstMessageId: null,
          lastMessageId: null,
        });

        const firstId = store.messages.appendMessage("user", "one");
        const secondId = store.messages.appendMessage("assistant", "two");
        expect(store.messages.messageStats()).toEqual({
          count: 2,
          firstMessageId: firstId,
          lastMessageId: secondId,
        });
        expect(firstId).toBeLessThan(secondId);
      });
    });

    it("getMessages supports tail and cursor pagination", async () => {
      const stub = await getProcessByPid("msg-tail-pagination");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.messages.appendMessage("user", `msg-${i}`);
        }

        const tail = store.messages.getMessages({ tail: true, limit: 3 });
        expect(tail.map((message: any) => message.content)).toEqual(["msg-7", "msg-8", "msg-9"]);

        const older = store.messages.getMessages({ beforeMessageId: tail[0].id, limit: 3 });
        expect(older.map((message: any) => message.content)).toEqual(["msg-4", "msg-5", "msg-6"]);
        expect(store.messages.hasMessageBefore(older[0].id)).toBe(true);
        expect(store.messages.hasMessageAfter(older[2].id)).toBe(true);

        const newer = store.messages.getMessages({ afterMessageId: older[2].id, limit: 2 });
        expect(newer.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
      });
    });

    it("clearMessages removes all and returns count", async () => {
      const stub = await getProcessByPid("msg-clear");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "a");
        store.messages.appendMessage("assistant", "b");
        const cleared = store.messages.clearMessages();
        expect(cleared).toBe(2);
        expect(store.messages.messageCount()).toBe(0);
      });
    });

    it("keeps history usage through compaction and clears it on reset", async () => {
      const stub = await getProcessByPid("history-usage-compaction");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const firstId = store.messages.appendMessage("user", "old one");
        const secondId = store.messages.appendMessage("assistant", "old two", {
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 120,
              cost: {
                input: 0.00005,
                output: 0.00003,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.00008,
                currency: "USD",
                source: "model-pricing",
              },
            },
          },
        });
        store.messages.appendMessage("user", "keep me");

        store.history.compactHistoryPrefix({
          generation: 1,
          fromMessageId: firstId,
          toMessageId: secondId,
          summary: "Summary.",
        });
        expect(store.state.getHistoryUsage()?.cost?.total).toBe(0.00008);

        store.resetHistory();
        expect(store.state.getHistoryUsage()).toBeNull();
      });
    });
  });

  describe("trace", () => {
    it("records one timed run tree and clears it with history", async () => {
      const stub = await getProcessByPid("process-trace-store");
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture exercises the internal ProcessStore contract.
        const store = (instance as any).store;
        store.traces.startTraceSpan({
          id: "run:trace-run",
          runId: "trace-run",
          kind: "run",
          name: "Run",
          startedAt: 100,
          reference: { kind: "run" },
        });
        store.traces.startTraceSpan({
          id: "context:trace-run",
          runId: "trace-run",
          parentId: "run:trace-run",
          kind: "context",
          name: "Build context",
          startedAt: 110,
        });
        store.traces.finishTraceSpan("context:trace-run", "ok", 140, {
          attributes: { messages: 3 },
        });
        expect(store.traces.getRunTraceStartedAt("trace-run")).toBe(100);
        expect(store.traces.getRunTraceStartedAt("missing-run")).toBeNull();
        store.tools.register("dispatch-1", "call-1", "trace-run", "fs.read", {
          path: "/work/readme.md",
        });
        store.tools.markDispatched("dispatch-1");
        store.tools.resolve("dispatch-1", { ok: true });
        store.traces.finishRunTrace("trace-run", "ok", 200);

        const trace = store.traces.listTraceSpans({ runId: "trace-run", limit: 20 });
        expect(trace.count).toBe(4);
        expect(trace.spans).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "run:trace-run",
              kind: "run",
              status: "ok",
              startedAt: 100,
              endedAt: 200,
            }),
            expect.objectContaining({
              id: "context:trace-run",
              parentId: "run:trace-run",
              status: "ok",
              attributes: { messages: 3 },
            }),
            expect.objectContaining({
              id: "tool:dispatch-1",
              parentId: "run:trace-run",
              status: "ok",
              reference: {
                kind: "tool",
                callId: "call-1",
                executionId: "dispatch-1",
              },
            }),
            expect.objectContaining({
              id: "execution:dispatch-1",
              parentId: "tool:dispatch-1",
              status: "ok",
            }),
          ]),
        );

        store.resetHistory();
        expect(store.traces.listTraceSpans({ limit: 20 })).toEqual({ count: 0, spans: [] });
      });
    });
  });

  // ---------- toolResult role ----------

  describe("appendToolResult", () => {
    it("stores tool result presentation metadata in tool_calls column", async () => {
      const stub = await getProcessByPid("tool-result-1");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendToolResult(
          "call_1",
          "fs.read",
          "Error: User interrupted tool execution",
          true,
          "run-tool-1",
          "cancelled",
        );
        const msgs = store.messages.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("toolResult");
        expect(msgs[0].content).toBe("Error: User interrupted tool execution");
        expect(msgs[0].toolCallId).toBe("call_1");
        expect(msgs[0].runId).toBe("run-tool-1");
        const meta = JSON.parse(msgs[0].toolCalls!);
        expect(meta.toolName).toBe("Read");
        expect(meta.isError).toBe(true);
        expect(meta.outcome).toBe("cancelled");
      });
    });

    it("maps syscall name to LLM tool name", async () => {
      const stub = await getProcessByPid("tool-result-2");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendToolResult("call_2", "shell.exec", "output", false);
        const meta = JSON.parse(store.messages.getMessages()[0].toolCalls!);
        expect(meta.toolName).toBe("Shell");
      });
    });

    it("stores isError=true for error results", async () => {
      const stub = await getProcessByPid("tool-result-3");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendToolResult("call_3", "fs.write", "EPERM: permission denied", true);
        const meta = JSON.parse(store.messages.getMessages()[0].toolCalls!);
        expect(meta.isError).toBe(true);
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("stores tool result media as message references", async () => {
      const stub = await getProcessByPid("tool-result-media");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const media = JSON.stringify([
          {
            type: "image",
            mimeType: "image/png",
            key: "var/media/0/tool-result-media/image",
          },
        ]);
        store.messages.appendToolResult(
          "call_media",
          "fs.read",
          "image metadata",
          false,
          "run-tool-media",
          "completed",
          media,
        );

        expect(store.messages.getMessages()[0].media).toBe(media);
        expect(store.messages.toMessages()[0].content).toEqual([
          { type: "text", text: "image metadata" },
          {
            type: "text",
            text: "Attached image [image/png]\nPath: /var/media/0/tool-result-media/image",
          },
        ]);
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("restores legacy image tool results without presenting base64 as text", async () => {
      const stub = await getProcessByPid("tool-result-legacy-image");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendToolResult(
          "call_legacy_image",
          "fs.read",
          JSON.stringify({
            ok: true,
            content: [
              { type: "text", text: "legacy image" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          }),
          false,
        );

        const message = store.messages.toMessages()[0];
        expect(message.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              content: [
                { type: "text", text: "legacy image" },
                { type: "image", mimeType: "image/png" },
              ],
            }),
          },
          { type: "image", data: "AQID", mimeType: "image/png" },
        ]);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((message.content as any[])[0].text).not.toContain("AQID");
      });
    });
  });

  // ---------- toMessages ----------

  describe("toMessages", () => {
    it("converts user messages to pi-ai format", async () => {
      const stub = await getProcessByPid("to-msg-user");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "hello");
        const msgs = store.messages.toMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("user");
        expect(msgs[0].content).toBe("hello");
        expect(msgs[0].timestamp).toBeGreaterThan(0);
      });
    });

    it("converts user messages with media to fallback text blocks", async () => {
      const stub = await getProcessByPid("to-msg-user-media");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "See attachment", {
          media: JSON.stringify([
            {
              type: "image",
              mimeType: "image/png",
              key: "var/media/0/pid/abc.png",
              filename: "abc.png",
            },
          ]),
        });
        const msgs = store.messages.toMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("user");
        expect(Array.isArray(msgs[0].content)).toBe(true);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((msgs[0].content as any)[0]).toEqual({ type: "text", text: "See attachment" });
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((msgs[0].content as any)[1].type).toBe("text");
      });
    });

    it("converts assistant messages with text", async () => {
      const stub = await getProcessByPid("to-msg-assistant-text");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("assistant", "Hello there!");
        const msgs = store.messages.toMessages();
        expect(msgs).toHaveLength(1);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const msg = msgs[0] as any;
        expect(msg.role).toBe("assistant");
        expect(msg.content[0]).toEqual({ type: "text", text: "Hello there!" });
      });
    });

    it("converts assistant messages with tool calls", async () => {
      const stub = await getProcessByPid("to-msg-assistant-tools");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const toolCalls = [
          { type: "toolCall", id: "call_1", name: "Read", arguments: { path: "/etc/hostname" } },
        ];
        store.messages.appendMessage("assistant", "Reading file...", {
          toolCalls: JSON.stringify(toolCalls),
        });
        const msgs = store.messages.toMessages();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const msg = msgs[0] as any;
        expect(msg.content).toHaveLength(2);
        expect(msg.content[0].type).toBe("text");
        expect(msg.content[1].type).toBe("toolCall");
        expect(msg.content[1].name).toBe("Read");
      });
    });

    it("converts assistant messages with thinking and tool calls", async () => {
      const stub = await getProcessByPid("to-msg-assistant-thinking");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("assistant", "Reading file...", {
          toolCalls: JSON.stringify({
            thinking: [{ type: "thinking", thinking: "First inspect the workspace." }],
            toolCalls: [
              {
                type: "toolCall",
                id: "call_1",
                name: "Read",
                arguments: { path: "/etc/hostname" },
              },
            ],
          }),
        });

        const msgs = store.messages.toMessages();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const msg = msgs[0] as any;
        expect(msg.content).toEqual([
          { type: "thinking", thinking: "First inspect the workspace." },
          { type: "text", text: "Reading file..." },
          { type: "toolCall", id: "call_1", name: "Read", arguments: { path: "/etc/hostname" } },
        ]);
      });
    });

    it("converts toolResult messages", async () => {
      const stub = await getProcessByPid("to-msg-toolresult");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendToolResult("call_1", "fs.read", "gsv", false);
        const msgs = store.messages.toMessages();
        expect(msgs).toHaveLength(1);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const msg = msgs[0] as any;
        expect(msg.role).toBe("toolResult");
        expect(msg.toolCallId).toBe("call_1");
        expect(msg.toolName).toBe("Read");
        expect(msg.isError).toBe(false);
        expect(msg.content[0]).toEqual({ type: "text", text: "gsv" });
      });
    });

    it("converts a full history round-trip", async () => {
      const stub = await getProcessByPid("to-msg-full");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.messages.appendMessage("user", "What is my hostname?");
        store.messages.appendMessage("assistant", "Let me check.", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "c1", name: "Read", arguments: { path: "/etc/hostname" } },
          ]),
        });
        store.messages.appendToolResult("c1", "fs.read", "gsv-host", false);
        store.messages.appendMessage("assistant", "Your hostname is gsv-host.");

        const msgs = store.messages.toMessages();
        expect(msgs).toHaveLength(4);
        expect(msgs[0].role).toBe("user");
        expect(msgs[1].role).toBe("assistant");
        expect(msgs[2].role).toBe("toolResult");
        expect(msgs[3].role).toBe("assistant");
      });
    });
  });

  // ---------- Queue ----------

  describe("message queue", () => {
    it("enqueue and dequeue in FIFO order", async () => {
      const stub = await getProcessByPid("queue-fifo");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.queue.enqueue("run-1", "first message");
        store.queue.enqueue("run-2", "second message");
        store.queue.enqueue("run-3", "third message");

        expect(store.queue.queueSize()).toBe(3);

        const first = store.queue.dequeue();
        expect(first).not.toBeNull();
        expect(first!.message).toBe("first message");
        expect(first!.runId).toBe("run-1");

        const second = store.queue.dequeue();
        expect(second!.message).toBe("second message");

        expect(store.queue.queueSize()).toBe(1);
      });
    });

    it("dequeue returns null on empty queue", async () => {
      const stub = await getProcessByPid("queue-empty");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.queue.dequeue()).toBeNull();
      });
    });

    it("enqueue stores optional media", async () => {
      const stub = await getProcessByPid("queue-meta");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.queue.enqueue("r1", "hello", { media: '["img.png"]' });
        const item = store.queue.dequeue();
        expect(item!.media).toBe('["img.png"]');
      });
    });

    it("preserves queued runtime event semantics", async () => {
      const stub = await getProcessByPid("queue-runtime-event");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const provenance = JSON.stringify({
          source: "kernel",
          eventId: "work-return-1",
          eventType: "adapter.work.returned",
        });
        store.queue.enqueue("work-return-run-1", "the user returned from work", {
          role: "system",
          kind: "adapter.work.returned",
          provenance,
        });

        expect(store.queue.dequeue()).toMatchObject({
          runId: "work-return-run-1",
          role: "system",
          kind: "adapter.work.returned",
          provenance,
        });
      });
    });
  });

  // ---------- Tool calls ----------

  describe("tool calls", () => {
    it("register and resolve", async () => {
      const stub = await getProcessByPid("tc-resolve");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_1", "call_1", "run_1", "fs.read", { path: "/etc/hostname" });
        expect(store.tools.getPending("dispatch_1")).not.toBeNull();
        expect(store.tools.isRunResolved("run_1")).toBe(false);

        expect(store.tools.resolve("dispatch_1", { content: "gsv" })).toBe(true);
        expect(store.tools.resolve("dispatch_1", { content: "late" })).toBe(false);
        expect(store.tools.getPending("dispatch_1")).toBeNull();
        expect(store.tools.isRunResolved("run_1")).toBe(true);

        const results = store.tools.getResults("run_1");
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("completed");
        expect(results[0].result).toEqual({ content: "gsv" });
        expect(results[0].outcome).toBe("completed");
      });
    });

    it("distinguishes registered calls from dispatched calls", async () => {
      const stub = await getProcessByPid("tc-dispatch-state");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_1", "call_1", "run_1", "fs.read", { path: "/tmp/input" });
        expect(store.tools.getResults("run_1")[0].status).toBe("registered");

        expect(store.tools.markDispatched("dispatch_1")).toBe(true);
        expect(store.tools.markDispatched("dispatch_1")).toBe(false);
        expect(store.tools.getResults("run_1")[0].status).toBe("pending");
      });
    });

    it("register and fail", async () => {
      const stub = await getProcessByPid("tc-fail");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_2", "call_2", "run_2", "fs.write", { path: "/root/x" });
        store.tools.fail("dispatch_2", "EPERM");
        expect(store.tools.isRunResolved("run_2")).toBe(true);
        const results = store.tools.getResults("run_2");
        expect(results[0].status).toBe("error");
        expect(results[0].error).toBe("EPERM");
        expect(results[0].outcome).toBe("failed");
      });
    });

    it("persists an explicit user-controlled outcome", async () => {
      const stub = await getProcessByPid("tc-denied");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_denied", "call_denied", "run_denied", "fs.read", {});
        store.tools.fail("dispatch_denied", "Tool execution denied by user", "denied");

        expect(store.tools.getResults("run_denied")).toMatchObject([
          {
            status: "error",
            outcome: "denied",
          },
        ]);
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("classifies a resolved failure envelope as failed", async () => {
      const stub = await getProcessByPid("tc-resolved-failure");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register(
          "dispatch_resolved_failure",
          "call_resolved_failure",
          "run_resolved_failure",
          "shell.exec",
          {},
        );
        store.tools.resolve("dispatch_resolved_failure", {
          status: "failed",
          error: "command could not start",
        });

        expect(store.tools.getResults("run_resolved_failure")).toMatchObject([
          {
            status: "completed",
            outcome: "failed",
          },
        ]);
      });
    });

    it("ignores late dispatch results when a provider tool id is reused", async () => {
      const stub = await getProcessByPid("tc-reused-provider-id");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_old", "call_reused", "run_old", "fs.read", { path: "/old" });
        expect(store.tools.getPending("dispatch_old")).toMatchObject({
          runId: "run_old",
        });

        store.tools.register("dispatch_new", "call_reused", "run_new", "fs.read", { path: "/new" });
        expect(store.tools.getPending("dispatch_old")).not.toBeNull();
        expect(store.tools.getPending("dispatch_new")).toMatchObject({
          runId: "run_new",
        });

        store.tools.resolve("dispatch_old", { content: "stale" });
        store.tools.fail("dispatch_old", "stale failure");
        expect(store.tools.getPending("dispatch_new")).not.toBeNull();

        store.tools.resolve("dispatch_new", { content: "fresh" });
        expect(store.tools.getResults("run_old")).toMatchObject([
          {
            id: "call_reused",
            dispatchId: "dispatch_old",
            status: "completed",
            result: { content: "stale" },
          },
        ]);
        expect(store.tools.getResults("run_new")).toMatchObject([
          {
            id: "call_reused",
            status: "completed",
            result: { content: "fresh" },
          },
        ]);
      });
    });

    it("isRunResolved waits for all calls", async () => {
      const stub = await getProcessByPid("tc-multi");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_c1", "c1", "run_3", "fs.read", {});
        store.tools.register("dispatch_c2", "c2", "run_3", "shell.exec", {});
        expect(store.tools.isRunResolved("run_3")).toBe(false);

        store.tools.resolve("dispatch_c1", "ok");
        expect(store.tools.isRunResolved("run_3")).toBe(false);

        store.tools.resolve("dispatch_c2", "ok");
        expect(store.tools.isRunResolved("run_3")).toBe(true);
      });
    });

    it("clearRun removes all entries for a run", async () => {
      const stub = await getProcessByPid("tc-clear");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.tools.register("dispatch_c1", "c1", "run_4", "fs.read", {});
        store.tools.register("dispatch_c2", "c2", "run_4", "fs.write", {});
        store.tools.resolve("dispatch_c1", "ok");
        store.tools.resolve("dispatch_c2", "ok");
        store.tools.clearRun("run_4");
        expect(store.tools.getResults("run_4")).toHaveLength(0);
      });
    });
  });

  // ---------- KV ----------

  describe("key-value", () => {
    it("set, get, delete", async () => {
      const stub = await getProcessByPid("kv-1");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.state.getValue("foo")).toBeNull();
        store.state.setValue("foo", "bar");
        expect(store.state.getValue("foo")).toBe("bar");
        store.state.deleteValue("foo");
        expect(store.state.getValue("foo")).toBeNull();
      });
    });

    it("setValue overwrites existing values", async () => {
      const stub = await getProcessByPid("kv-2");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.state.setValue("key", "v1");
        store.state.setValue("key", "v2");
        expect(store.state.getValue("key")).toBe("v2");
      });
    });

    it("upgrades a stored legacy context state with absolute budget fields", async () => {
      const stub = await getProcessByPid("kv-context-state-upgrade");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.state.setValue(
          "contextState",
          JSON.stringify({
            provider: "openai",
            model: "gpt-test",
            contextWindowTokens: 1000,
            maxOutputTokens: 100,
            estimatedInputTokens: 400,
            inputTokens: 400,
            availableInputTokens: 900,
            pressure: 400 / 900,
            level: "ok",
            source: "estimate",
            updatedAt: 1,
          }),
        );

        expect(store.state.getContextState()).toMatchObject({
          revision: 0,
          confirmedInputTokens: 0,
          estimatedTrailingInputTokens: 400,
          inputBudgetTokens: 900,
          remainingInputTokens: 500,
          availableInputTokens: 900,
        });
      });
    });

    it("keeps context revisions monotonic when a snapshot is deleted", async () => {
      const stub = await getProcessByPid("kv-context-state-revision");
      // SAFETY: test fixture exercises the internal ProcessStore contract.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture exercises the internal ProcessStore contract.
        const store = (instance as any).store;
        expect(store.state.nextContextStateRevision()).toBe(1);
        store.state.deleteContextState();
        expect(store.state.getContextStateRevision()).toBe(1);
        expect(store.state.nextContextStateRevision()).toBe(2);
        store.resetHistory();
        expect(store.state.getContextStateRevision()).toBe(2);
        expect(store.state.nextContextStateRevision()).toBe(3);
      });
    });

    it("persists process-local AI config snapshots", async () => {
      const stub = await getProcessByPid("kv-ai-config");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.state.getAiConfigSnapshot()).toBeNull();

        store.state.setAiConfigSnapshot({
          version: 1,
          values: {
            "config/ai/provider": "openai",
            "config/ai/model": "gpt-4.1-mini",
            "config/ai/api_key": "sk-test",
          },
          profile: {
            id: "fast",
            name: "Fast",
            appliedAt: 1000,
          },
          updatedAt: 1000,
        });

        expect(store.state.getAiConfigSnapshot()).toMatchObject({
          values: {
            "config/ai/provider": "openai",
            "config/ai/model": "gpt-4.1-mini",
            "config/ai/api_key": "sk-test",
          },
          profile: {
            id: "fast",
            name: "Fast",
          },
        });

        store.state.clearAiConfigSnapshot();
        expect(store.state.getAiConfigSnapshot()).toBeNull();
      });
    });
  });
});
