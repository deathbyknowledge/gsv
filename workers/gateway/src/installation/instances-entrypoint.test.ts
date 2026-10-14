import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { InstancesGatewayEntrypoint } from "./instances-entrypoint";

function fixture(authority: string | undefined = "instance-notifications", state = "active", found = true) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const instancesChanged = vi.fn(async () => {});
  const getByName = vi.fn(() => ({ instancesChanged }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({ found, installationId, state }));
  // SAFETY: The entrypoint reads only these binding props, trusted directory records and Kernel methods.
  const entrypoint = new InstancesGatewayEntrypoint(ctx as never, { KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, instancesChanged, resolveInstallation };
}

describe("instance change notifications", () => {
  const change = { installationId: "inst_browser", ownerUid: 1000 };
  it.each(["", "adapter", "installation-owner-recovery"])("rejects %s authority before directory or Kernel access", async authority => {
    const f = fixture(authority);
    await expect(f.entrypoint.instancesChanged(change)).rejects.toThrow("binding authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });
  it("does not allocate a Kernel for unknown, restricted or retired installations", async () => {
    for (const f of [fixture("instance-notifications", "active", false), fixture("instance-notifications", "restricted"), fixture("instance-notifications", "retained")]) {
      await f.entrypoint.instancesChanged(change);
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid owner identities before addressing the directory", async () => {
    const f = fixture();
    await expect(f.entrypoint.instancesChanged({ ...change, ownerUid: -1 })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });
  it("routes the stored installation identity and exact owner without browser content", async () => {
    const f = fixture();
    await f.entrypoint.instancesChanged(change);
    expect(f.getByName).toHaveBeenCalledWith(change.installationId);
    expect(f.instancesChanged).toHaveBeenCalledWith(change.ownerUid);
  });
});
