import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Kernel } from "./do";

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
