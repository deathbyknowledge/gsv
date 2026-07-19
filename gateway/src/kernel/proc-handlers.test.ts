import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProcessIdentity,
  ProcIpcSendResult,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { KernelContext } from "./context";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { forwardToProcess, handleProcIpcCall, handleProcIpcSend, handleProcSpawn, handleProcList, resolveRunAsIdentity } from "./proc-handlers";
import { resolveConversationExecutor } from "./agents";
import { resolveCallerOwnerUid } from "./context";
import { createProvisioningR2BucketMock } from "../test-support/mock-r2";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);
const DEFAULT_ARCHIVE_BASE = "/process-conversation-archives/1000/2000/default%3A1000%3A2000";

// A parent process record (owned by the caller) used by parented-spawn tests,
// so the run-as identity is inherited from the parent.
const SPAWN_PARENT = {
  processId: `init:${IDENTITY.uid}`,
  parentPid: null,
  uid: IDENTITY.uid,
  ownerUid: IDENTITY.uid,
  gid: IDENTITY.gid,
  gids: IDENTITY.gids,
  username: IDENTITY.username,
  home: IDENTITY.home,
  cwd: IDENTITY.cwd,
  interactive: true,
};

function spawnConversationsMock() {
  return {
    create: vi.fn(() => ({ conversationId: "conv-1" })),
    setActivePid: vi.fn(() => true),
    clearActivePid: vi.fn(),
    remove: vi.fn(() => true),
  };
}

function makeStorageBucket() {
  return createProvisioningR2BucketMock();
}

describe("proc handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "signal",
      ok: true,
      data: { ok: true },
    } as ResponseFrame));
  });

  it("passes the owning Kernel name to a new conversation executor", async () => {
    const ctx = {
      kernelName: "kernel-human-1",
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      conversations: {
        setActivePid: vi.fn(),
      },
    } as unknown as KernelContext;

    await resolveConversationExecutor(ctx, {
      conversationId: "conversation-1",
      ownerUid: IDENTITY.uid,
      agentUid: IDENTITY.uid,
      title: null,
      isDefault: false,
      activePid: null,
      archiveBase: "/process-conversation-archives/1000/1000/conversation-1",
      latestArchive: null,
      createdAt: 1,
      lastActiveAt: null,
    }, IDENTITY);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      expect.stringMatching(/^proc:/),
      expect.objectContaining({
        call: "proc.setidentity",
        args: expect.objectContaining({ kernelName: "kernel-human-1" }),
      }),
    );
  });

  it("cleans up pending IPC call when delivery returns an error response", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "deliver",
      ok: false,
      error: { code: 500, message: "target rejected delivery" },
    } satisfies ResponseFrame);

    const { ctx, ipcCalls } = makeIpcCallContext();
    const result = await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "target rejected delivery" });
    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    const runId = (sendFrameToProcessMock.mock.calls[0]?.[1] as RequestFrame | undefined)?.args.runId;
    expect(callId).toBeTruthy();
    expect(runId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      sourceRunId: "source-run",
      targetRunId: runId,
    }));
    expect(ctx.scheduleIpcCallTimeout).toHaveBeenCalledWith(
      callId,
      ipcCalls.create.mock.calls[0]?.[0]?.deadlineAt,
    );
  });

  it("keys same-owner cross-agent IPC calls by owner uid", async () => {
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        conversationId: "default",
        runId: (frame as RequestFrame).args.runId,
      } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame));

    const ownerUid = 1000;
    const sourceIdentity = {
      ...IDENTITY,
      uid: 2000,
      gid: 2000,
      gids: [2000],
      username: "sam-agent",
      home: "/home/sam-agent",
      cwd: "/home/sam-agent",
    };
    const { ctx, ipcCalls } = makeIpcCallContext({
      identity: sourceIdentity,
      source: { uid: sourceIdentity.uid, ownerUid },
      target: { uid: 3000, ownerUid },
    });

    const result = await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      status: "started",
      pid: "target-process",
      sourcePid: "source-process",
      conversationId: "default",
    });
    const runId = (sendFrameToProcessMock.mock.calls[0]?.[1] as RequestFrame).args.runId;
    expect(result).toMatchObject({ runId });
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      uid: ownerUid,
      sourcePid: "source-process",
      sourceRunId: "source-run",
      targetPid: "target-process",
      targetRunId: runId,
    }));
  });

  it("rejects an IPC send response for a different run", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        conversationId: "default",
        runId: "unexpected-run",
      } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame);
    const { ctx } = makeIpcCallContext();

    await expect(handleProcIpcSend({
      pid: "target-process",
      message: "fire and forget",
    }, ctx)).resolves.toEqual({
      ok: false,
      error: "proc.ipc.deliver returned an unexpected runId",
    });
  });

  it("schedules IPC timeout before delivering work to the target", async () => {
    const { ctx, ipcCalls } = makeIpcCallContext();
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => {
      const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
      expect(ctx.scheduleIpcCallTimeout).toHaveBeenCalledWith(
        callId,
        ipcCalls.create.mock.calls[0]?.[0]?.deadlineAt,
      );
      return {
        type: "res",
        id: "deliver",
        ok: true,
        data: {
          ok: true,
          status: "started",
          pid: "target-process",
          sourcePid: "source-process",
          conversationId: "default",
          runId: (frame as RequestFrame).args.runId,
        } satisfies ProcIpcSendResult,
      } satisfies ResponseFrame;
    });

    await expect(handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx)).resolves.toMatchObject({ ok: true, status: "started" });
  });

  it("correlates IPC with the dispatching run instead of mutable process state", async () => {
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        conversationId: "default",
        runId: (frame as RequestFrame).args.runId,
      } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame));
    const { ctx, ipcCalls } = makeIpcCallContext({
      source: { uid: IDENTITY.uid, ownerUid: IDENTITY.uid, activeRunId: "successor-run" },
    });
    ctx.processRunId = "dispatching-run";

    await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      sourceRunId: "dispatching-run",
    }));
  });

  it("removes the IPC call when timeout scheduling fails", async () => {
    const { ctx, ipcCalls } = makeIpcCallContext();
    ctx.scheduleIpcCallTimeout = vi.fn(async () => {
      throw new Error("scheduler unavailable");
    });

    await expect(handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx)).resolves.toEqual({ ok: false, error: "scheduler unavailable" });

    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("does not report started after a delivered timeout row was removed", async () => {
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        conversationId: "default",
        runId: (frame as RequestFrame).args.runId,
      } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame));
    const { ctx, ipcCalls } = makeIpcCallContext();
    ipcCalls.get.mockReturnValue(null);
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(61_000);
    try {
      await expect(handleProcIpcCall({
        pid: "target-process",
        message: "bounded work",
      }, ctx)).resolves.toEqual({ ok: false, error: "IPC call timed out" });
      expect(ipcCalls.get).toHaveReturnedWith(null);
    } finally {
      now.mockRestore();
    }
  });

  it("derives client interaction origin for forwarded proc.send", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "send-1",
      ok: true,
      data: { ok: true, status: "started", runId: "run-1" },
    } satisfies ResponseFrame);

    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.send"],
      },
      connection: {
        id: "conn-1",
        state: {
          clientId: "browser-extension",
          clientPlatform: "browser",
        },
      },
      procs: {
        get: vi.fn(() => ({ uid: IDENTITY.uid, ownerUid: IDENTITY.uid })),
      },
      conversations: { getByActivePid: vi.fn(() => null) },
      runRoutes: { setConnectionRoute: vi.fn() },
    } as unknown as KernelContext;
    const spoofedOrigin = {
      kind: "adapter",
      adapter: "whatsapp",
      accountId: "primary",
      surface: { kind: "dm", id: "dm-1" },
      actorId: "external",
    };

    await forwardToProcess({
      type: "req",
      id: "send-1",
      call: "proc.send",
      args: {
        pid: "proc-1",
        message: "hello",
        origin: spoofedOrigin,
      },
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc-1",
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({
          message: "hello",
          origin: {
            kind: "client",
            connectionId: "conn-1",
            clientId: "browser-extension",
            platform: "browser",
          },
        }),
      }),
    );
  });

  it.each([
    { call: "codemode.run", id: "codemode-1", args: { pid: "proc-1", code: "return 1" } },
    {
      call: "proc.conversation.compact",
      id: "compact-1",
      args: { pid: "proc-1", keepLast: 1, generateSummary: true },
    },
  ])("forwards $call cancellation to the Process request", async ({ call, id, args }) => {
    const controller = new AbortController();
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => {
      if (frame.type === "sig") {
        return null;
      }
      return await new Promise(() => {});
    });
    const ctx = {
      callerOwnerUid: IDENTITY.uid,
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["codemode.run"],
      },
      requestSignal: controller.signal,
      procs: {
        get: vi.fn(() => ({ uid: IDENTITY.uid, ownerUid: IDENTITY.uid })),
      },
    } as unknown as KernelContext;
    const request = forwardToProcess({
      type: "req",
      id,
      call,
      args,
    } as RequestFrame, ctx);
    await vi.waitFor(() => expect(sendFrameToProcessMock).toHaveBeenCalledOnce());

    controller.abort(new Error("new user message"));

    await expect(request).rejects.toThrow("new user message");
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(2, "proc-1", {
      type: "sig",
      signal: "request.cancel",
      payload: { id, reason: "new user message" },
    });
  });

  it("routes proc.send results by the target process owner", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "send-root",
      ok: true,
      data: { ok: true, status: "started", runId: "run-1" },
    } satisfies ResponseFrame);
    const setConnectionRoute = vi.fn();
    const ctx = {
      identity: {
        role: "user",
        process: { ...IDENTITY, uid: 0 },
        capabilities: ["proc.send"],
      },
      connection: { id: "conn-root", state: {} },
      procs: {
        get: vi.fn(() => ({ uid: 2000, ownerUid: 1000 })),
      },
      conversations: { getByActivePid: vi.fn(() => null) },
      runRoutes: { setConnectionRoute },
    } as unknown as KernelContext;

    await forwardToProcess({
      type: "req",
      id: "send-root",
      call: "proc.send",
      args: { pid: "proc-1", message: "hello" },
    } as RequestFrame, ctx);

    expect(setConnectionRoute).toHaveBeenCalledWith("run-1", 1000, "conn-root");
  });

  it("routes untargeted proc calls through the caller owner's default conversation", async () => {
    const human: ProcessIdentity = {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/home/sam",
    };
    const agent: ProcessIdentity = {
      uid: 2000,
      gid: 2000,
      gids: [2000, 1000, 100],
      username: "friday",
      home: "/home/friday",
      cwd: "/home/friday",
    };
    const ensureDefault = vi.fn(() => ({
      record: {
        conversationId: "default:1000:2000",
        ownerUid: human.uid,
        agentUid: agent.uid,
        agentHome: agent.home,
        title: null,
        isDefault: true,
        activePid: "proc-home",
        archiveBase: DEFAULT_ARCHIVE_BASE,
        latestArchive: null,
        createdAt: 1,
        lastActiveAt: 2,
      },
      created: false,
    }));
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "history-1",
      ok: true,
      data: { ok: true, messages: [] },
    } satisfies ResponseFrame);

    const ctx = {
      callerOwnerUid: human.uid,
      identity: {
        role: "user",
        process: agent,
        capabilities: ["proc.history"],
      },
      auth: {
        getPasswdByUid: vi.fn((uid: number) => {
          if (uid === human.uid) return { ...human, gecos: "sam", shell: "/bin/init" };
          if (uid === agent.uid) return { ...agent, gecos: "friday", shell: "/bin/init" };
          return null;
        }),
        getPersonalAgentUid: vi.fn((uid: number) => (uid === human.uid ? agent.uid : null)),
        isPersonalAgentUid: vi.fn((uid: number) => uid === agent.uid),
        resolveGids: vi.fn((username: string, primaryGid: number) =>
          username === agent.username ? agent.gids : [primaryGid],
        ),
      },
      env: {
        STORAGE: makeStorageBucket(),
      },
      procs: {
        get: vi.fn((pid: string) =>
          pid === "proc-home"
            ? { processId: pid, uid: agent.uid, ownerUid: human.uid }
            : null
        ),
      },
      conversations: {
        ensureDefault,
        getByActivePid: vi.fn(() => null),
      },
    } as unknown as KernelContext;

    await forwardToProcess({
      type: "req",
      id: "history-1",
      call: "proc.history",
      args: {},
    } as RequestFrame, ctx);

    expect(ensureDefault).toHaveBeenCalledWith(human.uid, agent.uid);
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc-home",
      expect.objectContaining({ call: "proc.history" }),
    );
  });

  it("forwards process AI profile selectors without materializing profile secrets", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "ai-profile-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        config: {
          version: 1,
          profile: { id: "fast-stack", name: "Fast Stack", appliedAt: 1 },
          values: {
            "config/ai/provider": "openai",
            "config/ai/model": "gpt-4.1-mini",
            "config/ai/api_key": "redacted",
            "config/ai/image/read/api_key": "redacted",
          },
          updatedAt: 1,
        },
      },
    } satisfies ResponseFrame);
    const configEntries = new Map<string, string>([
      ["users/1000/ai/model_profiles", JSON.stringify({
        version: 1,
        profiles: [{
          id: "fast-stack",
          name: "Fast Stack",
          values: {
            "config/ai/provider": "openai",
            "config/ai/model": "gpt-4.1-mini",
            "config/ai/image/read/provider": "openai",
            "config/ai/image/read/model": "gpt-4o",
          },
          createdAt: 10,
          updatedAt: 20,
        }],
      })],
      ["users/1000/ai/model_profiles/fast-stack/api_key", "sk-chat"],
      ["users/1000/ai/model_profiles/fast-stack/image/read/api_key", "sk-image"],
    ]);
    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.ai.config.set"],
      },
      procs: {
        get: vi.fn(() => ({ uid: 2000, ownerUid: IDENTITY.uid })),
      },
      config: {
        get: vi.fn((key: string) => configEntries.get(key) ?? null),
      },
      conversations: { getByActivePid: vi.fn(() => null) },
    } as unknown as KernelContext;

    await forwardToProcess({
      type: "req",
      id: "ai-profile-1",
      call: "proc.ai.config.set",
      args: {
        pid: "proc-1",
        profileId: "fast-stack",
      },
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc-1",
      expect.objectContaining({
        call: "proc.ai.config.set",
        args: {
          values: {
            "config/ai/provider": "openai",
            "config/ai/model": "gpt-4.1-mini",
            "config/ai/image/read/provider": "openai",
            "config/ai/image/read/model": "gpt-4o",
          },
          profile: {
            id: "fast-stack",
            name: "Fast Stack",
          },
        },
      }),
    );
  });

  it("forces forwarded process AI config reads to stay redacted", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "ai-config-get-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        config: {
          version: 1,
          values: {
            "config/ai/api_key": "redacted",
          },
          updatedAt: 1,
        },
      },
    } satisfies ResponseFrame);
    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.ai.config.get"],
      },
      procs: {
        get: vi.fn(() => ({ uid: 2000, ownerUid: IDENTITY.uid })),
      },
      conversations: { getByActivePid: vi.fn(() => null) },
    } as unknown as KernelContext;

    await forwardToProcess({
      type: "req",
      id: "ai-config-get-1",
      call: "proc.ai.config.get",
      args: {
        pid: "proc-1",
        redacted: false,
      },
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc-1",
      expect.objectContaining({
        call: "proc.ai.config.get",
        args: {
          pid: "proc-1",
          redacted: true,
        },
      }),
    );
  });

  it("clears a default conversation archive pointer after proc.reset", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "reset-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        archivedMessages: 1,
        archivedTo: "/process-conversation-archives/1000/2000/",
        archives: [{
          conversationId: "default",
          generation: 1,
          messages: 1,
          path: `${DEFAULT_ARCHIVE_BASE}/reset.default.gen-1.jsonl.gz`,
        }],
      },
    } satisfies ResponseFrame);
    const setLatestArchive = vi.fn();
    const ctx = makeForwardContext({ setLatestArchive });

    await forwardToProcess({
      type: "req",
      id: "reset-1",
      call: "proc.reset",
      args: { pid: "proc-1" },
    } as RequestFrame, ctx);

    expect(setLatestArchive).toHaveBeenCalledWith("default:1000:2000", null);
    expect(ctx.ipcCalls.cancelBySourcePid).toHaveBeenCalledWith({
      uid: IDENTITY.uid,
      sourcePid: "proc-1",
    });
    expect(ctx.failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc-1",
      "Target process was reset",
    );
  });

  it("clears a default conversation archive pointer after resetting the primary thread", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "conversation-reset-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        conversationId: "default",
        generation: 2,
        archivedMessages: 1,
      },
    } satisfies ResponseFrame);
    const setLatestArchive = vi.fn();
    const ctx = makeForwardContext({ setLatestArchive });

    await forwardToProcess({
      type: "req",
      id: "conversation-reset-1",
      call: "proc.conversation.reset",
      args: { pid: "proc-1" },
    } as RequestFrame, ctx);

    expect(setLatestArchive).toHaveBeenCalledWith("default:1000:2000", null);
  });

  it("updates a default conversation archive pointer on proc.kill when a primary archive is returned", async () => {
    const setLatestArchive = vi.fn();
    const clearActivePid = vi.fn();
    const ctx = makeForwardContext({ setLatestArchive, clearActivePid });
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "kill-archive",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        archivedMessages: 1,
        archives: [{
          conversationId: "default",
          generation: 1,
          messages: 1,
          path: `${DEFAULT_ARCHIVE_BASE}/kill.default.gen-1.jsonl.gz`,
        }],
      },
    } satisfies ResponseFrame);

    await forwardToProcess({
      type: "req",
      id: "kill-archive",
      call: "proc.kill",
      args: { pid: "proc-1" },
    } as RequestFrame, ctx);

    expect(setLatestArchive).toHaveBeenLastCalledWith(
      "default:1000:2000",
      `${DEFAULT_ARCHIVE_BASE}/kill.default.gen-1.jsonl.gz`,
    );
    expect(clearActivePid).toHaveBeenCalledWith("proc-1");
    expect(ctx.runRoutes.delete).toHaveBeenCalledWith("run-active");
    expect(ctx.failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc-1",
      "Target process was killed",
    );
  });

  it("preserves a default conversation archive pointer on proc.kill when no archive is returned", async () => {
    const setLatestArchive = vi.fn();
    const clearActivePid = vi.fn();
    const ctx = makeForwardContext({ setLatestArchive, clearActivePid });
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "kill-empty",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        archivedMessages: 0,
        archives: [],
      },
    } satisfies ResponseFrame);

    await forwardToProcess({
      type: "req",
      id: "kill-empty",
      call: "proc.kill",
      args: { pid: "proc-1" },
    } as RequestFrame, ctx);

    expect(setLatestArchive).not.toHaveBeenCalled();
    expect(clearActivePid).toHaveBeenCalledWith("proc-1");
  });

  it("cleans up pending IPC call when delivery reports failure", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "deliver",
      ok: true,
      data: { ok: false, error: "target unavailable" } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame);

    const { ctx, ipcCalls } = makeIpcCallContext();
    const result = await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "target unavailable" });
    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    const runId = (sendFrameToProcessMock.mock.calls[0]?.[1] as RequestFrame | undefined)?.args.runId;
    expect(callId).toBeTruthy();
    expect(runId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      sourceRunId: "source-run",
      targetRunId: runId,
    }));
    expect(ctx.scheduleIpcCallTimeout).toHaveBeenCalledWith(
      callId,
      ipcCalls.create.mock.calls[0]?.[0]?.deadlineAt,
    );
  });

  it("spawns a fresh top-level process when explicit cwd is requested", async () => {
    const personalAgent = {
      username: "sam-agent",
      uid: 2000,
      gid: 2000,
      gecos: "sam agent",
      home: "/home/sam-agent",
      shell: "/bin/init",
    };
    const ctx = {
      kernelName: "kernel-human-2",
      env: {
        STORAGE: makeStorageBucket(),
      },
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getPersonalAgentUid: vi.fn((uid: number) => uid === IDENTITY.uid ? personalAgent.uid : null),
        getPasswdByUid: vi.fn((uid: number) => uid === personalAgent.uid ? personalAgent : null),
        resolveGids: vi.fn((_username: string, gid: number) => [gid]),
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      conversations: spawnConversationsMock(),
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      label: "Review Demo Tool",
      prompt: "Review this package.",
      cwd: "/src/repos/sam/demo-a/packages/demo-tool",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/repos/sam/demo-a/packages/demo-tool",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uid: personalAgent.uid,
        username: personalAgent.username,
        cwd: "/src/repos/sam/demo-a/packages/demo-tool",
      }),
      expect.objectContaining({
        ownerUid: IDENTITY.uid,
        label: "Review Demo Tool",
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      call: "proc.setidentity",
      args: expect.objectContaining({ kernelName: "kernel-human-2" }),
    }));
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      call: "proc.send",
      args: expect.objectContaining({ message: "Review this package." }),
    }));
  });

  it("spawns a fresh top-level process when requested without explicit cwd", async () => {
    const personalAgent = {
      username: "sam-agent",
      uid: 2000,
      gid: 2000,
      gecos: "sam agent",
      home: "/home/sam-agent",
      shell: "/bin/init",
    };
    const ctx = {
      env: {
        STORAGE: makeStorageBucket(),
      },
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      auth: {
        getPersonalAgentUid: vi.fn((uid: number) => uid === IDENTITY.uid ? personalAgent.uid : null),
        getPasswdByUid: vi.fn((uid: number) => uid === personalAgent.uid ? personalAgent : null),
        isPersonalAgentUid: vi.fn((uid: number) => uid === personalAgent.uid),
        resolveGids: vi.fn((_username: string, gid: number) => [gid]),
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      conversations: spawnConversationsMock(),
      packages: {
        resolve: vi.fn(() => null),
        list: vi.fn(() => []),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      fresh: true,
      interactive: true,
      label: "New task",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      label: "New task",
      cwd: "/home/sam-agent",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uid: personalAgent.uid,
        username: personalAgent.username,
      }),
      expect.objectContaining({
        ownerUid: IDENTITY.uid,
        label: "New task",
        interactive: true,
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      call: "proc.setidentity",
    }));
  });

  it.each(["null", "error", "throw"] as const)(
    "rolls back a fresh spawn when proc.setidentity returns %s",
    async (failure) => {
      if (failure === "null") {
        sendFrameToProcessMock.mockResolvedValueOnce(null);
      } else if (failure === "error") {
        sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 500, message: "identity rejected" },
        }));
      } else {
        sendFrameToProcessMock.mockRejectedValueOnce(new Error("process unavailable"));
      }

      const conversations = spawnConversationsMock();
      const procs = {
        get: vi.fn(() => SPAWN_PARENT),
        spawn: vi.fn(),
        kill: vi.fn(() => true),
      };
      const ctx = {
        processId: SPAWN_PARENT.processId,
        callerOwnerUid: IDENTITY.uid,
        identity: {
          process: IDENTITY,
          capabilities: ["proc.spawn"],
        },
        procs,
        conversations,
      } as unknown as KernelContext;

      const result = await handleProcSpawn({ fresh: true }, ctx);
      const pid = procs.spawn.mock.calls[0]?.[0];

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Failed to initialize process"),
      });
      expect(pid).toEqual(expect.any(String));
      expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(pid, expect.objectContaining({
        call: "proc.kill",
        args: { pid, archive: false },
      }));
      expect(conversations.clearActivePid).toHaveBeenCalledWith(pid);
      expect(conversations.remove).toHaveBeenCalledWith("conv-1");
      expect(procs.kill).toHaveBeenCalledWith(pid);
    },
  );

  it("keeps a failed spawn registered when Process rollback fails", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (_pid, frame) => ({
        type: "res",
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 500, message: "finish route unavailable" },
      }));
    const conversations = spawnConversationsMock();
    const procs = {
      get: vi.fn(() => SPAWN_PARENT),
      spawn: vi.fn(),
      kill: vi.fn(() => true),
    };
    const ctx = {
      processId: SPAWN_PARENT.processId,
      callerOwnerUid: IDENTITY.uid,
      identity: {
        process: IDENTITY,
        capabilities: ["proc.spawn"],
      },
      procs,
      conversations,
    } as unknown as KernelContext;

    const result = await handleProcSpawn({ fresh: true }, ctx);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("rollback failed: finish route unavailable"),
    });
    expect(conversations.clearActivePid).not.toHaveBeenCalled();
    expect(conversations.remove).not.toHaveBeenCalled();
    expect(procs.kill).not.toHaveBeenCalled();
  });

  it("spawns a fresh interactive worker for a parented spawn", async () => {
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => SPAWN_PARENT),
        spawn: vi.fn(),
      },
      conversations: spawnConversationsMock(),
      packages: {
        resolve: vi.fn(() => null),
        list: vi.fn(() => []),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({ parentPid: `init:${IDENTITY.uid}` }, ctx);

    expect(result).toMatchObject({ ok: true });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ interactive: true }),
    );
  });

  it("rejects inheriting run-as identity from an explicit unrelated parent", async () => {
    const packageAgent = {
      ...IDENTITY,
      uid: 3000,
      gid: 3000,
      gids: [3000],
      username: "wiki-builder",
      home: "/home/wiki-builder",
      cwd: "/home/wiki-builder",
    };
    const personalAgent = {
      ...IDENTITY,
      uid: 2000,
      gid: 2000,
      gids: [2000],
      username: "sam-agent",
      home: "/home/sam-agent",
      cwd: "/home/sam-agent",
    };
    const ctx = {
      processId: "proc:package-agent",
      callerOwnerUid: IDENTITY.uid,
      env: {},
      identity: {
        process: packageAgent,
        capabilities: ["proc.spawn"],
      },
      procs: {
        get: vi.fn((pid: string) => {
          if (pid === "proc:package-agent") {
            return {
              processId: pid,
              uid: packageAgent.uid,
              ownerUid: IDENTITY.uid,
              gid: packageAgent.gid,
              gids: packageAgent.gids,
              username: packageAgent.username,
              home: packageAgent.home,
              cwd: packageAgent.cwd,
            };
          }
          if (pid === "proc:personal-agent") {
            return {
              processId: pid,
              uid: personalAgent.uid,
              ownerUid: IDENTITY.uid,
              gid: personalAgent.gid,
              gids: personalAgent.gids,
              username: personalAgent.username,
              home: personalAgent.home,
              cwd: personalAgent.cwd,
            };
          }
          return null;
        }),
        spawn: vi.fn(),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      parentPid: "proc:personal-agent",
      prompt: "Run under the other parent.",
    }, ctx);

    expect(result).toEqual({
      ok: false,
      error: "Cannot inherit run-as identity from unrelated parent process: proc:personal-agent",
    });
    expect(ctx.procs.spawn).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

});

function makeIpcCallContext(options: {
  identity?: ProcessIdentity;
  source?: { uid: number; ownerUid: number; activeRunId?: string | null };
  target?: { uid: number; ownerUid: number };
} = {}) {
  const identity = options.identity ?? IDENTITY;
  const source = {
    activeRunId: "source-run",
    ...(options.source ?? { uid: identity.uid, ownerUid: identity.uid }),
  };
  const target = options.target ?? { uid: identity.uid, ownerUid: identity.uid };
  const ipcCalls = {
    create: vi.fn(),
    get: vi.fn(() => ({ status: "pending", error: null })),
    remove: vi.fn(),
  };
  const ctx = {
    processId: "source-process",
    processRunId: "source-run",
    identity: { process: identity },
    procs: {
      get: vi.fn((pid: string) => {
        if (pid === "source-process") return source;
        if (pid === "target-process") return target;
        return undefined;
      }),
    },
    ipcCalls,
    scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
  } as unknown as KernelContext;

  return { ctx, ipcCalls };
}

function makeForwardContext(overrides?: {
  setLatestArchive?: (conversationId: string, archivePath: string | null) => boolean;
  clearActivePid?: (pid: string) => void;
  cancelBySourcePid?: (input: { uid: number; sourcePid: string }) => void;
}): KernelContext {
  return {
    identity: {
      role: "user",
      process: IDENTITY,
      capabilities: ["proc.reset", "proc.kill"],
    },
    procs: {
      get: vi.fn(() => ({
        uid: IDENTITY.uid,
        ownerUid: IDENTITY.uid,
        activeRunId: "run-active",
      })),
      kill: vi.fn(),
    },
    runRoutes: {
      delete: vi.fn(),
    },
    conversations: {
      getByActivePid: vi.fn(() => ({
        conversationId: "default:1000:2000",
        ownerUid: 1000,
        agentUid: 2000,
        title: null,
        isDefault: true,
        activePid: "proc-1",
        archiveBase: DEFAULT_ARCHIVE_BASE,
        latestArchive: `${DEFAULT_ARCHIVE_BASE}/old.default.gen-1.jsonl.gz`,
        createdAt: 1,
        lastActiveAt: 2,
      })),
      setLatestArchive: overrides?.setLatestArchive ?? vi.fn(),
      clearActivePid: overrides?.clearActivePid ?? vi.fn(),
    },
    ipcCalls: {
      cancelBySourcePid: overrides?.cancelBySourcePid ?? vi.fn(),
    },
    failIpcCallsByTarget: vi.fn(),
  } as unknown as KernelContext;
}

describe("resolveCallerOwnerUid", () => {
  it("honors an explicit caller owner override", () => {
    const ctx = {
      callerOwnerUid: 1000,
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: [] },
      procs: { get: vi.fn(() => null) },
    } as unknown as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });

  it("resolves to the owning human of the calling process, not the run-as uid", () => {
    const ctx = {
      processId: "proc:abc",
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: [] },
      procs: { getOwnerUid: vi.fn(() => 1000) },
    } as unknown as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });

  it("falls back to the connecting user when not invoked from a process", () => {
    const ctx = {
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: [] },
      procs: { get: vi.fn(() => null) },
    } as unknown as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });
});

describe("resolveRunAsIdentity", () => {
  // Owner human 1000 (alice); her personal agent 2000; a least-privilege
  // package agent 3000 that alice is NOT authorized to act as.
  const passwd: Record<number, { username: string; uid: number; gid: number; home: string }> = {
    1000: { username: "alice", uid: 1000, gid: 1000, home: "/home/alice" },
    2000: { username: "alice-agent", uid: 2000, gid: 2000, home: "/home/alice-agent" },
    3000: { username: "wiki-builder", uid: 3000, gid: 3000, home: "/home/wiki-builder" },
  };
  const byName = Object.fromEntries(Object.values(passwd).map((p) => [p.username, p]));

  function authMock() {
    return {
      getPasswdByUid: vi.fn((uid: number) => passwd[uid] ?? null),
      getPasswdByUsername: vi.fn((name: string) => byName[name] ?? null),
      getPersonalAgentUid: vi.fn((ownerUid: number) => (ownerUid === 1000 ? 2000 : null)),
      // No one is listed in alice's primary group members here.
      getGroupByGid: vi.fn((gid: number) => ({ name: `g${gid}`, gid, members: [] as string[] })),
      getGroupByName: vi.fn(() => null),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    };
  }

  function ctxFor(runAsUid: number, processId?: string) {
    return {
      processId,
      identity: { role: "user", process: { ...IDENTITY, uid: runAsUid }, capabilities: ["proc.spawn"] },
      auth: authMock(),
    } as unknown as KernelContext;
  }

  it("denies an agent-backed process from running as the owning human", () => {
    // Caller runs as the package agent (3000); owner is the human (1000).
    const res = resolveRunAsIdentity(ctxFor(3000, "proc:abc"), "alice", 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot run as alice/i);
  });

  it("still lets a human run as themselves and their personal agent", () => {
    const self = resolveRunAsIdentity(ctxFor(1000), "alice", 1000);
    expect(self.ok).toBe(true);
    const agent = resolveRunAsIdentity(ctxFor(1000), "alice-agent", 1000);
    expect(agent.ok).toBe(true);
    if (agent.ok) expect(agent.identity.uid).toBe(2000);
  });

  it("allows runAs by package agent username when the owner is in the access group", () => {
    const wikiBuilder = { username: "wiki-builder", uid: 3000, gid: 3000, home: "/home/wiki-builder" };
    const auth = {
      getPasswdByUid: vi.fn((uid: number) => (uid === 3000 ? wikiBuilder : passwd[uid] ?? null)),
      getPasswdByUsername: vi.fn((name: string) => (name === "wiki-builder" ? wikiBuilder : byName[name] ?? null)),
      getPersonalAgentUid: vi.fn((ownerUid: number) => (ownerUid === 1000 ? 2000 : null)),
      getGroupByGid: vi.fn((gid: number) => {
        if (gid === 3000) return { name: "wiki-builder", gid: 3000, members: [] };
        return { name: `g${gid}`, gid, members: [] as string[] };
      }),
      getGroupByName: vi.fn((name: string) => {
        if (name === "wiki-builder-run") return { name, gid: 3001, members: ["alice"] };
        return null;
      }),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    };
    const ctx = {
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: ["proc.spawn"] },
      auth,
    } as unknown as KernelContext;

    const res = resolveRunAsIdentity(ctx, "wiki-builder", 1000);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.uid).toBe(3000);
  });
});

describe("handleProcList", () => {
  it("filters by the owning human when an agent process lists its user's processes", () => {
    const list = vi.fn(() => []);
    const ctx = {
      processId: "proc:abc",
      // The process runs as the personal agent (uid 2000) but is owned by the
      // human (uid 1000); listing must resolve to the human owner.
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: ["proc.list"] },
      procs: { getOwnerUid: vi.fn(() => 1000), list },
      conversations: { getByActivePid: vi.fn(() => null) },
    } as unknown as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(1000);
  });

  it("lets a non-root connecting user see only their own processes", () => {
    const list = vi.fn(() => []);
    const ctx = {
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: ["proc.list"] },
      procs: { get: vi.fn(() => null), list },
      conversations: { getByActivePid: vi.fn(() => null) },
    } as unknown as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(1000);

    list.mockClear();
    handleProcList({ uid: 2000 }, ctx);
    expect(list).toHaveBeenCalledWith(1000);
  });

  it("lets root list all processes and honors an explicit uid filter", () => {
    const list = vi.fn(() => []);
    const ctx = {
      identity: { role: "user", process: { ...IDENTITY, uid: 0, username: "root" }, capabilities: ["proc.list"] },
      procs: { get: vi.fn(() => null), list },
      conversations: { getByActivePid: vi.fn(() => null) },
    } as unknown as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(undefined);

    list.mockClear();
    handleProcList({ uid: 1000 }, ctx);
    expect(list).toHaveBeenCalledWith(1000);
  });
});

function makePackage(packageId: string, name: string, repo: string, subdir = ".") {
  return {
    packageId,
    scope: { kind: "user", uid: IDENTITY.uid },
    manifest: {
      name,
      description: name,
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo,
        ref: "main",
        subdir,
        resolvedCommit: "base123",
      },
      entrypoints: [],
    },
    artifact: { hash: "hash", mainModule: "main.js", modulePaths: ["main.js"] },
    enabled: true,
    reviewRequired: false,
    reviewedAt: 1,
    installedAt: 1,
    updatedAt: 1,
  };
}
