import type { GSVClient } from "@humansandmachines/gsv/client";
import { decodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../app/testing/testHarness";
import { DesktopMachineSession, type MachineIdentity, type MachineSnapshot, type NativeMachine } from "./machineSetup";
import { nativeMachine } from "./bridge";

afterEach(() => vi.unstubAllGlobals());

const identity: MachineIdentity = { origin: "https://space.example", username: "human", targetId: "laptop", label: "Laptop" };
function harness(initial: Partial<MachineSnapshot> = {}) {
  let machine: MachineSnapshot = { suggestedName: "Laptop", configured: null, pending: null, running: false, connected: false, ...initial };
  let stored: string | null = null;
  const storage = { read: () => stored, write: (value: string) => { stored = value; } };
  const api = {
    create: vi.fn<GSVClient["sys"]["pair"]["create"]>(async (args) => ({ pairing: { ...args, username: "human", createdAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" } })),
    list: vi.fn<GSVClient["sys"]["pair"]["list"]>(),
    cancel: vi.fn<GSVClient["sys"]["pair"]["cancel"]>(),
  };
  const native = {
    status: vi.fn<NativeMachine["status"]>(async () => machine),
    command: vi.fn<NativeMachine["command"]>(async () => {
      machine = { ...machine, configured: identity, pending: null, running: true, connected: true };
      return machine;
    }),
  };
  const owner = () => new DesktopMachineSession(identity.origin, identity.username, native, api, storage);
  return { api, native, storage, owner, setMachine: (value: Partial<MachineSnapshot>) => { machine = { ...machine, ...value }; } };
}

describe("Desktop machine enrollment", () => {
  it.each([
    { failure: "Cannot read the machine configuration.", message: "Cannot read the machine configuration." },
    { failure: { unexpected: "private fixture data" }, message: "Could not check this computer. Retry." },
  ])("retains useful native status failures for retry: $message", async ({ failure, message }) => {
    const invoke = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({
      suggestedName: "Laptop", configured: null, pending: null, running: false, connected: false,
    });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const h = harness();
    const owner = new DesktopMachineSession(identity.origin, identity.username, nativeMachine("generation", "human"), h.api, h.storage);
    await owner.load();
    expect(owner.snapshot()).toMatchObject({ loading: false, machine: null, error: message });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("machine_status", { generation: "generation", username: "human" });
    await owner.load();
    expect(owner.snapshot()).toMatchObject({ loading: false, machine: { configured: null }, error: "" });
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "Machine setup was cancelled.", message: "Machine setup was cancelled." },
    { failure: { unexpected: "private fixture data" }, message: "Could not connect this computer. Retry." },
  ])("normalizes native command failures at the bridge: $message", async ({ failure, message }) => {
    const invoke = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(nativeMachine("generation", "human").command({ kind: "start" })).rejects.toThrow(message);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("machine_command", {
      generation: "generation", username: "human", command: { kind: "start" },
    });
  });

  it("creates one invitation with an available target name and delivers it to native pairing", async () => {
    const h = harness();
    const owner = h.owner();
    await owner.load();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(await owner.connect("Laptop", ["laptop"])).toBe(true);
    expect(h.api.create).toHaveBeenCalledOnce();
    expect(h.api.create.mock.calls[0][0].targetId).toBe("laptop-2");
    const command = h.native.command.mock.calls[0][0];
    expect(command.kind).toBe("pair");
    if (command.kind !== "pair") throw new Error("Missing invitation");
    expect(decodeDevicePairingCode(command.code)).toMatchObject({ username: "human", label: "Laptop", targetId: "laptop-2", gatewayUrl: "wss://space.example/ws" });
  });

  it("starts an enrolled computer without issuing another invitation", async () => {
    const h = harness({ configured: identity });
    await h.owner().load();
    expect(h.native.command).toHaveBeenCalledExactlyOnceWith({ kind: "start" });
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it("leaves a running connection alone", async () => {
    const h = harness({ configured: identity, running: true, connected: true });
    await h.owner().load();
    expect(h.native.command).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it.each([{ origin: "https://other.example" }, { username: "other" }])("preserves another binding: %j", async (other) => {
    const h = harness({ configured: { ...identity, ...other } });
    const owner = h.owner();
    await owner.load();
    expect(await owner.connect("New laptop", [])).toBe(false);
    expect(h.native.command).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it("resumes a native pending enrollment without creating another target", async () => {
    const h = harness({ pending: identity });
    const owner = h.owner();
    await owner.load();
    expect(await owner.connect("Laptop", [])).toBe(true);
    expect(h.native.command).toHaveBeenCalledExactlyOnceWith({ kind: "resume" });
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it("retains an uncertain invitation across reloads and reuses its identity", async () => {
    const h = harness();
    h.api.create.mockRejectedValueOnce(new Error("Connection lost"));
    const first = h.owner();
    expect(await first.connect("Laptop", [])).toBe(false);
    const request = h.api.create.mock.calls[0][0];
    first.dispose();
    expect(await h.owner().connect("Another name", [])).toBe(true);
    expect(h.api.create.mock.calls[1][0]).toEqual(request);
    expect(h.native.command).toHaveBeenCalledOnce();
  });

  it("does not continue into native setup after signing out during invitation creation", async () => {
    const h = harness();
    const creating = deferred<Awaited<ReturnType<GSVClient["sys"]["pair"]["create"]>>>();
    h.api.create.mockReturnValueOnce(creating.promise);
    const owner = h.owner();
    const pending = owner.connect("Laptop", []);
    await vi.waitFor(() => expect(h.api.create).toHaveBeenCalledOnce());
    owner.dispose();
    creating.resolve({ pairing: { ...h.api.create.mock.calls[0][0], username: "human", createdAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" } });
    expect(await pending).toBe(false);
    expect(h.native.command).not.toHaveBeenCalled();
  });

  it("retries service installation after a committed enrollment without pairing again", async () => {
    const h = harness();
    h.native.command.mockImplementationOnce(async () => {
      h.setMachine({ configured: identity });
      throw new Error("Service installation failed");
    });
    const owner = h.owner();
    expect(await owner.connect("Laptop", [])).toBe(false);
    expect(owner.snapshot().machine?.configured).toEqual(identity);
    expect(await owner.connect("Laptop", [])).toBe(true);
    expect(h.native.command.mock.calls[1][0]).toEqual({ kind: "start" });
    expect(h.api.create).toHaveBeenCalledOnce();
  });

  it("replaces an expired invitation only on retry", async () => {
    const h = harness();
    h.api.create.mockImplementationOnce(async (args) => ({ pairing: { ...args, username: "human", createdAt: 1, expiresAt: 2, state: "expired" } }));
    const owner = h.owner();
    expect(await owner.connect("Laptop", [])).toBe(false);
    expect(h.native.command).not.toHaveBeenCalled();
    expect(await owner.connect("Laptop", [])).toBe(true);
    expect(h.api.create.mock.calls[0][0].id).not.toBe(h.api.create.mock.calls[1][0].id);
  });

  it("refuses to create an invitation when it cannot persist recovery state", async () => {
    const h = harness();
    h.storage.write = () => { throw new Error("Unavailable"); };
    expect(await h.owner().connect("Laptop", [])).toBe(false);
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.native.command).not.toHaveBeenCalled();
  });
});
