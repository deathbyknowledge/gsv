import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { Frame, RequestFrame, ResponseFrame } from "../protocol/frames";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { ProcessRegistry } from "./processes";

const { ensurePersonalAgentMock } = vi.hoisted(() => ({
  ensurePersonalAgentMock: vi.fn(),
}));

vi.mock("./agents", () => ({
  ensurePersonalAgent: ensurePersonalAgentMock,
}));

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import {
  ensurePersonalController,
  invalidatePersonalControllerReadiness,
} from "./personal-controller";

const HUMAN = {
  username: "sam",
  uid: 1000,
  gid: 1000,
  gecos: "Sam",
  home: "/home/sam",
  shell: "/bin/init",
};

const AGENT_IDENTITY: ProcessIdentity = {
  uid: 2000,
  gid: 2000,
  gids: [2000],
  username: "sam-agent",
  home: "/home/sam-agent",
  cwd: "/home/sam-agent",
};

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

function successResponse(frame: Frame): ResponseFrame {
  return {
    type: "res",
    id: frame.type === "req" ? frame.id : "signal",
    ok: true,
    data: { ok: true },
  } as ResponseFrame;
}

function createContext(registry: ProcessRegistry): KernelContext {
  return {
    auth: {
      getPasswdByUid: vi.fn((uid: number) => uid === HUMAN.uid ? HUMAN : null),
      isPersonalAgentUid: vi.fn(() => false),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    },
    procs: registry,
  } as unknown as KernelContext;
}

describe("ensurePersonalController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePersonalAgentMock.mockResolvedValue({
      identity: AGENT_IDENTITY,
      created: false,
    });
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => (
      successResponse(frame as Frame)
    ));
  });

  it("coalesces creation and uses the ready registry fast path", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      let releaseInitialization: ((response: ResponseFrame) => void) | undefined;
      sendFrameToProcessMock.mockImplementationOnce((_pid, frame) => (
        new Promise((resolve) => {
          releaseInitialization = resolve;
        }).then((response) => response ?? successResponse(frame as Frame))
      ));

      const first = ensurePersonalController(HUMAN.uid, ctx);
      const second = ensurePersonalController(HUMAN.uid, ctx);
      await vi.waitFor(() => expect(sendFrameToProcessMock).toHaveBeenCalledOnce());
      const initialization = sendFrameToProcessMock.mock.calls[0][1] as RequestFrame;
      releaseInitialization?.(successResponse(initialization));

      const [firstPid, secondPid] = await Promise.all([first, second]);
      expect(firstPid).toBe(secondPid);
      expect(firstPid).toMatch(/^proc:[0-9a-f-]{36}$/);
      expect(firstPid).not.toBe(`proc:personal-controller:${HUMAN.uid}`);
      expect(registry.getPersonalController(HUMAN.uid)).toMatchObject({
        processId: firstPid,
        ownerUid: HUMAN.uid,
        uid: AGENT_IDENTITY.uid,
        interactive: true,
        isPersonalController: true,
        parentPid: null,
      });
      expect(ensurePersonalAgentMock).toHaveBeenCalledOnce();
      expect(sendFrameToProcessMock).toHaveBeenCalledOnce();

      await expect(ensurePersonalController(HUMAN.uid, ctx)).resolves.toBe(firstPid);
      expect(ensurePersonalAgentMock).toHaveBeenCalledOnce();
      expect(sendFrameToProcessMock).toHaveBeenCalledOnce();
    });
  });

  it("revalidates and replaces a cached controller after an uncertain kill", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      const previousPid = await ensurePersonalController(HUMAN.uid, ctx);
      invalidatePersonalControllerReadiness(HUMAN.uid, previousPid, registry);
      sendFrameToProcessMock.mockClear();
      sendFrameToProcessMock
        .mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process no longer exists" },
        }))
        .mockImplementationOnce(async (_pid, frame) => successResponse(frame as Frame));

      const replacementPid = await ensurePersonalController(HUMAN.uid, ctx);

      expect(replacementPid).not.toBe(previousPid);
      expect(registry.get(previousPid)).toBeNull();
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe(replacementPid);
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        1,
        previousPid,
        expect.objectContaining({ call: "proc.setidentity" }),
      );
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        2,
        previousPid,
        expect.objectContaining({ call: "proc.kill" }),
      );
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        3,
        replacementPid,
        expect.objectContaining({ call: "proc.setidentity" }),
      );
    });
  });

  it("recovers an existing cold slot without changing its pid", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      registry.spawn("proc:cold", {
        uid: 1999,
        gid: 1999,
        gids: [1999],
        username: "old-agent",
        home: "/home/old-agent",
        cwd: "/home/old-agent/work",
      }, {
        ownerUid: HUMAN.uid,
        interactive: true,
        isPersonalController: true,
      });

      await expect(ensurePersonalController(HUMAN.uid, ctx)).resolves.toBe("proc:cold");

      expect(registry.getPersonalController(HUMAN.uid)).toMatchObject({
        processId: "proc:cold",
        uid: AGENT_IDENTITY.uid,
        username: AGENT_IDENTITY.username,
        cwd: "/home/sam-agent/work",
      });
      expect(sendFrameToProcessMock).toHaveBeenCalledWith(
        "proc:cold",
        expect.objectContaining({
          call: "proc.setidentity",
          args: expect.objectContaining({
            pid: "proc:cold",
            identity: expect.objectContaining({
              uid: AGENT_IDENTITY.uid,
              cwd: "/home/sam-agent/work",
            }),
          }),
        }),
      );
    });
  });

  it("replaces an explicitly dead cold controller with a fresh pid", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      registry.spawn("proc:dead", AGENT_IDENTITY, {
        ownerUid: HUMAN.uid,
        interactive: true,
        isPersonalController: true,
      });
      sendFrameToProcessMock
        .mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_pid, frame) => successResponse(frame as Frame));

      const pid = await ensurePersonalController(HUMAN.uid, ctx);

      expect(pid).not.toBe("proc:dead");
      expect(pid).toMatch(/^proc:[0-9a-f-]{36}$/);
      expect(registry.get("proc:dead")).toBeNull();
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe(pid);
      expect(sendFrameToProcessMock).toHaveBeenCalledTimes(3);
    });
  });

  it("finishes dead-controller cleanup before replacing its registry slot", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      registry.spawn("proc:cleanup", AGENT_IDENTITY, {
        ownerUid: HUMAN.uid,
        interactive: true,
        isPersonalController: true,
      });
      sendFrameToProcessMock
        .mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 500, message: "terminal cleanup is pending", retryable: true },
        }))
        .mockImplementationOnce(async (_pid, frame) => ({
          type: "res",
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_pid, frame) => successResponse(frame as Frame))
        .mockImplementationOnce(async (_pid, frame) => successResponse(frame as Frame));

      await expect(ensurePersonalController(HUMAN.uid, ctx))
        .rejects.toThrow("terminal cleanup is pending");
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe("proc:cleanup");

      const replacementPid = await ensurePersonalController(HUMAN.uid, ctx);

      expect(replacementPid).not.toBe("proc:cleanup");
      expect(registry.get("proc:cleanup")).toBeNull();
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe(replacementPid);
      expect(sendFrameToProcessMock.mock.calls.map(([pid, frame]) => [
        pid,
        (frame as RequestFrame).call,
      ])).toEqual([
        ["proc:cleanup", "proc.setidentity"],
        ["proc:cleanup", "proc.kill"],
        ["proc:cleanup", "proc.setidentity"],
        ["proc:cleanup", "proc.kill"],
        [replacementPid, "proc.setidentity"],
      ]);
    });
  });

  it("retains a cold slot when validation fails transiently", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      const previousIdentity = {
        uid: 1999,
        gid: 1999,
        gids: [1999],
        username: "old-agent",
        home: "/home/old-agent",
        cwd: "/home/old-agent",
      };
      registry.spawn("proc:retry", previousIdentity, {
        ownerUid: HUMAN.uid,
        interactive: true,
        isPersonalController: true,
      });
      sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
        type: "res",
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 503, message: "temporarily unavailable", retryable: true },
      }));

      await expect(ensurePersonalController(HUMAN.uid, ctx))
        .rejects.toThrow("temporarily unavailable");
      expect(registry.getPersonalController(HUMAN.uid)).toMatchObject({
        processId: "proc:retry",
        uid: previousIdentity.uid,
        username: previousIdentity.username,
      });

      await expect(ensurePersonalController(HUMAN.uid, ctx)).resolves.toBe("proc:retry");
      expect(registry.getPersonalController(HUMAN.uid)).toMatchObject({
        processId: "proc:retry",
        uid: AGENT_IDENTITY.uid,
        username: AGENT_IDENTITY.username,
      });
    });
  });

  it("vacates a fresh slot after successful initialization rollback", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
        type: "res",
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 500, message: "identity rejected" },
      }));

      await expect(ensurePersonalController(HUMAN.uid, ctx))
        .rejects.toThrow("Failed to initialize personal controller: identity rejected");

      expect(registry.getPersonalController(HUMAN.uid)).toBeNull();
      expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
      expect(sendFrameToProcessMock.mock.calls[1][1]).toMatchObject({
        call: "proc.kill",
        args: { archive: false },
      });
    });
  });
});
