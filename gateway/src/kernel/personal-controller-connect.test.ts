import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestFrame } from "../protocol/frames";

import * as utils from "../shared/utils";
import * as connect from "./connect";
import * as personalController from "./personal-controller";
const handleConnectMock = vi.spyOn(connect, "handleConnect");
const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");

import { Kernel } from "./do";

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
    const kernel = Object.create(Kernel.prototype) as any;
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
    kernel.activateConnection = vi.fn();
    kernel.broadcastDeviceStatus = vi.fn();
    kernel.reconcileOwnedIdentities = vi.fn();
    kernel.sendOk = vi.fn();
    kernel.sendError = vi.fn();

    await kernel.handleSysConnect(connection, connectFrame());

    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(PROCESS_IDENTITY.uid, ctx);
    expect(ensurePersonalControllerMock.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.activateConnection.mock.invocationCallOrder[0]);
    expect(kernel.activateConnection).toHaveBeenCalledOnce();
    expect(kernel.sendOk).toHaveBeenCalledWith(
      connection,
      "connect-1",
      expect.objectContaining({ protocol: 3 }),
    );
  });

  it("does not activate a human connection when controller recovery fails", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = Object.create(Kernel.prototype) as any;
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      conversations: { ensureShip: vi.fn() },
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    kernel.buildContext = vi.fn(() => ctx);
    kernel.activateConnection = vi.fn();
    kernel.broadcastDeviceStatus = vi.fn();
    kernel.reconcileOwnedIdentities = vi.fn();
    kernel.sendOk = vi.fn();
    kernel.sendError = vi.fn();
    ensurePersonalControllerMock.mockRejectedValueOnce(new Error("controller unavailable"));

    await expect(kernel.handleSysConnect(connection, connectFrame()))
      .rejects.toThrow("controller unavailable");

    expect(kernel.activateConnection).not.toHaveBeenCalled();
    expect(kernel.sendOk).not.toHaveBeenCalled();
  });
});
