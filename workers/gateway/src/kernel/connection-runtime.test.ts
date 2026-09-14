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
    auth: { credentialEpoch: vi.fn(() => 0), isAccountDisabled: vi.fn(() => false) },
    targets: { setOnline, listOnline: () => [] },
  };
  // SAFETY: rehydration touches only the sockets, connection index, and target flags stubbed here.
  return { runtime: new ConnectionRuntime(host as never), host, setOnline };
}

function targetRuntimeWith(sockets: ReturnType<typeof fakeSocket>[]) {
  const fixture = runtimeWith(sockets);
  const waits: Promise<unknown>[] = [];
  Object.assign(fixture.host.ctx, { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } });
  const canAccess = vi.fn((_targetId: string, uid: number) => uid === 1000);
  Object.assign(fixture.host.targets, { get: () => ({ target_id: "macbook", owner_uid: 1000 }), canAccess });
  Object.assign(fixture.host, { signalWatches: { matchTarget: () => [] } });
  return { ...fixture, waits, canAccess };
}

describe("ConnectionRuntime target-status broadcast", () => {
  it("skips a revoked socket still indexed before its close callback", async () => {
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" } };
    const old = fakeSocket({ step: "connected", protocol: 4, peer, credentialEpoch: 0 });
    const current = fakeSocket({ step: "connected", protocol: 4, peer });
    old.send.mockImplementation(() => { throw new Error("Socket already closed"); });
    const { runtime, host, waits } = targetRuntimeWith([old, current]);
    runtime.rehydrateConnections();
    runtime.activateConnection(Array.from(host.connections.values())[1], { step: "connected", protocol: 4, peer, credentialEpoch: 1 });
    host.auth.credentialEpoch.mockReturnValue(1);
    runtime.invalidateAccountConnections(1000);
    expect(old.close).toHaveBeenCalledWith(1008, "Credentials changed; sign in again");
    expect(host.connections.size).toBe(2);

    expect(() => runtime.broadcastTargetStatus("macbook", "connected")).not.toThrow();
    await Promise.all(waits);
    expect(old.send).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"signal":"target.status"'));
    expect(current.close).not.toHaveBeenCalled();
  });

  it("isolates a failed recipient while preserving visibility, signal grants and exact machine routing", async () => {
    const socket = (kind: "human" | "machine" | "service", uid = 1000, id = "macbook", signals = ["target.status"], step: KernelConnectionState["step"] = "connected") => fakeSocket({
      step, protocol: 4,
      peer: { ...MACHINE_PEER, id, principal: { kind, account: { ...MACHINE_PEER.principal.account, uid } }, grant: { calls: [], signals, implements: [] } },
    });
    const failed = socket("human");
    const healthy = socket("human");
    const machine = socket("machine");
    const rejected = [
      socket("human", 1001), socket("human", 1000, "macbook", []),
      socket("machine", 1000, "different-target"), socket("service"),
      socket("human", 1000, "macbook", ["target.status"], "pending"),
      socket("human", 1000, "macbook", ["target.status"], "superseded"),
    ];
    failed.send.mockImplementation(() => { throw new Error("Recipient disconnected during delivery"); });
    const { runtime, waits, canAccess } = targetRuntimeWith([failed, healthy, machine, ...rejected]);
    runtime.rehydrateConnections();

    expect(() => runtime.broadcastTargetStatus("macbook", "disconnected")).not.toThrow();
    await Promise.all(waits);
    expect(failed.close).toHaveBeenCalledWith(1011, "Target feed interrupted");
    for (const recipient of [healthy, machine]) expect(recipient.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"event":"disconnected"'));
    for (const recipient of rejected) expect(recipient.send).not.toHaveBeenCalled();
    expect(canAccess.mock.calls.map(([, uid]) => uid)).toEqual([1000, 1000, 1001]);
  });
});

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

  it("refuses a session restored after its account credentials were reset", () => {
    const old = fakeSocket({ step: "connected", protocol: 4, peer: MACHINE_PEER });
    const current = fakeSocket({ step: "connected", protocol: 4, peer: MACHINE_PEER, credentialEpoch: 1 });
    const { runtime, host, setOnline } = runtimeWith([old, current]);
    host.auth.credentialEpoch.mockReturnValue(1);
    runtime.rehydrateConnections();
    expect(old.close).toHaveBeenCalledWith(1008, "Credentials changed; sign in again");
    expect(old.serializeAttachment).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ step: "superseded" }) }));
    expect(current.close).not.toHaveBeenCalled();
    expect(setOnline).toHaveBeenCalledTimes(1);
  });

  it("keeps pending sockets that have not negotiated yet", () => {
    const pending = fakeSocket({ step: "pending" });
    const { runtime, host } = runtimeWith([pending]);

    runtime.rehydrateConnections();

    expect(pending.close).not.toHaveBeenCalled();
    expect(host.connections.size).toBe(1);
  });
});

describe("ConnectionRuntime contact notifications", () => {
  it.each([
    ["contact.changed", "contact.list"],
    ["r12y.changed", "r12y.list"],
    ["r12y.source.changed", "r12y.source.list"],
    ["sched.changed", "sched.list"],
    ["contact.invite.changed", "contact.invite.list"],
    ["contact.request.changed", "contact.request.list"],
  ])("gates %s on its owner, human session, signal and read capability", (signal, call) => {
    const socket = (uid = 1000, calls = [call], signals = [signal], kind: "human" | "machine" = "human", step: KernelConnectionState["step"] = "connected") => fakeSocket({
      step, protocol: 4,
      peer: { ...MACHINE_PEER, principal: { kind, account: { ...MACHINE_PEER.principal.account, uid } }, grant: { calls, signals, implements: [] } },
    });
    const owner = socket();
    const wildcard = socket(1000, [`${call.split(".")[0]}.*`]);
    const rejected = [socket(1001), socket(0, ["*"]), socket(1000, []), socket(1000, ["*"], []), socket(1000, ["*"], [signal], "machine"), socket(1000, ["*"], [signal], "human", "superseded")];
    const { runtime } = runtimeWith([owner, wildcard, ...rejected]);
    runtime.rehydrateConnections();
    runtime.broadcastToUserUid(1000, signal);
    for (const recipient of [owner, wildcard]) expect(recipient.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sig", signal }));
    for (const recipient of rejected) expect(recipient.send).not.toHaveBeenCalled();
  });

  it("does not fail a saved mutation or other readers when one socket fails", () => {
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" }, grant: { calls: ["*"], signals: ["contact.changed"], implements: [] } };
    const failed = fakeSocket({ step: "connected", protocol: 4, peer });
    const healthy = fakeSocket({ step: "connected", protocol: 4, peer });
    failed.send.mockImplementation(() => { throw new Error("closed"); });
    const { runtime } = runtimeWith([failed, healthy]);
    runtime.rehydrateConnections();
    runtime.broadcastToUserUid(1000, "contact.changed");
    expect(failed.close).toHaveBeenCalledWith(1011, "Contact feed interrupted");
    expect(healthy.send).toHaveBeenCalledOnce();
  });
});

describe("ConnectionRuntime credential revocation notifications", () => {
  it.each(["all", "except"] as const)("skips a superseded socket awaiting close cleanup in the %s UID broadcast", (mode) => {
    const signal = mode === "all" ? "adapter.status" : "message.committed";
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" }, grant: { calls: ["*"], signals: [signal], implements: [] } };
    const old = fakeSocket({ step: "connected", protocol: 4, peer, credentialEpoch: 0 });
    const current = fakeSocket({ step: "connected", protocol: 4, peer });
    old.send.mockImplementation(() => { throw new Error("Socket already closed"); });
    const { runtime, host } = runtimeWith([old, current]);
    runtime.rehydrateConnections();
    runtime.activateConnection(Array.from(host.connections.values())[1], { step: "connected", protocol: 4, peer, credentialEpoch: 1 });
    host.auth.credentialEpoch.mockReturnValue(1);
    runtime.invalidateAccountConnections(1000);
    expect(old.close).toHaveBeenCalledWith(1008, "Credentials changed; sign in again");
    expect(host.connections.size).toBe(2);
    const broadcast = () => mode === "all"
      ? runtime.broadcastToUserUid(1000, signal)
      : runtime.broadcastToUserUidExcept(1000, "other-connection", signal);
    expect(broadcast).not.toThrow();
    expect(old.send).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sig", signal }));
  });

  it.each(["all", "except"] as const)("isolates a failed active recipient in the %s UID broadcast", (mode) => {
    const signal = mode === "all" ? "adapter.status" : "message.committed";
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" }, grant: { calls: ["*"], signals: [signal], implements: [] } };
    const failed = fakeSocket({ step: "connected", protocol: 4, peer });
    const healthy = fakeSocket({ step: "connected", protocol: 4, peer });
    failed.send.mockImplementation(() => { throw new Error("Socket already closed"); });
    const { runtime } = runtimeWith([failed, healthy]);
    runtime.rehydrateConnections();
    const broadcast = () => mode === "all"
      ? runtime.broadcastToUserUid(1000, signal)
      : runtime.broadcastToUserUidExcept(1000, "other-connection", signal);
    expect(broadcast).not.toThrow();
    expect(failed.close).toHaveBeenCalledWith(1011, "User feed interrupted");
    expect(healthy.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sig", signal }));
  });

  it("skips a superseded socket when sending a targeted Process notification", () => {
    const signal = "message.committed";
    const peer: ConnectedPeer = { ...MACHINE_PEER, principal: { ...MACHINE_PEER.principal, kind: "human" }, grant: { calls: ["*"], signals: [signal], implements: [] } };
    const old = fakeSocket({ step: "connected", protocol: 4, peer });
    const current = fakeSocket({ step: "connected", protocol: 4, peer });
    const { runtime, host } = runtimeWith([old, current]);
    runtime.rehydrateConnections();
    const [oldId, currentId] = Array.from(host.connections.keys());
    runtime.activateConnection(host.connections.get(currentId), { step: "connected", protocol: 4, peer, credentialEpoch: 1 });
    host.auth.credentialEpoch.mockReturnValue(1);
    runtime.invalidateAccountConnections(1000);
    runtime.sendSignalToConnection(oldId, signal);
    runtime.sendSignalToConnection(currentId, signal);
    expect(old.send).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sig", signal }));
  });
});

describe("ConnectionRuntime process notifications", () => {
  it.each(["proc.changed", "process.exit"])("delivers %s only to the owner and survives a failed connection", (signal) => {
    const socket = (uid = 1000, signals = [signal], kind: "human" | "machine" = "human", step: KernelConnectionState["step"] = "connected") => fakeSocket({
      step, protocol: 4,
      peer: { ...MACHINE_PEER, principal: { kind, account: { ...MACHINE_PEER.principal.account, uid } }, grant: { calls: ["*"], signals, implements: [] } },
    });
    const failed = socket();
    const healthy = socket();
    const rejected = [socket(1001), socket(1000, []), socket(1000, [signal], "machine"), socket(1000, [signal], "human", "superseded")];
    failed.send.mockImplementation(() => { throw new Error("closed"); });
    const { runtime } = runtimeWith([failed, healthy, ...rejected]);
    runtime.rehydrateConnections();
    expect(() => runtime.broadcastToUserUid(1000, signal, { pid: "p" })).not.toThrow();
    expect(failed.close).toHaveBeenCalledWith(1011, "Process feed interrupted");
    expect(healthy.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sig", signal, payload: { pid: "p" } }));
    for (const recipient of rejected) expect(recipient.send).not.toHaveBeenCalled();
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
