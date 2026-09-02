import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProcessIdentity,
  ProcIpcSendResult,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { KernelContext } from "./context";

import * as utils from "../shared/utils";
import { forwardToProcess, handleProcFork, handleProcIpcCall, handleProcIpcSend, handleProcSpawn, handleProcList, resolveRunAsIdentity } from "./proc-handlers";
import { resolveCallerOwnerUid } from "./context";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};
// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const TEST_INSTALLATION_ID = "singleton" as KernelContext["installationId"];

const PERSONAL_AGENT_ACCOUNT = {
  username: "sam-agent",
  uid: 2000,
  gid: 2000,
  gecos: "Sam Agent",
  home: "/home/sam-agent",
  shell: "/bin/init",
};

function makePersonalAgentAuth() {
  return {
    getPasswdByUsername: vi.fn((username: string) => (
      username === PERSONAL_AGENT_ACCOUNT.username ? PERSONAL_AGENT_ACCOUNT : null
    )),
    getPasswdByUid: vi.fn((uid: number) => {
      if (uid === IDENTITY.uid) {
        return {
          username: IDENTITY.username,
          uid: IDENTITY.uid,
          gid: IDENTITY.gid,
          gecos: IDENTITY.username,
          home: IDENTITY.home,
          shell: "/bin/init",
        };
      }
      return uid === PERSONAL_AGENT_ACCOUNT.uid ? PERSONAL_AGENT_ACCOUNT : null;
    }),
    getShadowByUsername: vi.fn((username: string) => (
      username === PERSONAL_AGENT_ACCOUNT.username ? { username, hash: "!" } : null
    )),
    getGroupByGid: vi.fn((gid: number) => (
      gid === PERSONAL_AGENT_ACCOUNT.gid
        ? { name: PERSONAL_AGENT_ACCOUNT.username, gid, members: [IDENTITY.username] }
        : null
    )),
    getPersonalAgentUid: vi.fn(() => PERSONAL_AGENT_ACCOUNT.uid),
    isPersonalAgentUid: vi.fn((uid: number) => uid === PERSONAL_AGENT_ACCOUNT.uid),
    resolveGids: vi.fn((_username: string, gid: number) => [gid]),
  };
}

const sendFrameToProcessMock = vi.spyOn(utils, "sendFrameToProcess");

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

function makeStorageBucket() {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    head: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
}

function makeProcessCleanupMocks() {
  return {
    runRoutes: {
      clearForProcess: vi.fn(),
    },
    responsibilities: {
      reclaimProcessAssignments: vi.fn(() => []),
    },
    failIpcCallsByTarget: vi.fn(),
    defer: vi.fn(),
    reconcileResponsibilityWake: vi.fn(async () => {}),
  };
}

describe("proc handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "signal",
      ok: true,
      data: { ok: true },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as ResponseFrame));
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const runId = (sendFrameToProcessMock.mock.calls[0]?.[2] as RequestFrame | undefined)?.args.runId;
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
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const firstCall = sendFrameToProcessMock.mock.calls[0];
    if (!firstCall) throw new Error("expected proc.start frame");
    // SAFETY: The proc.start fixture records a request frame in the third mock argument.
    const runId = (firstCall[2] as RequestFrame).args.runId;
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
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
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
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "target-process",
        sourcePid: "source-process",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

  it.each([
    { call: "codemode.run", id: "codemode-1", args: { pid: "proc-1", code: "return 1" } },
    {
      call: "proc.history.compact",
      id: "compact-1",
      args: { pid: "proc-1", keepLast: 1, generateSummary: true },
    },
  ])("forwards $call cancellation to the Process request", async ({ call, id, args }) => {
    const controller = new AbortController();
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type === "sig") {
        return null;
      }
      return await new Promise(() => {});
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const request = forwardToProcess({
      type: "req",
      id,
      call,
      args,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);
    await vi.waitFor(() => expect(sendFrameToProcessMock).toHaveBeenCalledOnce());

    controller.abort(new Error("new user message"));

    await expect(request).rejects.toThrow("new user message");
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      TEST_INSTALLATION_ID,
      "proc-1",
      {
      type: "sig",
      signal: "request.cancel",
      payload: { id, reason: "new user message" },
      },
    );
  });

  it("routes proc.send results by the target process owner", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "send-root",
      ok: true,
      data: { ok: true, status: "started", runId: "run-1" },
    } satisfies ResponseFrame);
    const setConnectionRoute = vi.fn();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: {
        role: "user",
        process: { ...IDENTITY, uid: 0 },
        capabilities: ["proc.send"],
      },
      connection: { id: "conn-root", state: {} },
      procs: {
        get: vi.fn(() => ({ uid: 2000, ownerUid: 1000 })),
      },
      runRoutes: { setConnectionRoute },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "send-root",
      call: "proc.send",
      args: { pid: "proc-1", message: "hello" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(setConnectionRoute).toHaveBeenCalledWith({
      runId: "run-1",
      processId: "proc-1",
      uid: 1000,
      connectionId: "conn-root",
    });
  });

  it("routes untargeted proc calls to the caller process", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "history-1",
      ok: true,
      data: { ok: true, messages: [] },
    } satisfies ResponseFrame);

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: "proc-self",
      callerOwnerUid: IDENTITY.uid,
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.history"],
      },
      procs: {
        get: vi.fn((pid: string) => pid === "proc-self"
          ? { processId: pid, uid: IDENTITY.uid, ownerUid: IDENTITY.uid }
          : null),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "history-1",
      call: "proc.history",
      args: {},
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc-self",
      expect.objectContaining({ call: "proc.history" }),
    );
  });

  it("requires an explicit pid outside a process", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      callerOwnerUid: IDENTITY.uid,
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.history"],
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await expect(forwardToProcess({
      type: "req",
      id: "history-1",
      call: "proc.history",
      args: {},
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx)).rejects.toThrow("proc.history requires pid outside a process");
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("validates and forwards only a stable Process model reference", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "ai-profile-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        config: {
          version: 2,
          modelId: "fast-stack",
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
            "config/ai/image/read/max_tokens": "4096",
          },
          createdAt: 10,
          updatedAt: 20,
        }],
      })],
      ["users/1000/ai/model_profiles/fast-stack/api_key", "sk-chat"],
    ]);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
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
        getExplicit: vi.fn((key: string) => configEntries.get(key) ?? null),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "ai-profile-1",
      call: "proc.ai.config.set",
      args: {
        pid: "proc-1",
        modelId: "fast-stack",
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc-1",
      expect.objectContaining({
        call: "proc.ai.config.set",
        args: {
          pid: "proc-1",
          modelId: "fast-stack",
        },
      }),
    );
  });

  it("forwards Process preference reads without a credential-bearing mode", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "ai-config-get-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        config: {
          version: 2,
          modelId: "fast-stack",
          updatedAt: 1,
        },
      },
    } satisfies ResponseFrame);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.ai.config.get"],
      },
      procs: {
        get: vi.fn(() => ({ uid: 2000, ownerUid: IDENTITY.uid })),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "ai-config-get-1",
      call: "proc.ai.config.get",
      args: {
        pid: "proc-1",
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc-1",
      expect.objectContaining({
        call: "proc.ai.config.get",
        args: {
          pid: "proc-1",
        },
      }),
    );
  });

  it("clears process routes and IPC state after proc.reset", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "reset-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        archivedMessages: 1,
        archivedTo: "/home/sam-agent/history/",
        archives: [{
          generation: 1,
          messages: 1,
          path: "/home/sam-agent/history/reset.gen-1.jsonl.gz",
        }],
      },
    } satisfies ResponseFrame);
    const ctx = makeForwardContext();

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "reset-1",
      call: "proc.reset",
      args: { pid: "proc-1" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(ctx.ipcCalls.cancelBySourcePid).toHaveBeenCalledWith({
      uid: IDENTITY.uid,
      sourcePid: "proc-1",
    });
    expect(ctx.runRoutes.clearForProcess).toHaveBeenCalledWith("proc-1");
    expect(ctx.failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc-1",
      "Target process was reset",
    );
    expect(ctx.procs.kill).not.toHaveBeenCalled();
  });

  it("unregisters a killed process after its history is archived", async () => {
    const ctx = makeForwardContext();
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "kill-archive",
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        archivedMessages: 1,
        archives: [{
          generation: 1,
          messages: 1,
          path: "/home/sam-agent/history/kill.gen-1.jsonl.gz",
        }],
      },
    } satisfies ResponseFrame);

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await forwardToProcess({
      type: "req",
      id: "kill-archive",
      call: "proc.kill",
      args: { pid: "proc-1" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx);

    expect(ctx.procs.kill).toHaveBeenCalledWith("proc-1");
    expect(ctx.responsibilities.reclaimProcessAssignments).toHaveBeenCalledWith({
      ownerUid: IDENTITY.uid,
      processId: "proc-1",
      now: expect.any(Number),
    });
    expect(ctx.runRoutes.clearForProcess).toHaveBeenCalledWith("proc-1");
    expect(ctx.failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc-1",
      "Target process was killed",
    );
  });

  it.each(["archive failed", "terminal commit failed"])(
    "retains a process registration when proc.kill reports %s",
    async (message) => {
      const ctx = makeForwardContext();
      sendFrameToProcessMock.mockResolvedValueOnce({
        type: "res",
        id: "kill-failed",
        ok: false,
        error: { code: 500, message },
      } satisfies ResponseFrame);

      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      await expect(forwardToProcess({
        type: "req",
        id: "kill-failed",
        call: "proc.kill",
        args: { pid: "proc-1" },
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as RequestFrame, ctx)).rejects.toThrow(message);

      expect(ctx.procs.kill).not.toHaveBeenCalled();
      expect(ctx.runRoutes.clearForProcess).not.toHaveBeenCalled();
    },
  );

  it("reconciles Kernel state after terminal cleanup succeeds on retry", async () => {
    const ctx = makeForwardContext();
    sendFrameToProcessMock
      .mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        id: (frame as RequestFrame).id,
        ok: false,
        error: {
          code: 500,
          message: "Process was killed but terminal cleanup is pending",
        },
      }))
      .mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        id: (frame as RequestFrame).id,
        ok: true,
        data: {
          ok: true,
          pid: "proc-1",
          archivedMessages: 0,
          archives: [],
        },
      }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const request = {
      type: "req",
      id: "kill-cleanup-retry",
      call: "proc.kill",
      args: { pid: "proc-1" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame;

    await expect(forwardToProcess(request, ctx)).rejects.toThrow(
      "terminal cleanup is pending",
    );
    expect(ctx.procs.kill).not.toHaveBeenCalled();

    await expect(forwardToProcess(request, ctx)).resolves.toMatchObject({
      data: { ok: true, pid: "proc-1" },
    });
    expect(ctx.procs.kill).toHaveBeenCalledWith("proc-1");
    expect(ctx.runRoutes.clearForProcess).toHaveBeenCalledWith("proc-1");
  });

  it("unregisters a process when a retried kill reports it already dead", async () => {
    const ctx = makeForwardContext();
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "kill-already-dead",
      ok: false,
      error: { code: 410, message: "Process no longer exists" },
    } satisfies ResponseFrame);

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    await expect(forwardToProcess({
      type: "req",
      id: "kill-already-dead",
      call: "proc.kill",
      args: { pid: "proc-1" },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as RequestFrame, ctx)).rejects.toThrow("Process no longer exists");

    expect(ctx.ipcCalls.cancelBySourcePid).toHaveBeenCalledWith({
      uid: IDENTITY.uid,
      sourcePid: "proc-1",
    });
    expect(ctx.runRoutes.clearForProcess).toHaveBeenCalledWith("proc-1");
    expect(ctx.failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc-1",
      "Target process was killed",
    );
    expect(ctx.procs.kill).toHaveBeenCalledWith("proc-1");
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const runId = (sendFrameToProcessMock.mock.calls[0]?.[2] as RequestFrame | undefined)?.args.runId;
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      env: {
        STORAGE: makeStorageBucket(),
      },
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      auth: makePersonalAgentAuth(),
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({
      label: "Review Demo Tool",
      prompt: "Review this project.",
      cwd: "/src/repos/sam/demo-a/tools/demo-tool",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/repos/sam/demo-a/tools/demo-tool",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uid: PERSONAL_AGENT_ACCOUNT.uid,
        username: PERSONAL_AGENT_ACCOUNT.username,
        cwd: "/src/repos/sam/demo-a/tools/demo-tool",
      }),
      expect.objectContaining({
        ownerUid: IDENTITY.uid,
        label: "Review Demo Tool",
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      expect.any(String),
      expect.objectContaining({
        call: "proc.setidentity",
        args: expect.objectContaining({
          title: "Review Demo Tool",
          autoTitle: false,
        }),
      }),
    );
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const identityFrame = sendFrameToProcessMock.mock.calls.find(([, , frame]) =>
      frame.type === "req" && frame.call === "proc.setidentity"
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    )?.[2] as RequestFrame | undefined;
    expect(identityFrame?.args).not.toHaveProperty("installationId");
    expect(identityFrame?.args).not.toHaveProperty("pid");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      expect.any(String),
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({ message: "Review this project." }),
      }),
    );
  });

  it("spawns a fresh top-level process when requested without explicit cwd", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      env: {
        STORAGE: makeStorageBucket(),
      },
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      auth: makePersonalAgentAuth(),
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({ interactive: true }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: PERSONAL_AGENT_ACCOUNT.home,
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uid: PERSONAL_AGENT_ACCOUNT.uid,
        username: PERSONAL_AGENT_ACCOUNT.username,
      }),
      expect.objectContaining({
        ownerUid: IDENTITY.uid,
        interactive: true,
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      expect.any(String),
      expect.objectContaining({
        call: "proc.setidentity",
        args: expect.objectContaining({
          autoTitle: true,
        }),
      }),
    );
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const identityFrame = sendFrameToProcessMock.mock.calls.find(([, , frame]) =>
      frame.type === "req" && frame.call === "proc.setidentity"
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    )?.[2] as RequestFrame | undefined;
    expect(identityFrame?.args).not.toHaveProperty("title");
    expect(identityFrame?.args).not.toHaveProperty("installationId");
    expect(identityFrame?.args).not.toHaveProperty("pid");
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it.each(["null", "error", "throw"] as const)(
    "rolls back a spawn when proc.setidentity returns %s",
    async (failure) => {
      if (failure === "null") {
        sendFrameToProcessMock.mockResolvedValueOnce(null);
      } else if (failure === "error") {
        sendFrameToProcessMock.mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 500, message: "identity rejected" },
        }));
      } else {
        sendFrameToProcessMock.mockRejectedValueOnce(new Error("process unavailable"));
      }

      const procs = {
        get: vi.fn(() => SPAWN_PARENT),
        spawn: vi.fn(),
        kill: vi.fn(() => true),
      };
      const cleanup = makeProcessCleanupMocks();
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const ctx = {
        installationId: TEST_INSTALLATION_ID,
        processId: SPAWN_PARENT.processId,
        callerOwnerUid: IDENTITY.uid,
        identity: {
          process: IDENTITY,
          capabilities: ["proc.spawn"],
        },
        procs,
        ...cleanup,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as KernelContext;

      const result = await handleProcSpawn({}, ctx);
      const pid = procs.spawn.mock.calls[0]?.[0];

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Failed to initialize process"),
      });
      expect(pid).toEqual(expect.any(String));
      expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(
        TEST_INSTALLATION_ID,
        pid,
        expect.objectContaining({
          call: "proc.kill",
          args: { pid, archive: false },
        }),
      );
      expect(procs.kill).toHaveBeenCalledWith(pid);
      expect(cleanup.responsibilities.reclaimProcessAssignments).toHaveBeenCalledWith({
        ownerUid: IDENTITY.uid,
        processId: pid,
        now: expect.any(Number),
      });
    },
  );

  it("keeps a failed spawn registered when Process rollback fails", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 500, message: "finish route unavailable" },
      }));
    const procs = {
      get: vi.fn(() => SPAWN_PARENT),
      spawn: vi.fn(),
      kill: vi.fn(() => true),
    };
    const cleanup = makeProcessCleanupMocks();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: SPAWN_PARENT.processId,
      callerOwnerUid: IDENTITY.uid,
      identity: {
        process: IDENTITY,
        capabilities: ["proc.spawn"],
      },
      procs,
      ...cleanup,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("rollback failed: finish route unavailable"),
    });
    expect(procs.kill).not.toHaveBeenCalled();
  });

  it("removes a failed spawn when a repeated rollback finds the Process dead", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      }));
    const procs = {
      get: vi.fn(() => SPAWN_PARENT),
      spawn: vi.fn(),
      kill: vi.fn(() => true),
    };
    const cleanup = makeProcessCleanupMocks();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: SPAWN_PARENT.processId,
      callerOwnerUid: IDENTITY.uid,
      identity: {
        process: IDENTITY,
        capabilities: ["proc.spawn"],
      },
      procs,
      ...cleanup,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({}, ctx);
    const pid = procs.spawn.mock.calls[0]?.[0];

    expect(result).toMatchObject({
      ok: false,
      error: expect.not.stringContaining("rollback failed"),
    });
    expect(procs.kill).toHaveBeenCalledWith(pid);
  });

  it("does not roll back an existing process when registry insertion fails", async () => {
    const procs = {
      get: vi.fn(() => SPAWN_PARENT),
      spawn: vi.fn(() => {
        throw new Error("process id already exists");
      }),
      kill: vi.fn(() => true),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: SPAWN_PARENT.processId,
      callerOwnerUid: IDENTITY.uid,
      identity: {
        process: IDENTITY,
        capabilities: ["proc.spawn"],
      },
      procs,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({}, ctx);

    expect(result).toEqual({
      ok: false,
      error: "Failed to register process: process id already exists",
    });
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
    expect(procs.kill).not.toHaveBeenCalled();
  });

  it("spawns a fresh interactive worker for a parented spawn", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: SPAWN_PARENT.processId,
      processRunId: "run-parent",
      callerOwnerUid: IDENTITY.uid,
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => SPAWN_PARENT),
        spawn: vi.fn(),
      },
      runRoutes: {
        inheritProcessApprovalRoute: vi.fn(() => null),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleProcSpawn({ parentPid: `init:${IDENTITY.uid}` }, ctx);

    expect(result).toMatchObject({ ok: true });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ interactive: true }),
    );
    expect(ctx.runRoutes.inheritProcessApprovalRoute).toHaveBeenCalledWith({
      processId: expect.any(String),
      uid: IDENTITY.uid,
      sourceProcessId: SPAWN_PARENT.processId,
      sourceRunId: "run-parent",
    });
  });

  it("forks history through kernel-only process syscalls", async () => {
    const sourcePid = "proc:source";
    let targetPid: string | null = null;
    const source = {
      ...SPAWN_PARENT,
      processId: sourcePid,
      label: "Source task",
      cwd: "/home/sam/work",
    };
    const removeTemporaryHistory = vi.fn(async () => undefined);
    const procs = {
      get: vi.fn((pid: string) => pid === sourcePid ? source : null),
      spawn: vi.fn((pid: string) => {
        targetPid = pid;
      }),
      kill: vi.fn(() => true),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: sourcePid,
      callerOwnerUid: IDENTITY.uid,
      env: { STORAGE: { delete: removeTemporaryHistory } },
      identity: {
        process: IDENTITY,
        capabilities: ["proc.fork", "proc.spawn"],
      },
      auth: {
        getPasswdByUsername: vi.fn(() => ({
          username: IDENTITY.username,
          uid: IDENTITY.uid,
          gid: IDENTITY.gid,
          gecos: "Sam",
          home: IDENTITY.home,
          shell: "/bin/init",
        })),
        getPasswdByUid: vi.fn(() => ({ username: IDENTITY.username })),
        getPersonalAgentUid: vi.fn(() => null),
        getGroupByGid: vi.fn(() => null),
        resolveGids: vi.fn(() => IDENTITY.gids),
      },
      procs,
      runRoutes: {
        inheritProcessApprovalRoute: vi.fn(() => null),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    sendFrameToProcessMock.mockImplementation(async (_installationId, pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.history.export") {
        expect(frame.args).toEqual({ throughRunId: "run:conversation-message" });
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            sourcePid,
            archivePaths: ["/tmp/fork-history.jsonl.gz"],
            temporaryArchivePaths: ["/tmp/fork-history.jsonl.gz"],
            throughMessageId: 2,
            includedLiveSuffix: false,
          },
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        } as ResponseFrame;
      }
      if (frame.call === "proc.history.import") {
        expect(pid).toBe(targetPid);
        expect(frame.args).toEqual({ archivePaths: ["/tmp/fork-history.jsonl.gz"] });
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, pid, restoredMessages: 2 },
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        } as ResponseFrame;
      }
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: { ok: true },
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ResponseFrame;
    });

    const result = await handleProcFork({
      pid: sourcePid,
      throughRunId: "run:conversation-message",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      pid: targetPid,
      label: "Branch of Source task",
      sourcePid,
      throughMessageId: 2,
      restoredMessages: 2,
      includedLiveSuffix: false,
    });
    expect(procs.spawn).toHaveBeenCalledWith(
      targetPid,
      expect.objectContaining({ cwd: "/home/sam/work" }),
      expect.objectContaining({ parentPid: sourcePid, label: "Branch of Source task" }),
    );
    expect(removeTemporaryHistory).toHaveBeenCalledWith(["tmp/fork-history.jsonl.gz"]);
  });

  it("rejects inheriting run-as identity from an explicit unrelated parent", async () => {
    const delegatedAgent = {
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: "proc:delegated-agent",
      callerOwnerUid: IDENTITY.uid,
      env: {},
      identity: {
        process: delegatedAgent,
        capabilities: ["proc.spawn"],
      },
      procs: {
        get: vi.fn((pid: string) => {
          if (pid === "proc:delegated-agent") {
            return {
              processId: pid,
              uid: delegatedAgent.uid,
              ownerUid: IDENTITY.uid,
              gid: delegatedAgent.gid,
              gids: delegatedAgent.gids,
              username: delegatedAgent.username,
              home: delegatedAgent.home,
              cwd: delegatedAgent.cwd,
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

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
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const ctx = {
    installationId: TEST_INSTALLATION_ID,
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
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;

  return { ctx, ipcCalls };
}

function makeForwardContext(overrides?: {
  cancelBySourcePid?: (input: { uid: number; sourcePid: string }) => void;
}): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    installationId: TEST_INSTALLATION_ID,
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
      clearForProcess: vi.fn(),
    },
    responsibilities: {
      reclaimProcessAssignments: vi.fn(() => []),
    },
    ipcCalls: {
      cancelBySourcePid: overrides?.cancelBySourcePid ?? vi.fn(),
    },
    failIpcCallsByTarget: vi.fn(),
    defer: vi.fn(),
    reconcileResponsibilityWake: vi.fn(async () => {}),
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("resolveCallerOwnerUid", () => {
  it("honors an explicit caller owner override", () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      callerOwnerUid: 1000,
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: [] },
      procs: { get: vi.fn(() => null) },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });

  it("resolves to the owning human of the calling process, not the run-as uid", () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: "proc:abc",
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: [] },
      procs: { getOwnerUid: vi.fn(() => 1000) },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });

  it("falls back to the connecting user when not invoked from a process", () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: [] },
      procs: { get: vi.fn(() => null) },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
    expect(resolveCallerOwnerUid(ctx)).toBe(1000);
  });
});

describe("resolveRunAsIdentity", () => {
  // Owner human 1000 (alice); her personal agent 2000; a least-privilege
  // delegated agent 3000 that alice is NOT authorized to act as.
  const passwd = {
    1000: { username: "alice", uid: 1000, gid: 1000, home: "/home/alice" },
    2000: { username: "alice-agent", uid: 2000, gid: 2000, home: "/home/alice-agent" },
    3000: { username: "wiki-builder", uid: 3000, gid: 3000, home: "/home/wiki-builder" },
  } satisfies Record<number, { username: string; uid: number; gid: number; home: string }>;
  const byName = Object.fromEntries(Object.values(passwd).map((p) => [p.username, p]));

  function authMock() {
    return {
      getPasswdByUid: vi.fn((uid: number) => passwd[uid] ?? null),
      getPasswdByUsername: vi.fn((name: string) => byName[name] ?? null),
      getPersonalAgentUid: vi.fn((ownerUid: number) => (ownerUid === 1000 ? 2000 : null)),
      // No one is listed in alice's primary group members here.
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      getGroupByGid: vi.fn((gid: number) => ({ name: `g${gid}`, gid, members: [] as string[] })),
      getGroupByName: vi.fn(() => null),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    };
  }

  function ctxFor(runAsUid: number, processId?: string) {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      processId,
      identity: { role: "user", process: { ...IDENTITY, uid: runAsUid }, capabilities: ["proc.spawn"] },
      auth: authMock(),
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
  }

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("denies an agent-backed process from running as the owning human", () => {
    // Caller runs as a delegated agent (3000); owner is the human (1000).
    const res = resolveRunAsIdentity(ctxFor(3000, "proc:abc"), "alice", 1000);
    expect(res.ok).toBe(false);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    if (!res.ok) expect(res.error).toMatch(/cannot run as alice/i);
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("still lets a human run as themselves and their personal agent", () => {
    const self = resolveRunAsIdentity(ctxFor(1000), "alice", 1000);
    expect(self.ok).toBe(true);
    const agent = resolveRunAsIdentity(ctxFor(1000), "alice-agent", 1000);
    expect(agent.ok).toBe(true);
    if (agent.ok) expect(agent.identity.uid).toBe(2000);
  });

  it("allows runAs by custom agent username when the owner is in its primary group", () => {
    const wikiBuilder = { username: "wiki-builder", uid: 3000, gid: 3000, home: "/home/wiki-builder" };
    const auth = {
      getPasswdByUid: vi.fn((uid: number) => (uid === 3000 ? wikiBuilder : passwd[uid] ?? null)),
      getPasswdByUsername: vi.fn((name: string) => (name === "wiki-builder" ? wikiBuilder : byName[name] ?? null)),
      getPersonalAgentUid: vi.fn((ownerUid: number) => (ownerUid === 1000 ? 2000 : null)),
      getGroupByGid: vi.fn((gid: number) => {
        if (gid === 3000) return { name: "wiki-builder", gid: 3000, members: ["alice"] };
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        return { name: `g${gid}`, gid, members: [] as string[] };
      }),
      getGroupByName: vi.fn(() => null),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: ["proc.spawn"] },
      auth,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const res = resolveRunAsIdentity(ctx, "wiki-builder", 1000);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.uid).toBe(3000);
  });
});

describe("handleProcList", () => {
  it("exposes the personal controller marker", () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.list"],
      },
      procs: {
        list: vi.fn(() => [{
          processId: "proc:personal",
          parentPid: null,
          uid: PERSONAL_AGENT_ACCOUNT.uid,
          ownerUid: IDENTITY.uid,
          interactive: true,
          isPersonalController: true,
          gid: PERSONAL_AGENT_ACCOUNT.gid,
          gids: [PERSONAL_AGENT_ACCOUNT.gid],
          username: PERSONAL_AGENT_ACCOUNT.username,
          home: PERSONAL_AGENT_ACCOUNT.home,
          cwd: PERSONAL_AGENT_ACCOUNT.home,
          state: "idle",
          activeRunId: null,
          queuedCount: 0,
          lastActiveAt: null,
          label: null,
          createdAt: 1,
        }]),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    expect(handleProcList({}, ctx).processes[0]).toMatchObject({
      pid: "proc:personal",
      uid: IDENTITY.uid,
      personal: true,
    });
  });

  it("filters by the owning human when an agent process lists its user's processes", () => {
    const list = vi.fn(() => []);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      processId: "proc:abc",
      // The process runs as the personal agent (uid 2000) but is owned by the
      // human (uid 1000); listing must resolve to the human owner.
      identity: { role: "user", process: { ...IDENTITY, uid: 2000 }, capabilities: ["proc.list"] },
      procs: { getOwnerUid: vi.fn(() => 1000), list },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(1000);
  });

  it("lets a non-root connecting user see only their own processes", () => {
    const list = vi.fn(() => []);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: { role: "user", process: { ...IDENTITY, uid: 1000 }, capabilities: ["proc.list"] },
      procs: { get: vi.fn(() => null), list },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(1000);

    list.mockClear();
    handleProcList({ uid: 1000 }, ctx);
    expect(list).toHaveBeenCalledWith(1000);

    expect(() => handleProcList({ uid: 2000 }, ctx)).toThrow(
      "Permission denied: cannot list processes for uid=2000",
    );
  });

  it("lets root list all processes and honors an explicit uid filter", () => {
    const list = vi.fn(() => []);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      installationId: TEST_INSTALLATION_ID,
      identity: { role: "user", process: { ...IDENTITY, uid: 0, username: "root" }, capabilities: ["proc.list"] },
      procs: { get: vi.fn(() => null), list },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    handleProcList({}, ctx);
    expect(list).toHaveBeenCalledWith(undefined);

    list.mockClear();
    handleProcList({ uid: 1000 }, ctx);
    expect(list).toHaveBeenCalledWith(1000);
  });
});
