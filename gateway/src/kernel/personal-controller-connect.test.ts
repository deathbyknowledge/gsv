import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestFrame } from "../protocol/frames";

const { handleConnectMock, ensurePersonalControllerMock, getConversationByIdMock } = vi.hoisted(() => ({
  handleConnectMock: vi.fn(),
  ensurePersonalControllerMock: vi.fn(),
  getConversationByIdMock: vi.fn(),
}));

vi.mock("../shared/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../shared/utils")>(),
  getConversationById: getConversationByIdMock,
}));

vi.mock("./connect", () => ({
  ensureKernelBootstrapped: vi.fn(),
  handleConnect: handleConnectMock,
  setupRequiredDetails: vi.fn(() => ({ setupMode: true, next: "sys.setup" })),
  SETUP_REQUIRED_ERROR_CODE: 425,
}));

vi.mock("./personal-controller", () => ({
  ensurePersonalController: ensurePersonalControllerMock,
}));

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
      protocol: 2,
      client: {
        id: "web",
        role: "user",
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
      identity: {
        role: "user",
        process: PROCESS_IDENTITY,
        capabilities: [],
      },
      result: {
        protocol: 2,
        server: {
          version: "test",
          release: "dev",
          connectionId: "connection-1",
        },
        identity: {
          role: "user",
          process: PROCESS_IDENTITY,
          capabilities: [],
        },
        syscalls: [],
        signals: [],
      },
    });
  });

  it("ensures a human controller before activating and accepting the connection", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      conversations: {
        ensureHome: vi.fn(() => ({
          id: "conv:home",
          ownerUid: 1000,
          kind: "home",
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
      expect.objectContaining({ protocol: 2 }),
    );
  });

  it("does not activate a human connection when controller recovery fails", async () => {
    const kernel = Object.create(Kernel.prototype) as any;
    const ctx = {
      auth: { isPersonalAgentUid: vi.fn(() => false) },
      conversations: { ensureHome: vi.fn() },
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
