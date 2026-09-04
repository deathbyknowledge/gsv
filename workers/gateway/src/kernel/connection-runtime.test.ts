import { describe, expect, it, vi } from "vitest";
import type { ConnectedPeer } from "@humansandmachines/gsv/protocol";
import { ConnectionRuntime } from "./connection-runtime";
import type { KernelConnectionState } from "./connection";

const MACHINE_PEER: ConnectedPeer = {
  id: "macbook",
  sessionId: "session:1",
  principal: {
    kind: "machine",
    account: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam", cwd: "/home/sam" },
  },
  grant: { calls: [], signals: ["target.status", "peer.pong"], implements: ["fs.*", "shell.exec"] },
};

function fakeSocket(state: KernelConnectionState) {
  return {
    close: vi.fn(),
    send: vi.fn(),
    deserializeAttachment: () => ({ version: 1, id: crypto.randomUUID(), uri: "https://gsv.test/ws", state }),
    serializeAttachment: vi.fn(),
  };
}

function runtimeWith(sockets: ReturnType<typeof fakeSocket>[]) {
  const setOnline = vi.fn();
  const host = {
    ctx: { getWebSockets: () => sockets },
    connections: new Map(),
    targets: { setOnline, listOnline: () => [] },
  };
  // SAFETY: rehydration touches only the sockets, connection index, and target flags stubbed here.
  return { runtime: new ConnectionRuntime(host as never), host, setOnline };
}

describe("ConnectionRuntime.rehydrateConnections", () => {
  it("restores sockets that negotiated the current protocol", () => {
    const socket = fakeSocket({ step: "connected", protocol: 4, peer: MACHINE_PEER });
    const { runtime, host, setOnline } = runtimeWith([socket]);

    runtime.rehydrateConnections();

    expect(socket.close).not.toHaveBeenCalled();
    expect(host.connections.size).toBe(1);
    expect(setOnline).toHaveBeenCalledWith("macbook", true);
  });

  it("closes connected sockets that negotiated another protocol", () => {
    const legacy = fakeSocket({ step: "connected", peer: MACHINE_PEER });
    const older = fakeSocket({ step: "connected", protocol: 3, peer: MACHINE_PEER });
    const { runtime, host, setOnline } = runtimeWith([legacy, older]);

    runtime.rehydrateConnections();

    for (const socket of [legacy, older]) {
      expect(socket.close).toHaveBeenCalledWith(1008, expect.stringContaining("Protocol 4 required"));
    }
    expect(host.connections.size).toBe(0);
    expect(setOnline).not.toHaveBeenCalled();
  });

  it("keeps pending sockets that have not negotiated yet", () => {
    const pending = fakeSocket({ step: "pending" });
    const { runtime, host } = runtimeWith([pending]);

    runtime.rehydrateConnections();

    expect(pending.close).not.toHaveBeenCalled();
    expect(host.connections.size).toBe(1);
  });
});
