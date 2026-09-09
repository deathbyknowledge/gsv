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

describe("ConnectionRuntime.broadcastLedgerChanges", () => {
  it("requires a connected human reader, the signal grant, and the owning uid or root", () => {
    const socket = (uid: number, calls = ["sys.ledger.list"], signals = ["ledger.changed"], kind: "human" | "machine" = "human", step: KernelConnectionState["step"] = "connected") => fakeSocket({
      step, protocol: 4,
      peer: { ...MACHINE_PEER, principal: { kind, account: { ...MACHINE_PEER.principal.account, uid } }, grant: { calls, signals, implements: [] } },
    });
    const owner = socket(1000);
    const root = socket(0, ["*"]);
    const wildcard = socket(1000, ["sys.ledger.*"]);
    const rejected = [socket(1001), socket(1000, []), socket(1000, ["sys.ledger.list"], []), socket(1000, ["*"], ["ledger.changed"], "machine"), socket(1000, ["*"], ["ledger.changed"], "human", "superseded")];
    const { runtime } = runtimeWith([owner, root, wildcard, ...rejected]);
    runtime.rehydrateConnections();
    runtime.broadcastLedgerChanges(1000, { lines: [] });
    for (const recipient of [owner, root, wildcard]) expect(recipient.send).toHaveBeenCalledOnce();
    for (const recipient of rejected) expect(recipient.send).not.toHaveBeenCalled();
    runtime.broadcastLedgerChanges(0, { lines: [] });
    expect(root.send).toHaveBeenCalledTimes(2);
    expect(owner.send).toHaveBeenCalledOnce();
  });

  it("closes a failed reader for snapshot recovery and continues delivering to other readers", () => {
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" }, grant: { calls: ["*"], signals: ["ledger.changed"], implements: [] } };
    const failed = fakeSocket({ step: "connected", protocol: 4, peer });
    const healthy = fakeSocket({ step: "connected", protocol: 4, peer });
    failed.send.mockImplementation(() => { throw new Error("closed"); });
    const { runtime } = runtimeWith([failed, healthy]);
    runtime.rehydrateConnections();
    runtime.broadcastLedgerChanges(1000, { lines: [] });
    expect(failed.close).toHaveBeenCalledWith(1011, "Ledger feed interrupted");
    expect(healthy.send).toHaveBeenCalledOnce();
  });
});
