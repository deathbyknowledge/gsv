import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import type { Process } from "./do";
import { Kernel } from "../kernel/do";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { RequestFrame, ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import { getProcessByPid, getKernelPtr } from "../shared/utils";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
  workspaceId: null,
};
const DEFAULT_PROFILE = "task" as const;

function makeReq(call: string, args: unknown): RequestFrame {
  return { type: "req", id: crypto.randomUUID(), call, args } as RequestFrame;
}

/**
 * Register a process in the Kernel's ProcessRegistry and seed capabilities.
 * Must be called before the Process DO can communicate with the kernel.
 */
async function registerInKernel(pid: string, identity: ProcessIdentity) {
  const kernel = await getKernelPtr();
  await runInDurableObject(kernel, (instance: Kernel) => {
    const k = instance as any;
    k.caps.seed();
    k.procs.spawn(pid, identity, { profile: DEFAULT_PROFILE });
  });
}

/**
 * Poll until the Process DO's currentRun is null (run finished).
 * The agents SDK alarm handler does cross-DO async work that isn't
 * fully awaited by runDurableObjectAlarm, so we poll.
 */
async function waitForRunComplete(
  stub: DurableObjectStub<Process>,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await runInDurableObject(stub, (instance: Process) => {
      return (instance as any).store.getValue("currentRun") === null;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for run to complete");
}

/**
 * Initialize a Process DO with identity (via proc.setidentity RPC).
 * Optionally registers it in the kernel first.
 */
async function initProcess(pid: string, identity: ProcessIdentity, opts?: { register?: boolean }) {
  if (opts?.register !== false) {
    await registerInKernel(pid, identity);
  }
  const stub = await getProcessByPid(pid);
  const res = await stub.recvFrame(makeReq("proc.setidentity", { pid, identity, profile: DEFAULT_PROFILE }));
  expect((res as ResponseFrame).ok).toBe(true);
  return stub;
}

// ---------------------------------------------------------------------------
// Tier 1: Mechanical tests (no LLM)
// ---------------------------------------------------------------------------

describe("Process DO — mechanical", () => {
  describe("kernel process RPC exposure", () => {
    it("allows non-root processes to call internal ai.config", async () => {
      const pid = "mech-kernel-ai-config";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
        workspaceId: null,
      };

      await registerInKernel(pid, identity);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("ai.config", {})),
      );

      expect(response).not.toBeNull();
      expect((response as ResponseFrame).ok).toBe(true);
    });

    it("includes CodeMode in ai.tools for default user capabilities", async () => {
      const pid = "mech-kernel-ai-tools-codemode";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
        workspaceId: null,
      };

      await registerInKernel(pid, identity);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("ai.tools", {})),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as {
        tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
      };
      const codeMode = data.tools.find((tool) => tool.name === "CodeMode");
      expect(codeMode).toBeDefined();
      expect(codeMode?.inputSchema.required).toEqual(["code"]);
    });
  });

  describe("proc.setidentity", () => {
    it("stores pid and identity", async () => {
      const pid = "mech-setid-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.pid).toBe(pid);
        expect(instance.identity.uid).toBe(0);
        expect(instance.identity.username).toBe("root");
        expect(instance.identity.home).toBe("/root");
        expect(instance.initialized).toBe(true);
      });
    });

    it("overwrites on re-call", async () => {
      const pid = "mech-setid-2";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const newIdentity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
        workspaceId: null,
      };
      await stub.recvFrame(makeReq("proc.setidentity", { pid, identity: newIdentity, profile: "mcp" }));

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.identity.uid).toBe(1000);
        expect(instance.identity.username).toBe("alice");
        expect((instance as any).profile).toBe("mcp");
      });
    });
  });

  describe("proc.send", () => {
    it("appends user message, starts run, loop completes", async () => {
      const pid = "mech-send-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.send", { message: "Hello agent" }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as { ok: true; status: string; runId: string };
      expect(data.status).toBe("started");
      expect(data.runId).toBeTruthy();
      expect(data).not.toHaveProperty("queued");

      // Fire the alarm and wait for the agent loop to complete.
      // The test worker has no AI binding configured, so the LLM call
      // errors out gracefully, but the full lifecycle (tick →
      // continueAgentLoop → finishRun) should still run.
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageCount()).toBe(2);
        expect(store.getMessages()[0].role).toBe("user");
        expect(store.getMessages()[0].content).toBe("Hello agent");
        expect(store.getMessages()[1].role).toBe("system");
        expect(store.getMessages()[1].content).toContain("Generation failed:");
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("queues message, finishRun dequeues and processes it", async () => {
      const pid = "mech-send-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      // Start first run
      const res1 = (await stub.recvFrame(
        makeReq("proc.send", { message: "First message" }),
      )) as ResponseOkFrame;
      expect(res1.ok).toBe(true);

      // Send second message while run is active — should be queued
      const res2 = (await stub.recvFrame(
        makeReq("proc.send", { message: "Second message" }),
      )) as ResponseOkFrame;
      expect((res2.data as any).queued).toBe(true);

      // Fire alarm for run 1 — fails (no AI binding in tests), finishRun dequeues
      // "Second message" and starts run 2
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      // Fire alarm for run 2 — fails again, finishRun finds empty queue, done
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const msgs = store.getMessages();
        const userMsgs = msgs.filter((m: any) => m.role === "user");
        expect(userMsgs).toHaveLength(2);
        expect(userMsgs[0].content).toBe("First message");
        expect(userMsgs[1].content).toBe("Second message");
        expect(store.queueSize()).toBe(0);
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("stores process-scoped media and hydrates image context blocks", async () => {
      const pid = "mech-send-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Describe this image.",
          media: [
            {
              type: "image",
              mimeType: "image/png",
              data: "AQID",
              filename: "proof.png",
            },
          ],
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);

      await runInDurableObject(stub, async (instance: Process) => {
        const store = (instance as any).store;
        const record = store.getMessages()[0];
        expect(record.role).toBe("user");
        expect(record.media).toBeTruthy();

        const media = JSON.parse(record.media!);
        expect(media).toHaveLength(1);
        expect(media[0].key).toContain(`/0/${pid}/`);

        const stored = await env.STORAGE.get(media[0].key);
        expect(stored).not.toBeNull();

        const messages = await (instance as any).buildContextMessages();
        const user = messages[0] as any;
        expect(Array.isArray(user.content)).toBe(true);
        expect(user.content[0]).toEqual({ type: "text", text: "Describe this image." });
        expect(user.content[1].type).toBe("image");
        expect(user.content[1].mimeType).toBe("image/png");
        expect(user.content[1].data).toBe("AQID");
      });
    });
  });

  describe("proc.abort", () => {
    it("returns aborted=false when no run is active", async () => {
      const pid = "mech-abort-idle";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        aborted: false,
      });
    });

    it("synthesizes interrupted tool results and continues the next queued run", async () => {
      const pid = "mech-abort-active";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("assistant", "", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/root/test.txt" } },
          ]),
        });
        process.store.register("call-1", "run-1", "fs.read", { path: "/root/test.txt" });
        process.store.enqueue("run-2", "follow-up after abort");
        process.currentRun = { runId: "run-1", queued: false };
      });

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        aborted: true,
        runId: "run-1",
        interruptedToolCalls: 1,
        continuedQueuedRunId: "run-2",
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        const lastTwo = messages.slice(-2);
        expect(lastTwo[0].role).toBe("toolResult");
        expect(lastTwo[0].content).toContain("User interrupted tool execution");
        expect(lastTwo[1].role).toBe("user");
        expect(lastTwo[1].content).toBe("follow-up after abort");
        expect(store.queueSize()).toBe(0);
        expect(process.currentRun).toMatchObject({ runId: "run-2" });
      });
    });

    it("returns without waiting for signal fanout delivery", async () => {
      const pid = "mech-abort-nonblocking-signal";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-1", queued: false };
      });

      let releaseSignalDispatch!: () => void;
      const signalDispatchBlocked = new Promise<void>((resolve) => {
        releaseSignalDispatch = resolve;
      });
      const signalSpy = vi
        .spyOn(Kernel.prototype as never, "handleProcessSignal" as never)
        .mockImplementation(async () => {
          await signalDispatchBlocked;
        });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          stub.recvFrame(makeReq("proc.abort", {})),
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error("proc.abort timed out waiting for signal delivery")), 150);
          }),
        ]) as ResponseOkFrame;

        expect(res.ok).toBe(true);
        expect(res.data).toMatchObject({
          ok: true,
          pid,
          aborted: true,
          runId: "run-1",
        });
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        releaseSignalDispatch();
        await signalDispatchBlocked;
        signalSpy.mockRestore();
      }
    });
  });

  describe("proc.hil", () => {
    it("pauses a run on ask policy and exposes the pending confirmation in history", async () => {
      const pid = "mech-hil-pause";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-1",
          queued: false,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.processToolCalls("run-hil-1", [
          { type: "toolCall", id: "call-hil-1", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
      });

      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(history.ok).toBe(true);
      const data = history.data as any;
      expect(data.pendingHil).toMatchObject({
        runId: "run-hil-1",
        callId: "call-hil-1",
        toolName: "Read",
        syscall: "fs.read",
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getPendingHilForRun("run-hil-1")).not.toBeNull();
        expect(process.store.getPending("call-hil-1")).toBeNull();
      });
    });

    it("denies a pending confirmation with a synthetic tool result", async () => {
      const pid = "mech-hil-deny";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-2",
          queued: false,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.processToolCalls("run-hil-2", [
          { type: "toolCall", id: "call-hil-2", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
        return process.store.getPendingHilForRun("run-hil-2").requestId;
      });

      const res = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "deny" }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        requestId,
        decision: "deny",
        resumed: true,
        pendingHil: null,
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages();
        const last = messages[messages.length - 1];
        expect(process.store.getPendingHil()).toBeNull();
        expect(last.role).toBe("toolResult");
        expect(last.content).toContain("Tool execution denied by user");
      });
    });
  });

  describe("proc.history", () => {
    it("returns stored messages", async () => {
      const pid = "mech-history-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "What is 2+2?");
        store.appendMessage("assistant", "4");
        store.appendMessage("user", "Thanks!");
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.pid).toBe(pid);
      expect(data.messageCount).toBe(3);
      expect(data.messages).toHaveLength(3);
      expect(data.messages[0].role).toBe("user");
      expect(data.messages[0].content).toBe("What is 2+2?");
      expect(data.messages[1].role).toBe("assistant");
      expect(data.messages[1].content).toBe("4");
    });

    it("respects limit and offset", async () => {
      const pid = "mech-history-2";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", { limit: 3, offset: 2 }),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.messages).toHaveLength(3);
      expect(data.messageCount).toBe(10);
      expect(data.truncated).toBe(true);
    });

    it("includes full toolResult payload (metadata + output)", async () => {
      const pid = "mech-history-toolresult";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call-1", "fs.read", "file contents here", false);
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].role).toBe("toolResult");
      expect(data.messages[0].content).toEqual({
        toolName: "Read",
        isError: false,
        toolCallId: "call-1",
        output: "file contents here",
      });
    });

    it("includes assistant thinking blocks when present", async () => {
      const pid = "mech-history-thinking";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("assistant", "Let me inspect that.", {
          toolCalls: JSON.stringify({
            thinking: [
              { type: "thinking", thinking: "Need to inspect config before answering." },
            ],
            toolCalls: [
              { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
            ],
          }),
        });
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].role).toBe("assistant");
      expect(data.messages[0].content).toEqual({
        text: "Let me inspect that.",
        thinking: [
          { type: "thinking", thinking: "Need to inspect config before answering." },
        ],
        toolCalls: [
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
        ],
      });
    });
  });

  describe("CodeMode tool calls", () => {
    it("runs codemode.run as a process command", async () => {
      const pid = "mech-codemode-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("codemode.run", {
          code: "return { argv, args };",
          argv: ["alpha"],
          args: { mode: "manual" },
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toEqual({
        status: "completed",
        result: {
          argv: ["alpha"],
          args: { mode: "manual" },
        },
      });
    });

    it("dispatches CodeMode through the process-local executor path", async () => {
      const pid = "mech-codemode-basic";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;

        process.currentRun = {
          runId: "run-codemode-basic",
          queued: false,
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.sendSignal = async () => {};
        process.executeCodeModeTool = async (
          runId: string,
          toolCallId: string,
          args: { code: string },
        ) => {
          expect(runId).toBe("run-codemode-basic");
          expect(toolCallId).toBe("call-codemode-1");
          expect(args.code).toContain("fs.read");
          process.store.register(toolCallId, runId, "codemode.exec", args);
          process.store.resolve(toolCallId, {
            status: "completed",
            result: "from codemode",
          });
        };

        await process.processToolCalls("run-codemode-basic", [
          {
            type: "toolCall",
            id: "call-codemode-1",
            name: "CodeMode",
            arguments: {
              code: `
                const file = await fs.read({ target: "gsv", path: "/tmp/example.txt" });
                return file.content;
              `,
            },
          },
        ]);

        expect(process.store.getResults("run-codemode-basic")).toEqual([
          expect.objectContaining({
            id: "call-codemode-1",
            call: "codemode.exec",
            status: "completed",
            result: {
              status: "completed",
              result: "from codemode",
            },
          }),
        ]);
      });
    });
  });

  describe("proc.reset", () => {
    it("checkpoints only on reset boundaries, not normal turn completion", async () => {
      const pid = "mech-checkpoint-reset-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const checkpointReasons: string[] = [];

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        store.appendMessage("user", "hello");

        process.checkpointWorkspace = async (reason: string) => {
          checkpointReasons.push(reason);
        };

        await process.finishRun("turn.complete");
        expect(store.messageCount()).toBe(1);

        await process.handleProcReset();
        expect(store.messageCount()).toBe(0);
      });

      expect(checkpointReasons).toEqual(["proc.reset"]);
    });

    it("archives messages and clears conversation", async () => {
      const pid = "mech-reset-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "hello");
        store.appendMessage("assistant", "hi");
      });

      const res = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.archivedMessages).toBe(2);
      expect(data.archivedTo).toContain("/var/sessions/root/");

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageCount()).toBe(0);
      });

      const archiveKey = data.archivedTo!.replace(/^\//, "");
      const obj = await env.STORAGE.get(archiveKey);
      expect(obj).not.toBeNull();
    });

    it("returns zero when no messages to archive", async () => {
      const pid = "mech-reset-empty";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.archivedMessages).toBe(0);
      expect(data.archivedTo).toBeUndefined();
    });

    it("clears active run state and queued messages", async () => {
      const pid = "mech-reset-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-reset-runtime";

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.setValue("currentRun", JSON.stringify({ runId, queued: false }));
        store.register("call-reset-1", runId, "fs.read", { path: "/tmp/test.txt" });
        store.enqueue(runId, "queued after reset");
        store.appendMessage("user", "hello before reset");
      });

      const resetRes = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;
      expect(resetRes.ok).toBe(true);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.getValue("currentRun")).toBeNull();
        expect(store.queueSize()).toBe(0);
        expect(store.getResults(runId)).toHaveLength(0);
      });

      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", { message: "first after reset" }),
      )) as ResponseOkFrame;
      const sendData = sendRes.data as { queued?: boolean };
      expect(sendData.queued).toBeUndefined();
    });
  });

  describe("proc.kill", () => {
    it("clears conversation and runtime state so next send is not queued", async () => {
      const pid = "mech-kill-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-kill-runtime";

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.setValue("currentRun", JSON.stringify({ runId, queued: false }));
        store.register("call-kill-1", runId, "fs.read", { path: "/tmp/test.txt" });
        store.enqueue(runId, "queued before kill");
        store.appendMessage("user", "hello before kill");
      });

      const killRes = (await stub.recvFrame(
        makeReq("proc.kill", { archive: false }),
      )) as ResponseOkFrame;
      expect(killRes.ok).toBe(true);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.getValue("currentRun")).toBeNull();
        expect(store.queueSize()).toBe(0);
        expect(store.getResults(runId)).toHaveLength(0);
        expect(store.messageCount()).toBe(0);
      });

      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", { message: "first after kill" }),
      )) as ResponseOkFrame;
      const sendData = sendRes.data as { queued?: boolean };
      expect(sendData.queued).toBeUndefined();
    });
  });

  describe("unknown command", () => {
    it("returns error for unknown call", async () => {
      const pid = "mech-unknown";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.bogus", {}),
      )) as ResponseFrame;

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Unknown process command");
      }
    });
  });

  describe("identity.changed signal", () => {
    it("updates stored identity on signal", async () => {
      const pid = "mech-sig-identity";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const newIdentity: ProcessIdentity = {
        uid: 0,
        gid: 0,
        gids: [0, 42],
        username: "root",
        home: "/root",
        cwd: "/root",
        workspaceId: null,
      };

      await stub.recvFrame({
        type: "sig",
        signal: "identity.changed",
        payload: { identity: newIdentity },
      } as any);

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.identity.gids).toEqual([0, 42]);
      });
    });
  });

  describe("response handling", () => {
    it("ignores response for unknown tool call", async () => {
      const pid = "mech-res-unknown";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await stub.recvFrame({
        type: "res",
        id: "nonexistent-call-id",
        ok: true,
        data: { content: "hello" },
      } as any);
    });

    it("does not continue the run until all tool calls in a batch are dispatched", async () => {
      const pid = "mech-res-multi-tool-batch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const continuedRunIds: string[] = [];

        process.currentRun = {
          runId: "run-multi-tool-batch",
          queued: false,
          approvalPolicy: { default: "auto", rules: [] },
        };

        process.sendSignal = async () => {};
        process.continueAgentLoop = async (runId: string) => {
          continuedRunIds.push(runId);
        };
        process.dispatchSyscall = async (
          dispatchRunId: string,
          id: string,
          call: string,
          args: unknown,
        ) => {
          process.store.register(id, dispatchRunId, call, args);

          if (id === "call-1") {
            await process.handleRes({
              type: "res",
              id,
              ok: true,
              data: { path: "/tmp/one.txt", content: "first" },
            });
          }
        };

        await process.processToolCalls("run-multi-tool-batch", [
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/tmp/one.txt" } },
          { type: "toolCall", id: "call-2", name: "Read", arguments: { path: "/tmp/two.txt" } },
        ]);

        expect(continuedRunIds).toEqual([]);
        expect(process.store.getResults("run-multi-tool-batch")).toEqual([
          expect.objectContaining({
            id: "call-1",
            status: "completed",
          }),
          expect.objectContaining({
            id: "call-2",
            status: "pending",
          }),
        ]);

        await process.handleRes({
          type: "res",
          id: "call-2",
          ok: true,
          data: { path: "/tmp/two.txt", content: "second" },
        });

        expect(continuedRunIds).toEqual(["run-multi-tool-batch"]);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Real LLM tests (gated on API key)
// ---------------------------------------------------------------------------

declare const __GSV_TEST_OPENAI_KEY__: string;
const OPENAI_KEY = __GSV_TEST_OPENAI_KEY__ || undefined;

const describeIf = (condition: unknown) =>
  condition ? describe : describe.skip;

describeIf(OPENAI_KEY)("Process DO — agent loop (real LLM)", () => {
  beforeAll(async () => {
    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.caps.seed();
      k.config.set("config/ai/api_key", OPENAI_KEY);
      k.config.set("config/ai/provider", "openai");
      k.config.set("config/ai/model", "gpt-4o-mini");
      k.config.set("config/ai/max_tokens", "1024");
    });
  });

  afterEach(async () => {
    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.delete("config/ai/profile/task/tools/approval");
      k.config.delete("users/0/ai/api_key");
    });
  });

  it("simple text response: send → alarm → text + complete", async () => {
    const pid = "llm-simple-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", { message: "Respond with exactly the word 'pong'. Nothing else." }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub, 25_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();
      expect(store.messageCount()).toBeGreaterThanOrEqual(2);
      const msgs = store.getMessages();
      expect(msgs[0].role).toBe("user");
      const assistantMsg = msgs.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content.toLowerCase()).toContain("pong");
    });
  }, 30_000);

  it("tool call loop: read file → text response", async () => {
    const pid = "llm-tool-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/test-file.txt", "The secret word is: banana", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read the file ~/test-file.txt and tell me the secret word. Only respond with the secret word, nothing else.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    // Tick through the agent loop — LLM calls Read, gets result, responds
    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();

      const msgs = store.getMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(4);

      const toolResultMsg = msgs.find((m: any) => m.role === "toolResult");
      expect(toolResultMsg).toBeDefined();

      const lastAssistant = msgs.filter((m: any) => m.role === "assistant").pop();
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant!.content.toLowerCase()).toContain("banana");
    });
  }, 60_000);

  it("message queue injection at tool-result boundary", async () => {
    const pid = "llm-queue-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/queue-test.txt", "file-content-alpha", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const res1 = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/queue-test.txt and tell me what it says.",
      }),
    )) as ResponseOkFrame;
    expect(res1.ok).toBe(true);

    const res2 = (await stub.recvFrame(
      makeReq("proc.send", { message: "Also, what is 1 + 1?" }),
    )) as ResponseOkFrame;
    expect((res2.data as any).queued).toBe(true);

    let maxTicks = 10;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null
          && (instance as any).store.queueSize() === 0;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.queueSize()).toBe(0);
      const msgs = store.getMessages();
      const userMsgs = msgs.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      const queuedMsg = userMsgs.find((m: any) =>
        m.content.includes("1 + 1"),
      );
      expect(queuedMsg).toBeDefined();
    });
  }, 60_000);

  it("tool confirmation approve path: pauses for approval, then reads and completes", async () => {
    const pid = "llm-hil-approve-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/hil-approve.txt", "banana", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.set("config/ai/profile/task/tools/approval", JSON.stringify({
        default: "auto",
        rules: [{ match: "fs.read", action: "ask" }],
      }));
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/hil-approve.txt and reply with exactly the word banana.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);

    let pendingHil: any = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      pendingHil = (history.data as any).pendingHil;
      if (pendingHil) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(pendingHil).toMatchObject({
      syscall: "fs.read",
      args: { target: "gsv" },
    });
    expect(["~/hil-approve.txt", "/root/hil-approve.txt"]).toContain(pendingHil.args.path);

    const hilRes = (await stub.recvFrame(
      makeReq("proc.hil", { requestId: pendingHil.requestId, decision: "approve" }),
    )) as ResponseOkFrame;
    expect(hilRes.ok).toBe(true);
    expect(hilRes.data).toMatchObject({
      ok: true,
      pid,
      requestId: pendingHil.requestId,
      decision: "approve",
      resumed: true,
      pendingHil: null,
    });

    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      const toolResultMsg = store.getMessages().find((m: any) => m.role === "toolResult");
      const lastAssistant = store.getMessages().filter((m: any) => m.role === "assistant").pop();
      expect(store.getPendingHil()).toBeNull();
      expect(toolResultMsg).toBeDefined();
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant!.content.toLowerCase()).toContain("banana");
    });
  }, 60_000);

  it("tool confirmation deny path: pauses for approval, then continues with denial", async () => {
    const pid = "llm-hil-deny-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/hil-deny.txt", "secret-value", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.set("config/ai/profile/task/tools/approval", JSON.stringify({
        default: "auto",
        rules: [{ match: "fs.read", action: "ask" }],
      }));
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/hil-deny.txt. If the read tool is denied, reply with exactly the single word denied.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);

    let pendingHil: any = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      pendingHil = (history.data as any).pendingHil;
      if (pendingHil) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(pendingHil).toMatchObject({
      syscall: "fs.read",
    });

    const hilRes = (await stub.recvFrame(
      makeReq("proc.hil", { requestId: pendingHil.requestId, decision: "deny" }),
    )) as ResponseOkFrame;
    expect(hilRes.ok).toBe(true);
    expect(hilRes.data).toMatchObject({
      ok: true,
      pid,
      requestId: pendingHil.requestId,
      decision: "deny",
      resumed: true,
      pendingHil: null,
    });

    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      const toolResults = store.getMessages().filter((m: any) => m.role === "toolResult");
      const lastAssistant = store.getMessages().filter((m: any) => m.role === "assistant").pop();
      expect(store.getPendingHil()).toBeNull();
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(toolResults[toolResults.length - 1].content).toContain("Tool execution denied by user");
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant!.content.toLowerCase()).toContain("denied");
    });
  }, 60_000);

  it("handles invalid API key gracefully", async () => {
    const pid = "llm-error-1";

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.procs.spawn(pid, ROOT_IDENTITY, { profile: DEFAULT_PROFILE });
      k.config.set("users/0/ai/api_key", "sk-invalid-key-for-testing");
    });

    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", { message: "Hello" }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub, 25_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();
    });

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.delete("users/0/ai/api_key");
    });
  }, 30_000);
});
