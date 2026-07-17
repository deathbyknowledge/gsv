import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { ConversationRecord } from "./conversations";

const { sendFrameToProcessMock } = vi.hoisted(() => ({
  sendFrameToProcessMock: vi.fn(),
}));

vi.mock("../shared/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../shared/utils")>();
  return {
    ...original,
    sendFrameToProcess: sendFrameToProcessMock,
  };
});

import { resolveConversationExecutor } from "./agents";

const identity: ProcessIdentity = {
  uid: 1001,
  gid: 1001,
  gids: [1001, 100],
  username: "mira",
  home: "/home/mira",
  cwd: "/home/mira",
};

const conversation: ConversationRecord = {
  conversationId: "default:1000:1001",
  ownerUid: 1000,
  agentUid: 1001,
  title: null,
  isDefault: true,
  activePid: null,
  archiveBase: "/home/mira/conversations/default%3A1000%3A1001",
  latestArchive: null,
  createdAt: 1,
  lastActiveAt: null,
};

function createCtx() {
  const processes = new Set<string>();
  let activePid: string | null = null;
  const spawned: string[] = [];
  const killed: string[] = [];
  const ctx = {
    procs: {
      get: vi.fn((pid: string) => processes.has(pid) ? { processId: pid } : null),
      spawn: vi.fn((pid: string) => {
        processes.add(pid);
        spawned.push(pid);
      }),
      kill: vi.fn((pid: string) => {
        killed.push(pid);
        return processes.delete(pid);
      }),
    },
    conversations: {
      setActivePid: vi.fn((_conversationId: string, pid: string | null) => {
        activePid = pid;
        return true;
      }),
      clearActivePid: vi.fn((pid: string) => {
        if (activePid === pid) activePid = null;
      }),
    },
  } as unknown as KernelContext;
  return { ctx, spawned, killed, activePid: () => activePid };
}

describe("resolveConversationExecutor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a half-initialized executor so a retry provisions a fresh one", async () => {
    const fixture = createCtx();
    sendFrameToProcessMock.mockImplementationOnce(async () => {
      throw new Error("injected proc.setidentity failure");
    });
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true },
    }));

    await expect(resolveConversationExecutor(
      fixture.ctx,
      { ...conversation },
      identity,
    )).rejects.toThrow("injected proc.setidentity failure");

    expect(fixture.spawned).toHaveLength(1);
    expect(fixture.killed).toEqual([fixture.spawned[0]]);
    expect(fixture.activePid()).toBeNull();

    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true },
    }));
    const retryPid = await resolveConversationExecutor(
      fixture.ctx,
      { ...conversation },
      identity,
    );

    expect(fixture.spawned).toHaveLength(2);
    expect(retryPid).toBe(fixture.spawned[1]);
    expect(retryPid).not.toBe(fixture.spawned[0]);
    expect(fixture.activePid()).toBe(retryPid);
  });

  it("rejects an unsuccessful initialization response and clears registry ownership", async () => {
    const fixture = createCtx();
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 500, message: "initialization rejected" },
    }));
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true },
    }));

    await expect(resolveConversationExecutor(
      fixture.ctx,
      { ...conversation },
      identity,
    )).rejects.toThrow("initialization rejected");
    expect(fixture.activePid()).toBeNull();
    expect(fixture.killed).toEqual([fixture.spawned[0]]);
  });
});
