import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { getProcessByPid } from "../shared/utils";

describe("ProcessStore", () => {
  describe("history", () => {
    it("resets history by clearing messages and incrementing generation", async () => {
      const stub = await getProcessByPid("history-reset");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "old message");

        expect(store.resetHistory()).toBe(2);
        expect(store.messageCount()).toBe(0);
        expect(store.getHistoryGeneration()).toBe(2);
      });
    });

    it("compacts a history prefix and records a segment", async () => {
      const stub = await getProcessByPid("history-compact-store");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const firstId = store.appendMessage("user", "old one");
        const secondId = store.appendMessage("assistant", "old two");
        const thirdId = store.appendMessage("user", "keep me");

        const prefix = store.getHistoryPrefixMessages({ keepLast: 1 });
        expect(prefix.map((message: any) => message.id)).toEqual([firstId, secondId]);

        const summaryId = store.compactHistoryPrefix({
          generation: 1,
          fromMessageId: firstId,
          toMessageId: secondId,
          summary: "History compacted.\n\nSummary:\nOld work.",
        });
        const segment = store.recordHistorySegment({
          id: "segment-1",
          generation: 1,
          kind: "compaction",
          fromMessageId: firstId,
          toMessageId: secondId,
          archivePath: "/var/sessions/root/pid/history/segment-1.jsonl.gz",
          summaryMessageId: summaryId,
        });

        expect(segment.summaryMessageId).toBe(firstId);
        expect(store.listHistorySegments()).toEqual([
          expect.objectContaining({
            id: "segment-1",
            kind: "compaction",
            fromMessageId: firstId,
            toMessageId: secondId,
            summaryMessageId: firstId,
          }),
        ]);
        expect(store.getHistorySegment("segment-1")).toMatchObject({ id: "segment-1" });
        const messages = store.getMessages();
        expect(messages.map((message: any) => [message.id, message.role, message.content])).toEqual([
          [firstId, "system", "History compacted.\n\nSummary:\nOld work."],
          [thirdId, "user", "keep me"],
        ]);
      });
    });

    it("keeps parallel tool exchanges on one side of a compaction boundary", async () => {
      const stub = await getProcessByPid("history-compact-tool-boundary");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const oldUserId = store.appendMessage("user", "old");
        const assistantId = store.appendMessage("assistant", "checking", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
            { type: "toolCall", id: "call-2", name: "Read", arguments: {} },
          ]),
        });
        const eventId = store.appendMessage("system", "still working");
        const secondResultId = store.appendToolResult("call-2", "fs.read", "two", false);
        const firstResultId = store.appendToolResult("call-1", "fs.read", "one", false);
        store.appendMessage("assistant", "done");
        store.appendMessage("user", "new");

        expect(store.getHistoryPrefixMessages({
          keepLast: 3,
        }).map((message: any) => message.id)).toEqual([oldUserId]);

        expect(store.getHistoryPrefixMessages({
          throughMessageId: assistantId,
        }).map((message: any) => message.id)).toEqual([
          oldUserId,
          assistantId,
          eventId,
          secondResultId,
          firstResultId,
        ]);
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
        store.appendMessage("user", "hello world");
        const msgs = store.getMessages();
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
        store.appendMessage("user", "look at this", {
          media: JSON.stringify([
            {
              type: "image",
              mimeType: "image/png",
              key: "var/media/0/pid/123.png",
            },
          ]),
        });
        const msgs = store.getMessages();
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
        store.appendMessage("user", "hello from a run", { runId: "run-message-1" });
        const msgs = store.getMessages();
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
        const id = store.appendMessage("assistant", "priced response", {
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

        const message = store.getMessages()[0];
        expect(id).toBe(message.id);
        expect(JSON.parse(message.metadata)).toMatchObject({
          provider: { provider: "workers-ai" },
          usage: { inputTokens: 1000, outputTokens: 250 },
        });
        expect(store.getHistoryUsage()).toMatchObject({
          inputTokens: 1000,
          outputTokens: 250,
          totalTokens: 1250,
          cost: { total: 0.000875, source: "model-pricing" },
          generations: 1,
        });

        // SAFETY: test fixture is constructed with the asserted domain shape.
        const piMessage = store.toMessages()[0] as any;
        expect(piMessage.provider).toBe("workers-ai");
        expect(piMessage.model).toBe("@cf/nvidia/nemotron-3-120b-a12b");
        expect(piMessage.usage.cost.total).toBe(0.000875);
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
        store.appendMessage("assistant", "Let me read that file.", { toolCalls });
        const msgs = store.getMessages();
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
        expect(store.messageCount()).toBe(0);
        store.appendMessage("user", "one");
        store.appendMessage("assistant", "two");
        store.appendMessage("user", "three");
        expect(store.messageCount()).toBe(3);
      });
    });

    it("getMessages respects limit and offset", async () => {
      const stub = await getProcessByPid("msg-pagination");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 5; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
        const page = store.getMessages({ limit: 2, offset: 1 });
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
          store.appendMessage("user", `msg-${i}`);
        }
        const defaultMessages = store.getMessages();
        expect(defaultMessages).toHaveLength(200);
        expect(defaultMessages[199].content).toBe("msg-199");

        const allMessages = store.getMessages({ limit: null });
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
        expect(store.messageStats()).toEqual({ count: 0, firstMessageId: null, lastMessageId: null });

        const firstId = store.appendMessage("user", "one");
        const secondId = store.appendMessage("assistant", "two");
        expect(store.messageStats()).toEqual({ count: 2, firstMessageId: firstId, lastMessageId: secondId });
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
          store.appendMessage("user", `msg-${i}`);
        }

        const tail = store.getMessages({ tail: true, limit: 3 });
        expect(tail.map((message: any) => message.content)).toEqual(["msg-7", "msg-8", "msg-9"]);

        const older = store.getMessages({ beforeMessageId: tail[0].id, limit: 3 });
        expect(older.map((message: any) => message.content)).toEqual(["msg-4", "msg-5", "msg-6"]);
        expect(store.hasMessageBefore(older[0].id)).toBe(true);
        expect(store.hasMessageAfter(older[2].id)).toBe(true);

        const newer = store.getMessages({ afterMessageId: older[2].id, limit: 2 });
        expect(newer.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
      });
    });

    it("clearMessages removes all and returns count", async () => {
      const stub = await getProcessByPid("msg-clear");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "a");
        store.appendMessage("assistant", "b");
        const cleared = store.clearMessages();
        expect(cleared).toBe(2);
        expect(store.messageCount()).toBe(0);
      });
    });

    it("keeps history usage through compaction and clears it on reset", async () => {
      const stub = await getProcessByPid("history-usage-compaction");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const firstId = store.appendMessage("user", "old one");
        const secondId = store.appendMessage("assistant", "old two", {
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
        store.appendMessage("user", "keep me");

        store.compactHistoryPrefix({
          generation: 1,
          fromMessageId: firstId,
          toMessageId: secondId,
          summary: "Summary.",
        });
        expect(store.getHistoryUsage()?.cost?.total).toBe(0.00008);

        store.resetHistory();
        expect(store.getHistoryUsage()).toBeNull();
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
        store.appendToolResult(
          "call_1",
          "fs.read",
          "Error: User interrupted tool execution",
          true,
          "run-tool-1",
          "cancelled",
        );
        const msgs = store.getMessages();
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
        store.appendToolResult("call_2", "shell.exec", "output", false);
        const meta = JSON.parse(store.getMessages()[0].toolCalls!);
        expect(meta.toolName).toBe("Shell");
      });
    });

    it("stores isError=true for error results", async () => {
      const stub = await getProcessByPid("tool-result-3");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendToolResult("call_3", "fs.write", "EPERM: permission denied", true);
        const meta = JSON.parse(store.getMessages()[0].toolCalls!);
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
        const media = JSON.stringify([{
          type: "image",
          mimeType: "image/png",
          key: "var/media/0/tool-result-media/image",
        }]);
        store.appendToolResult(
          "call_media",
          "fs.read",
          "image metadata",
          false,
          "run-tool-media",
          "completed",
          media,
        );

        expect(store.getMessages()[0].media).toBe(media);
        expect(store.toMessages()[0].content).toEqual([
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
        store.appendToolResult(
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

        const message = store.toMessages()[0];
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
        store.appendMessage("user", "hello");
        const msgs = store.toMessages();
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
        store.appendMessage("user", "See attachment", {
          media: JSON.stringify([
            {
              type: "image",
              mimeType: "image/png",
              key: "var/media/0/pid/abc.png",
              filename: "abc.png",
            },
          ]),
        });
        const msgs = store.toMessages();
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
        store.appendMessage("assistant", "Hello there!");
        const msgs = store.toMessages();
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
        store.appendMessage("assistant", "Reading file...", {
          toolCalls: JSON.stringify(toolCalls),
        });
        const msgs = store.toMessages();
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
        store.appendMessage("assistant", "Reading file...", {
          toolCalls: JSON.stringify({
            thinking: [
              { type: "thinking", thinking: "First inspect the workspace." },
            ],
            toolCalls: [
              { type: "toolCall", id: "call_1", name: "Read", arguments: { path: "/etc/hostname" } },
            ],
          }),
        });

        const msgs = store.toMessages();
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
        store.appendToolResult("call_1", "fs.read", "gsv", false);
        const msgs = store.toMessages();
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
        store.appendMessage("user", "What is my hostname?");
        store.appendMessage("assistant", "Let me check.", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "c1", name: "Read", arguments: { path: "/etc/hostname" } },
          ]),
        });
        store.appendToolResult("c1", "fs.read", "gsv-host", false);
        store.appendMessage("assistant", "Your hostname is gsv-host.");

        const msgs = store.toMessages();
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
        store.enqueue("run-1", "first message");
        store.enqueue("run-2", "second message");
        store.enqueue("run-3", "third message");

        expect(store.queueSize()).toBe(3);

        const first = store.dequeue();
        expect(first).not.toBeNull();
        expect(first!.message).toBe("first message");
        expect(first!.runId).toBe("run-1");

        const second = store.dequeue();
        expect(second!.message).toBe("second message");

        expect(store.queueSize()).toBe(1);
      });
    });

    it("dequeue returns null on empty queue", async () => {
      const stub = await getProcessByPid("queue-empty");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.dequeue()).toBeNull();
      });
    });

    it("drainQueue returns all and clears", async () => {
      const stub = await getProcessByPid("queue-drain");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.enqueue("r1", "msg-a");
        store.enqueue("r2", "msg-b");
        store.enqueue("r3", "msg-c");

        const all = store.drainQueue();
        expect(all).toHaveLength(3);
        expect(all[0].message).toBe("msg-a");
        expect(all[2].message).toBe("msg-c");
        expect(store.queueSize()).toBe(0);
      });
    });

    it("drainQueue returns empty array on empty queue", async () => {
      const stub = await getProcessByPid("queue-drain-empty");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.drainQueue()).toEqual([]);
      });
    });

    it("enqueue stores optional media", async () => {
      const stub = await getProcessByPid("queue-meta");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.enqueue("r1", "hello", { media: '["img.png"]' });
        const item = store.dequeue();
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
          eventId: "mail-event-1",
          eventType: "mail.received",
          contentTrust: "untrusted",
        });
        store.enqueue("mail-run-1", "mail arrived", {
          role: "system",
          kind: "mail.received",
          provenance,
        });

        expect(store.dequeue()).toMatchObject({
          runId: "mail-run-1",
          role: "system",
          kind: "mail.received",
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
        store.register("dispatch_1", "call_1", "run_1", "fs.read", { path: "/etc/hostname" });
        expect(store.getPending("dispatch_1")).not.toBeNull();
        expect(store.isRunResolved("run_1")).toBe(false);

        expect(store.resolve("dispatch_1", { content: "gsv" })).toBe(true);
        expect(store.resolve("dispatch_1", { content: "late" })).toBe(false);
        expect(store.getPending("dispatch_1")).toBeNull();
        expect(store.isRunResolved("run_1")).toBe(true);

        const results = store.getResults("run_1");
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
        store.register("dispatch_1", "call_1", "run_1", "fs.read", { path: "/tmp/input" });
        expect(store.getResults("run_1")[0].status).toBe("registered");

        expect(store.markDispatched("dispatch_1")).toBe(true);
        expect(store.markDispatched("dispatch_1")).toBe(false);
        expect(store.getResults("run_1")[0].status).toBe("pending");
      });
    });

    it("register and fail", async () => {
      const stub = await getProcessByPid("tc-fail");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.register("dispatch_2", "call_2", "run_2", "fs.write", { path: "/root/x" });
        store.fail("dispatch_2", "EPERM");
        expect(store.isRunResolved("run_2")).toBe(true);
        const results = store.getResults("run_2");
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
        store.register("dispatch_denied", "call_denied", "run_denied", "fs.read", {});
        store.fail("dispatch_denied", "Tool execution denied by user", "denied");

        expect(store.getResults("run_denied")).toMatchObject([{
          status: "error",
          outcome: "denied",
        }]);
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("classifies a resolved failure envelope as failed", async () => {
      const stub = await getProcessByPid("tc-resolved-failure");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.register(
          "dispatch_resolved_failure",
          "call_resolved_failure",
          "run_resolved_failure",
          "shell.exec",
          {},
        );
        store.resolve("dispatch_resolved_failure", {
          status: "failed",
          error: "command could not start",
        });

        expect(store.getResults("run_resolved_failure")).toMatchObject([{
          status: "completed",
          outcome: "failed",
        }]);
      });
    });

    it("ignores late dispatch results when a provider tool id is reused", async () => {
      const stub = await getProcessByPid("tc-reused-provider-id");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.register(
          "dispatch_old",
          "call_reused",
          "run_old",
          "fs.read",
          { path: "/old" },
        );
        expect(store.getPending("dispatch_old")).toMatchObject({
          runId: "run_old",
        });

        store.register(
          "dispatch_new",
          "call_reused",
          "run_new",
          "fs.read",
          { path: "/new" },
        );
        expect(store.getPending("dispatch_old")).not.toBeNull();
        expect(store.getPending("dispatch_new")).toMatchObject({
          runId: "run_new",
        });

        store.resolve("dispatch_old", { content: "stale" });
        store.fail("dispatch_old", "stale failure");
        expect(store.getPending("dispatch_new")).not.toBeNull();

        store.resolve("dispatch_new", { content: "fresh" });
        expect(store.getResults("run_old")).toMatchObject([{
          id: "call_reused",
          dispatchId: "dispatch_old",
          status: "completed",
          result: { content: "stale" },
        }]);
        expect(store.getResults("run_new")).toMatchObject([{
          id: "call_reused",
          status: "completed",
          result: { content: "fresh" },
        }]);
      });
    });

    it("isRunResolved waits for all calls", async () => {
      const stub = await getProcessByPid("tc-multi");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.register("dispatch_c1", "c1", "run_3", "fs.read", {});
        store.register("dispatch_c2", "c2", "run_3", "shell.exec", {});
        expect(store.isRunResolved("run_3")).toBe(false);

        store.resolve("dispatch_c1", "ok");
        expect(store.isRunResolved("run_3")).toBe(false);

        store.resolve("dispatch_c2", "ok");
        expect(store.isRunResolved("run_3")).toBe(true);
      });
    });

    it("clearRun removes all entries for a run", async () => {
      const stub = await getProcessByPid("tc-clear");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.register("dispatch_c1", "c1", "run_4", "fs.read", {});
        store.register("dispatch_c2", "c2", "run_4", "fs.write", {});
        store.resolve("dispatch_c1", "ok");
        store.resolve("dispatch_c2", "ok");
        store.clearRun("run_4");
        expect(store.getResults("run_4")).toHaveLength(0);
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
        expect(store.getValue("foo")).toBeNull();
        store.setValue("foo", "bar");
        expect(store.getValue("foo")).toBe("bar");
        store.deleteValue("foo");
        expect(store.getValue("foo")).toBeNull();
      });
    });

    it("setValue overwrites existing values", async () => {
      const stub = await getProcessByPid("kv-2");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.setValue("key", "v1");
        store.setValue("key", "v2");
        expect(store.getValue("key")).toBe("v2");
      });
    });

    it("persists process-local AI config snapshots", async () => {
      const stub = await getProcessByPid("kv-ai-config");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.getAiConfigSnapshot()).toBeNull();

        store.setAiConfigSnapshot({
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

        expect(store.getAiConfigSnapshot()).toMatchObject({
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

        store.clearAiConfigSnapshot();
        expect(store.getAiConfigSnapshot()).toBeNull();
      });
    });
  });
});
