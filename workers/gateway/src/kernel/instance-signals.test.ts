import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Kernel } from "./do";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances, InstanceExecChange } from "@humansandmachines/gsv/services/instances";

afterEach(() => { vi.restoreAllMocks(); });

function shellFixture(kernel: Kernel) {
  kernel.auth.addUser({ username: "linux-owner", uid: 1000, gid: 1000, gecos: "", home: "/home/linux-owner", shell: "/bin/init" });
  const instance: CloudInstance = {
    instanceId: "instance", targetId: "cloud:linux", ownerUid: 1000, startRequestId: "start",
    templateId: "linux", templateRevision: "1", kind: "linux", implements: ["shell.exec", "shell.cancel"], label: "Linux computer",
    state: "ready", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000,
  };
  const change: Omit<InstanceExecChange, "installationId"> = {
    ownerUid: 1000, instanceId: instance.instanceId, targetId: instance.targetId, sessionId: "shell", event: "finished", exitCode: 0,
  };
  const get = vi.fn<InstallationInstances["get"]>().mockResolvedValue({ instance });
  const dispose = vi.fn();
  // SAFETY: Session notifications only query the instance and release this scoped service.
  const service = { get, [Symbol.dispose]: dispose } as InstallationInstances;
  const getInstallation = vi.fn(async () => service);
  vi.spyOn(kernel, "bindings", "get").mockReturnValue({ ...kernel.bindings, INSTANCES: { getInstallation } });
  const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
  const disabled = vi.spyOn(kernel.auth, "isAccountDisabled").mockReturnValue(false);
  const broadcast = vi.spyOn(kernel.connectionRuntime, "broadcastToUserUid").mockImplementation(() => {});
  return { instance, change, get, getInstallation, dispose, gate, disabled, broadcast };
}

it("delivers instance changes to the exact owner and rechecks account and space admission", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    kernel.auth.addUser({ username: "browser-owner", uid: 1000, gid: 1000, gecos: "", home: "/home/browser-owner", shell: "/bin/init" });
    const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
    const disabled = vi.spyOn(kernel.auth, "isAccountDisabled").mockReturnValue(false);
    const broadcast = vi.spyOn(kernel.connectionRuntime, "broadcastToUserUid").mockImplementation(() => {});
    try {
      await kernel.instancesChanged(1000);
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(1000, "instance.changed");
      broadcast.mockClear();
      await kernel.instancesChanged(9999);
      disabled.mockReturnValue(true);
      await kernel.instancesChanged(1000);
      disabled.mockReturnValue(false);
      gate.mockResolvedValue({ allowed: false, code: 423, message: "Space is restricted" });
      await kernel.instancesChanged(1000);
      expect(broadcast).not.toHaveBeenCalled();
    } finally { gate.mockRestore(); disabled.mockRestore(); broadcast.mockRestore(); }
  });
});

it("records an instance completion before the start response and retains its target and terminal state", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    const f = shellFixture(kernel);
    await kernel.instanceExecChanged(f.change);
    expect(f.getInstallation).toHaveBeenCalledExactlyOnceWith(kernel.installationId);
    expect(f.get).toHaveBeenCalledExactlyOnceWith({ ownerUid: 1000, human: false }, { instanceId: f.instance.instanceId });
    expect(kernel.shellSessions.get("shell")).toMatchObject({ targetId: f.instance.targetId, status: "completed", exitCode: 0 });
    expect(f.broadcast).toHaveBeenCalledExactlyOnceWith(1000, "instance.changed");
    expect(f.dispose).toHaveBeenCalledOnce();

    kernel.shellSessions.recordResult(f.instance.targetId, { sessionId: "shell", status: "running", output: "" });
    await kernel.instanceExecChanged({ ...f.change, event: "started", exitCode: undefined });
    expect(kernel.shellSessions.get("shell")).toMatchObject({ targetId: f.instance.targetId, status: "completed", exitCode: 0 });
  });
});

it("does not admit instance session events for another owner, target, instance, or inactive environment", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    const f = shellFixture(kernel);
    for (const instance of [
      null,
      { ...f.instance, ownerUid: 2000 },
      { ...f.instance, instanceId: "replacement" },
      { ...f.instance, targetId: "replacement-target" },
      { ...f.instance, kind: "browser" as const },
      { ...f.instance, state: "stopped" as const },
      { ...f.instance, expiresAt: Date.now() - 1 },
    ]) {
      f.get.mockResolvedValueOnce({ instance });
      await kernel.instanceExecChanged(f.change);
      expect(kernel.shellSessions.get("shell")).toBeNull();
    }
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(7);
  });
});

it("does not retarget a machine session or accept an instance event for a machine registry target", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    const f = shellFixture(kernel);
    kernel.shellSessions.rememberDeviceSession("shell", "macbook");
    await kernel.instanceExecChanged(f.change);
    expect(kernel.shellSessions.get("shell")).toMatchObject({ targetId: "macbook", status: "running" });
    vi.spyOn(kernel.targets, "get").mockReturnValue({
      target_id: f.instance.targetId, owner_uid: 1000, label: "Machine", description: "", platform: "linux", version: "1",
      implements: ["shell.exec"], online: true, first_seen_at: 0, last_seen_at: 0, connected_at: 0, disconnected_at: null,
    });
    await kernel.instanceExecChanged({ ...f.change, sessionId: "new-shell" });
    expect(kernel.shellSessions.get("new-shell")).toBeNull();
    expect(f.broadcast).not.toHaveBeenCalled();
  });
});

it("rechecks account and installation admission around the instance lookup", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    const f = shellFixture(kernel);
    await kernel.instanceExecChanged({ ...f.change, ownerUid: 9999 });
    f.disabled.mockReturnValue(true);
    await kernel.instanceExecChanged(f.change);
    f.disabled.mockReturnValue(false);
    f.gate.mockResolvedValueOnce({ allowed: false, code: 423, message: "Space is restricted" });
    await kernel.instanceExecChanged(f.change);
    expect(f.getInstallation).not.toHaveBeenCalled();

    f.get.mockImplementationOnce(async () => { f.disabled.mockReturnValue(true); return { instance: f.instance }; });
    await kernel.instanceExecChanged(f.change);
    f.disabled.mockReturnValue(false);
    f.gate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, code: 423, message: "Space is restricted" });
    await kernel.instanceExecChanged(f.change);
    expect(kernel.shellSessions.get("shell")).toBeNull();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });
});

it("propagates instance lookup failures for the service to retry and releases its capability", async () => {
  await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
    const f = shellFixture(kernel);
    f.get.mockRejectedValueOnce(new Error("Instance lookup unavailable"));
    await expect(kernel.instanceExecChanged(f.change)).rejects.toThrow("Instance lookup unavailable");
    expect(kernel.shellSessions.get("shell")).toBeNull();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
