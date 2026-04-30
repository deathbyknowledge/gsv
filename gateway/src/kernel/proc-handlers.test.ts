import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ResponseFrame } from "../protocol/frames";
import type { ProcIpcSendResult } from "../syscalls/proc";
import type { KernelContext } from "./context";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { handleProcIpcCall } from "./proc-handlers";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("proc handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(callId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.attachRun).not.toHaveBeenCalled();
    expect(ctx.scheduleIpcCallTimeout).not.toHaveBeenCalled();
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
    expect(callId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.attachRun).not.toHaveBeenCalled();
    expect(ctx.scheduleIpcCallTimeout).not.toHaveBeenCalled();
  });
});

function makeIpcCallContext() {
  const ipcCalls = {
    create: vi.fn(),
    remove: vi.fn(),
    attachRun: vi.fn(),
  };
  const ctx = {
    processId: "source-process",
    identity: { process: IDENTITY },
    procs: {
      get: vi.fn((pid: string) => {
        if (pid === "source-process") return { uid: IDENTITY.uid, workspaceId: null };
        if (pid === "target-process") return { uid: IDENTITY.uid, workspaceId: null };
        return undefined;
      }),
    },
    workspaces: {
      touch: vi.fn(),
    },
    ipcCalls,
    scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
  } as unknown as KernelContext;

  return { ctx, ipcCalls };
}
