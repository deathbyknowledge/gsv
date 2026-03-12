import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { getProcessByPid } from "../shared/utils";

describe("ProcessStore", () => {
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
