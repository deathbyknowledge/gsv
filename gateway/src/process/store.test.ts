import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { getProcessByPid } from "../shared/utils";

describe("ProcessStore", () => {
  describe("conversations", () => {
    it("opens and lists conversations", async () => {
      const stub = await getProcessByPid("conversation-open-list");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const opened = store.openConversation({
          conversationId: "side",
          title: "  Side channel  ",
        });

        expect(opened.created).toBe(true);
        expect(opened.conversation).toMatchObject({
          id: "side",
          generation: 1,
          status: "open",
          title: "Side channel",
        });

        const conversationIds = store
          .listConversations()
          .map((conversation: any) => conversation.id)
          .sort();
        expect(conversationIds).toEqual(["default", "side"]);
      });
    });

    it("reopens closed conversations without replacing history", async () => {
      const stub = await getProcessByPid("conversation-reopen");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread", title: "First title" });
        store.appendMessage("user", "hello", { conversationId: "thread" });

        expect(store.closeConversation("thread")).toBe(true);
        expect(store.getConversation("thread").status).toBe("closed");
        expect(store.listConversations().map((conversation: any) => conversation.id)).not.toContain("thread");

        const reopened = store.openConversation({ conversationId: "thread", title: "Second title" });
        expect(reopened.created).toBe(false);
        expect(reopened.conversation).toMatchObject({
          id: "thread",
          status: "open",
          title: "Second title",
        });
        expect(store.messageCount("thread")).toBe(1);
      });
    });

    it("returns closed conversations only when requested", async () => {
      const stub = await getProcessByPid("conversation-closed-filter");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "done" });
        expect(store.closeConversation("done")).toBe(true);

        expect(store.listConversations().map((conversation: any) => conversation.id)).toEqual(["default"]);
        const allConversationIds = store
          .listConversations({ includeClosed: true })
          .map((conversation: any) => conversation.id)
          .sort();
        expect(allConversationIds).toEqual(["default", "done"]);
        expect(store.closeConversation("missing")).toBe(false);
      });
    });

    it("resets a conversation by clearing messages and incrementing generation", async () => {
      const stub = await getProcessByPid("conversation-reset");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread", title: "Work" });
        store.appendMessage("user", "old thread message", { conversationId: "thread" });
        store.closeConversation("thread");

        const reset = store.resetConversation("thread");
        expect(reset).toMatchObject({
          id: "thread",
          generation: 2,
          status: "open",
          title: "Work",
        });
        expect(store.messageCount("thread")).toBe(0);
        expect(store.getConversation("thread").generation).toBe(2);
      });
    });

    it("resets all conversations by clearing messages and incrementing generations", async () => {
      const stub = await getProcessByPid("conversation-reset-all");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "default message");
        store.openConversation({ conversationId: "side", title: "Side" });
        store.appendMessage("user", "side message", { conversationId: "side" });
        store.closeConversation("side");

        expect(store.totalMessageCount()).toBe(2);
        const conversations = store.resetAllConversations();
        const byId = new Map(conversations.map((conversation: any) => [conversation.id, conversation]));

        expect(store.totalMessageCount()).toBe(0);
        expect(byId.get("default")).toMatchObject({ generation: 2, status: "open" });
        expect(byId.get("side")).toMatchObject({ generation: 2, status: "open", title: "Side" });
      });
    });

    it("compacts a conversation prefix and records a segment", async () => {
      const stub = await getProcessByPid("conversation-compact-store");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread" });
        const firstId = store.appendMessage("user", "old one", { conversationId: "thread" });
        const secondId = store.appendMessage("assistant", "old two", { conversationId: "thread" });
        const thirdId = store.appendMessage("user", "keep me", { conversationId: "thread" });

        const prefix = store.getConversationPrefixMessages({
          conversationId: "thread",
          keepLast: 1,
        });
        expect(prefix.map((message: any) => message.id)).toEqual([firstId, secondId]);

        const summaryId = store.compactConversationPrefix({
          conversationId: "thread",
          generation: 1,
          fromMessageId: firstId,
          toMessageId: secondId,
          summary: "Conversation compacted.\n\nSummary:\nOld work.",
        });
        const segment = store.recordConversationSegment({
          id: "segment-1",
          conversationId: "thread",
          generation: 1,
          kind: "compaction",
          fromMessageId: firstId,
          toMessageId: secondId,
          archivePath: "/var/sessions/root/pid/conversations/thread/segment-1.jsonl.gz",
          summaryMessageId: summaryId,
        });

        expect(segment.summaryMessageId).toBe(firstId);
        expect(store.listConversationSegments("thread")).toEqual([
          expect.objectContaining({
            id: "segment-1",
            conversationId: "thread",
            kind: "compaction",
            fromMessageId: firstId,
            toMessageId: secondId,
            summaryMessageId: firstId,
          }),
        ]);
        const messages = store.getMessages({ conversationId: "thread" });
        expect(messages.map((message: any) => [message.id, message.role, message.content])).toEqual([
          [firstId, "system", "Conversation compacted.\n\nSummary:\nOld work."],
          [thirdId, "user", "keep me"],
        ]);
      });
    });
  });

  // ---------- Message CRUD ----------

  describe("messages", () => {
    it("appendMessage stores and retrieves a user message", async () => {
      const stub = await getProcessByPid("msg-crud-1");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
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

    it("appendMessage stores assistant message with tool calls", async () => {
      const stub = await getProcessByPid("msg-crud-2");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageStats()).toEqual({ count: 0, lastMessageId: null });

        const firstId = store.appendMessage("user", "one");
        const secondId = store.appendMessage("assistant", "two");
        expect(store.messageStats()).toEqual({ count: 2, lastMessageId: secondId });
        expect(firstId).toBeLessThan(secondId);
      });
    });

    it("getMessages supports tail and cursor pagination", async () => {
      const stub = await getProcessByPid("msg-tail-pagination");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }

        const tail = store.getMessages({ tail: true, limit: 3 });
        expect(tail.map((message: any) => message.content)).toEqual(["msg-7", "msg-8", "msg-9"]);

        const older = store.getMessages({ beforeMessageId: tail[0].id, limit: 3 });
        expect(older.map((message: any) => message.content)).toEqual(["msg-4", "msg-5", "msg-6"]);
        expect(store.hasMessageBefore(older[0].conversationId, older[0].id)).toBe(true);
        expect(store.hasMessageAfter(older[2].conversationId, older[2].id)).toBe(true);

        const newer = store.getMessages({ afterMessageId: older[2].id, limit: 2 });
        expect(newer.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
      });
    });

    it("clearMessages removes all and returns count", async () => {
      const stub = await getProcessByPid("msg-clear");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "a");
        store.appendMessage("assistant", "b");
        const cleared = store.clearMessages();
        expect(cleared).toBe(2);
        expect(store.messageCount()).toBe(0);
      });
    });

    it("allMessagesForArchive returns all messages in order", async () => {
      const stub = await getProcessByPid("msg-archive");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "first");
        store.appendMessage("assistant", "second");
        store.appendMessage("user", "third");
        const all = store.allMessagesForArchive();
        expect(all).toHaveLength(3);
        expect(all[0].content).toBe("first");
        expect(all[2].content).toBe("third");
      });
    });

    it("keeps messages scoped to a conversation", async () => {
      const stub = await getProcessByPid("msg-conversation-scope");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "default message");
        store.appendMessage("user", "side message", { conversationId: "side" });

        expect(store.messageCount()).toBe(1);
        expect(store.messageCount("side")).toBe(1);
        expect(store.getMessages()[0].content).toBe("default message");
        expect(store.getMessages({ conversationId: "side" })[0].content).toBe("side message");
      });
    });
  });

  // ---------- toolResult role ----------

  describe("appendToolResult", () => {
    it("stores toolName and isError in tool_calls column", async () => {
      const stub = await getProcessByPid("tool-result-1");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call_1", "fs.read", "file contents here", false);
        const msgs = store.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("toolResult");
        expect(msgs[0].content).toBe("file contents here");
        expect(msgs[0].toolCallId).toBe("call_1");
        const meta = JSON.parse(msgs[0].toolCalls!);
        expect(meta.toolName).toBe("Read");
        expect(meta.isError).toBe(false);
      });
    });

    it("maps syscall name to LLM tool name", async () => {
      const stub = await getProcessByPid("tool-result-2");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call_2", "shell.exec", "output", false);
        const meta = JSON.parse(store.getMessages()[0].toolCalls!);
        expect(meta.toolName).toBe("Shell");
      });
    });

    it("stores isError=true for error results", async () => {
      const stub = await getProcessByPid("tool-result-3");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call_3", "fs.write", "EPERM: permission denied", true);
        const meta = JSON.parse(store.getMessages()[0].toolCalls!);
        expect(meta.isError).toBe(true);
      });
    });
  });

  // ---------- toMessages ----------

  describe("toMessages", () => {
    it("converts user messages to pi-ai format", async () => {
      const stub = await getProcessByPid("to-msg-user");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
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
        expect((msgs[0].content as any)[0]).toEqual({ type: "text", text: "See attachment" });
        expect((msgs[0].content as any)[1].type).toBe("text");
      });
    });

    it("converts mind messages to model-visible GSV Mind events", async () => {
      const stub = await getProcessByPid("to-msg-mind");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("mind", "Delegate this social request to a bounded task.");
        const msgs = store.toMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("user");
        expect(msgs[0].content).toBe("[GSV Mind]:\nDelegate this social request to a bounded task.");
      });
    });

    it("converts assistant messages with text", async () => {
      const stub = await getProcessByPid("to-msg-assistant-text");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("assistant", "Hello there!");
        const msgs = store.toMessages();
        expect(msgs).toHaveLength(1);
        const msg = msgs[0] as any;
        expect(msg.role).toBe("assistant");
        expect(msg.content[0]).toEqual({ type: "text", text: "Hello there!" });
      });
    });

    it("converts assistant messages with tool calls", async () => {
      const stub = await getProcessByPid("to-msg-assistant-tools");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const toolCalls = [
          { type: "toolCall", id: "call_1", name: "Read", arguments: { path: "/etc/hostname" } },
        ];
        store.appendMessage("assistant", "Reading file...", {
          toolCalls: JSON.stringify(toolCalls),
        });
        const msgs = store.toMessages();
        const msg = msgs[0] as any;
        expect(msg.content).toHaveLength(2);
        expect(msg.content[0].type).toBe("text");
        expect(msg.content[1].type).toBe("toolCall");
        expect(msg.content[1].name).toBe("Read");
      });
    });

    it("converts assistant messages with thinking and tool calls", async () => {
      const stub = await getProcessByPid("to-msg-assistant-thinking");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call_1", "fs.read", "gsv", false);
        const msgs = store.toMessages();
        expect(msgs).toHaveLength(1);
        const msg = msgs[0] as any;
        expect(msg.role).toBe("toolResult");
        expect(msg.toolCallId).toBe("call_1");
        expect(msg.toolName).toBe("Read");
        expect(msg.isError).toBe(false);
        expect(msg.content[0]).toEqual({ type: "text", text: "gsv" });
      });
    });

    it("converts a full conversation round-trip", async () => {
      const stub = await getProcessByPid("to-msg-full");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.enqueue("run-1", "first message");
        store.enqueue("run-2", "second message");
        store.enqueue("run-3", "third message");

        expect(store.queueSize()).toBe(3);

        const first = store.dequeue();
        expect(first).not.toBeNull();
        expect(first!.message).toBe("first message");
        expect(first!.runId).toBe("run-1");
        expect(first!.role).toBe("user");

        const second = store.dequeue();
        expect(second!.message).toBe("second message");

        expect(store.queueSize()).toBe(1);
      });
    });

    it("dequeue returns null on empty queue", async () => {
      const stub = await getProcessByPid("queue-empty");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.dequeue()).toBeNull();
      });
    });

    it("drainQueue returns all and clears", async () => {
      const stub = await getProcessByPid("queue-drain");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.drainQueue()).toEqual([]);
      });
    });

    it("enqueue stores optional media and overrides", async () => {
      const stub = await getProcessByPid("queue-meta");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.enqueue("r1", "hello", '["img.png"]', '{"model":"gpt-4"}');
        const item = store.dequeue();
        expect(item!.media).toBe('["img.png"]');
        expect(item!.overrides).toBe('{"model":"gpt-4"}');
      });
    });

    it("preserves queued mind message role", async () => {
      const stub = await getProcessByPid("queue-mind-role");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.enqueue("r1", "mind event", undefined, undefined, "social", "mind");
        const item = store.dequeue();
        expect(item!.role).toBe("mind");
        expect(item!.message).toBe("mind event");
      });
    });

    it("preserves queued system event role", async () => {
      const stub = await getProcessByPid("queue-system-role");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.enqueue("r1", "process event", undefined, undefined, "social", "system");
        const item = store.dequeue();
        expect(item!.role).toBe("system");
        expect(item!.message).toBe("process event");
      });
    });

    it("drains only the requested conversation", async () => {
      const stub = await getProcessByPid("queue-conversation-scope");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.enqueue("run-default", "default queued");
        store.enqueue("run-side", "side queued", undefined, undefined, "side");

        const side = store.drainQueue("side");
        expect(side).toHaveLength(1);
        expect(side[0].conversationId).toBe("side");
        expect(side[0].message).toBe("side queued");

        expect(store.queueSize()).toBe(1);
        const next = store.dequeue();
        expect(next!.conversationId).toBe("default");
        expect(next!.message).toBe("default queued");
      });
    });
  });

  // ---------- Tool calls ----------

  describe("tool calls", () => {
    it("register and resolve", async () => {
      const stub = await getProcessByPid("tc-resolve");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.register("call_1", "run_1", "fs.read", { path: "/etc/hostname" });
        expect(store.getPending("call_1")).not.toBeNull();
        expect(store.isRunResolved("run_1")).toBe(false);

        store.resolve("call_1", { content: "gsv" });
        expect(store.getPending("call_1")).toBeNull();
        expect(store.isRunResolved("run_1")).toBe(true);

        const results = store.getResults("run_1");
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("completed");
        expect(results[0].result).toEqual({ content: "gsv" });
      });
    });

    it("register and fail", async () => {
      const stub = await getProcessByPid("tc-fail");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.register("call_2", "run_2", "fs.write", { path: "/root/x" });
        store.fail("call_2", "EPERM");
        expect(store.isRunResolved("run_2")).toBe(true);
        const results = store.getResults("run_2");
        expect(results[0].status).toBe("error");
        expect(results[0].error).toBe("EPERM");
      });
    });

    it("isRunResolved waits for all calls", async () => {
      const stub = await getProcessByPid("tc-multi");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.register("c1", "run_3", "fs.read", {});
        store.register("c2", "run_3", "shell.exec", {});
        expect(store.isRunResolved("run_3")).toBe(false);

        store.resolve("c1", "ok");
        expect(store.isRunResolved("run_3")).toBe(false);

        store.resolve("c2", "ok");
        expect(store.isRunResolved("run_3")).toBe(true);
      });
    });

    it("clearRun removes all entries for a run", async () => {
      const stub = await getProcessByPid("tc-clear");
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.register("c1", "run_4", "fs.read", {});
        store.register("c2", "run_4", "fs.write", {});
        store.resolve("c1", "ok");
        store.resolve("c2", "ok");
        store.clearRun("run_4");
        expect(store.getResults("run_4")).toHaveLength(0);
      });
    });
  });

  // ---------- KV ----------

  describe("key-value", () => {
    it("set, get, delete", async () => {
      const stub = await getProcessByPid("kv-1");
      await runInDurableObject(stub, (instance: Process) => {
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
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.setValue("key", "v1");
        store.setValue("key", "v2");
        expect(store.getValue("key")).toBe("v2");
      });
    });
  });
});
