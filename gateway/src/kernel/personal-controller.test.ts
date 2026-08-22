import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { Frame, RequestFrame, ResponseFrame } from "../protocol/frames";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { ProcessRegistry } from "./processes";

import * as agents from "./agents";
import * as utils from "../shared/utils";
const ensurePersonalAgentMock = vi.spyOn(agents, "ensurePersonalAgent");
const sendFrameToProcessMock = vi.spyOn(utils, "sendFrameToProcess");

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
const TEST_INSTALLATION_ID = "installation-personal-controller";


function successResponse(frame: Frame): ResponseFrame {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    type: "res",
    id: frame.type === "req" ? frame.id : "signal",
    ok: true,
    data: { ok: true },
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as ResponseFrame;
}

function createContext(registry: ProcessRegistry): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    installationId: TEST_INSTALLATION_ID,
    auth: {
      getPasswdByUid: vi.fn((uid: number) => uid === HUMAN.uid ? HUMAN : null),
      isPersonalAgentUid: vi.fn(() => false),
      resolveGids: vi.fn((_username: string, gid: number) => [gid]),
    },
    procs: registry,
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("ensurePersonalController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePersonalAgentMock.mockResolvedValue({
      identity: AGENT_IDENTITY,
      created: false,
    });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => (
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      successResponse(frame as Frame)
    ));
  });

  it("coalesces creation and uses the ready registry fast path", async () => {
    await runWithRealKernelSql(async (sql) => {
      const registry = new ProcessRegistry(sql);
      const ctx = createContext(registry);
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      let releaseInitialization: ((response: ResponseFrame) => void) | undefined;
      sendFrameToProcessMock.mockImplementationOnce((_installationId, _pid, frame) => (
        new Promise((resolve) => {
          releaseInitialization = resolve;
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        }).then((response) => {
          // SAFETY: the test response frame is created from the matching request fixture.
          return response ?? successResponse(frame as Frame);
        })
      ));

      const first = ensurePersonalController(HUMAN.uid, ctx);
      const second = ensurePersonalController(HUMAN.uid, ctx);
      await vi.waitFor(() => expect(sendFrameToProcessMock).toHaveBeenCalledOnce());
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const initialization = sendFrameToProcessMock.mock.calls[0][2] as RequestFrame;
      expect(sendFrameToProcessMock.mock.calls[0][0]).toBe(TEST_INSTALLATION_ID);
      expect(initialization.args).not.toHaveProperty("pid");
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
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process no longer exists" },
        }))
        .mockImplementationOnce(async (_installationId, _pid, frame) => (
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          successResponse(frame as Frame)
        ));

      const replacementPid = await ensurePersonalController(HUMAN.uid, ctx);

      expect(replacementPid).not.toBe(previousPid);
      expect(registry.get(previousPid)).toBeNull();
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe(replacementPid);
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        1,
        TEST_INSTALLATION_ID,
        previousPid,
        expect.objectContaining({ call: "proc.setidentity" }),
      );
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        2,
        TEST_INSTALLATION_ID,
        previousPid,
        expect.objectContaining({ call: "proc.kill" }),
      );
      expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
        3,
        TEST_INSTALLATION_ID,
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
        TEST_INSTALLATION_ID,
        "proc:cold",
        expect.objectContaining({
          call: "proc.setidentity",
          args: expect.objectContaining({
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
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_installationId, _pid, frame) => (
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          successResponse(frame as Frame)
        ));

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
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 500, message: "terminal cleanup is pending", retryable: true },
        }))
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          id: (frame as RequestFrame).id,
          ok: false,
          error: { code: 410, message: "Process has been killed" },
        }))
        .mockImplementationOnce(async (_installationId, _pid, frame) => (
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          successResponse(frame as Frame)
        ))
        .mockImplementationOnce(async (_installationId, _pid, frame) => (
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          successResponse(frame as Frame)
        ));

      await expect(ensurePersonalController(HUMAN.uid, ctx))
        .rejects.toThrow("terminal cleanup is pending");
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe("proc:cleanup");

      const replacementPid = await ensurePersonalController(HUMAN.uid, ctx);

      expect(replacementPid).not.toBe("proc:cleanup");
      expect(registry.get("proc:cleanup")).toBeNull();
      expect(registry.getPersonalController(HUMAN.uid)?.processId).toBe(replacementPid);
      expect(sendFrameToProcessMock.mock.calls.map(([installationId, pid, frame]) => [
        installationId,
        pid,
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        (frame as RequestFrame).call,
      ])).toEqual([
        [TEST_INSTALLATION_ID, "proc:cleanup", "proc.setidentity"],
        [TEST_INSTALLATION_ID, "proc:cleanup", "proc.kill"],
        [TEST_INSTALLATION_ID, "proc:cleanup", "proc.setidentity"],
        [TEST_INSTALLATION_ID, "proc:cleanup", "proc.kill"],
        [TEST_INSTALLATION_ID, replacementPid, "proc.setidentity"],
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
      sendFrameToProcessMock.mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      sendFrameToProcessMock.mockImplementationOnce(async (_installationId, _pid, frame) => ({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        id: (frame as RequestFrame).id,
        ok: false,
        error: { code: 500, message: "identity rejected" },
      }));

      await expect(ensurePersonalController(HUMAN.uid, ctx))
        .rejects.toThrow("Failed to initialize personal controller: identity rejected");

      expect(registry.getPersonalController(HUMAN.uid)).toBeNull();
      expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
      expect(sendFrameToProcessMock.mock.calls[1][2]).toMatchObject({
        call: "proc.kill",
        args: { archive: false },
      });
    });
  });
});
