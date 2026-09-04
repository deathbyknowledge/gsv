import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestFrame } from "../protocol/frames";

import * as utils from "../shared/utils";
import * as connect from "./connect";
import * as personalController from "./personal-controller";
const handleConnectMock = vi.spyOn(connect, "handleConnect");
const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");

import { Kernel, kernelRuntimes } from "./do";

/** A Kernel prototype with its runtime modules attached and no Durable Object state. */
// SAFETY: tests assign the exact collaborators each scenario asserts on.
const bareKernel = (): any => {
  const kernel = Object.create(Kernel.prototype);
  Object.assign(kernel, kernelRuntimes(kernel));
  return kernel;
};

const PROCESS_IDENTITY = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

function connectFrame(): RequestFrame<"sys.connect"> {
  return {
    type: "req",
    id: "connect-1",
    call: "sys.connect",
    args: {
      protocol: 3,
      peer: {
        id: "web",
        platform: "web",
        version: "test",
      },
      auth: {
        username: "sam",
        password: "password",
      },
    },
  };
}

describe("Kernel personal controller connect lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePersonalControllerMock.mockResolvedValue("proc:personal");
    getConversationByIdMock.mockReturnValue({ initialize: vi.fn(async () => undefined) });
    handleConnectMock.mockResolvedValue({
      ok: true,
      peer: {
        id: "web",
        sessionId: "connection-1",
        principal: { kind: "human", account: PROCESS_IDENTITY },
        grant: { calls: [], signals: [], implements: [] },
      },
      result: {
        protocol: 3,
        server: {
          version: "test",
          release: "dev",
          connectionId: "connection-1",
        },
        peer: {
          id: "web",
          sessionId: "connection-1",
          principal: { kind: "human", account: PROCESS_IDENTITY },
          grant: { calls: [], signals: [], implements: [] },
        },
      },
    });
  });

  it("ensures a human controller before activating and accepting the connection", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      conversations: {
        ensureShip: vi.fn(() => ({
          id: "conv:ship",
          ownerUid: 1000,
          kind: "ship",
        })),
      },
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastDeviceStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();

    await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());

    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(PROCESS_IDENTITY.uid, ctx);
    expect(ensurePersonalControllerMock.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.connectionRuntime.activateConnection.mock.invocationCallOrder[0]);
    expect(kernel.connectionRuntime.activateConnection).toHaveBeenCalledOnce();
    expect(kernel.transport.sendOk).toHaveBeenCalledWith(
      connection,
      "connect-1",
      expect.objectContaining({ protocol: 3 }),
    );
  });

  it("does not activate a human connection when controller recovery fails", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      conversations: { ensureShip: vi.fn() },
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastDeviceStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();
    ensurePersonalControllerMock.mockRejectedValueOnce(new Error("controller unavailable"));

    await expect(kernel.connectionRuntime.handleSysConnect(connection, connectFrame()))
      .rejects.toThrow("controller unavailable");

    expect(kernel.connectionRuntime.activateConnection).not.toHaveBeenCalled();
    expect(kernel.transport.sendOk).not.toHaveBeenCalled();
  });

  it("records a first machine registration as Ship work before accepting it", async () => {
    const machine = {
      device_id: "workstation",
      owner_uid: 1000,
      label: "Workstation",
      description: "",
      implements: ["shell.exec"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1_700_000_000_000,
      last_seen_at: 1_700_000_000_000,
      connected_at: 1_700_000_000_000,
      disconnected_at: null,
    };
    const peer = {
      id: machine.device_id,
      sessionId: "connection-1",
      principal: { kind: "machine" as const, account: PROCESS_IDENTITY },
      grant: { calls: [], signals: ["target.status"], implements: ["shell.exec"] },
    };
    handleConnectMock.mockResolvedValueOnce({
      ok: true,
      peer,
      newMachine: machine,
      result: {
        protocol: 3,
        server: {
          version: "test",
          release: "dev",
          connectionId: "connection-1",
        },
        peer,
      },
    });

    const create = vi.fn(() => ({ created: true }));
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      responsibilitySources: { isEnabled: vi.fn(() => true) },
      responsibilities: { create },
      reconcileResponsibilityWake: vi.fn(async () => undefined),
      defer: vi.fn((promise: Promise<unknown>) => {
        void promise;
      }),
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastDeviceStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();

    await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      dedupeKey: expect.stringMatching(/^machine\.added:machine-added:[0-9a-f]{64}$/),
      source: expect.objectContaining({ eventType: "machine.added" }),
    }));
    expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
    expect(kernel.connectionRuntime.activateConnection).toHaveBeenCalledOnce();
    expect(kernel.transport.sendOk).toHaveBeenCalledOnce();
  });
});
