import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { GatewayRecoveryEntrypoint } from "./recovery-entrypoint";

function fixture(authority: string | undefined, state = "active", found = true) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const authorizeRootRecovery = vi.fn(async () => ({ authorized: true as const }));
  const confirmOwnerLinkAuthorization = vi.fn(async () => ({ authorized: true as const }));
  const getByName = vi.fn(() => ({ authorizeRootRecovery, confirmOwnerLinkAuthorization }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({ found, installationId, state }));
  // SAFETY: The entrypoint reads exactly these binding props, directory records and Kernel RPC methods.
  const entrypoint = new GatewayRecoveryEntrypoint(ctx as never, { KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, authorizeRootRecovery, confirmOwnerLinkAuthorization, resolveInstallation };
}

describe("dedicated Accounts recovery binding", () => {
  const request = { installationId: "inst_owner", attemptId: crypto.randomUUID(), purpose: "root-password-reset" as const, secretHash: "f".repeat(64), expiresAt: Date.now() + 300_000 };

  it.each([undefined, "adapter", "kernel-owner-link"])("refuses caller authority %s before resolving or allocating a Kernel", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.authorizeRootRecovery(request)).rejects.toThrow("binding authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("refuses an unknown or inactive identity without allocating a Kernel", async () => {
    for (const f of [fixture("installation-owner-recovery", "active", false), fixture("installation-owner-recovery", "retained")]) {
      await expect(f.entrypoint.authorizeRootRecovery(request)).rejects.toThrow("unavailable");
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("passes the exact claim to the directory-resolved Kernel and keeps owner linking a separate operation", async () => {
    const f = fixture("installation-owner-recovery");
    await expect(f.entrypoint.authorizeRootRecovery(request)).resolves.toEqual({ authorized: true });
    expect(f.getByName).toHaveBeenCalledWith(request.installationId);
    expect(f.authorizeRootRecovery).toHaveBeenCalledWith(request);
    await f.entrypoint.confirmOwnerLinkAuthorization({ installationId: request.installationId, attemptId: request.attemptId });
    expect(f.confirmOwnerLinkAuthorization).toHaveBeenCalledWith(request.attemptId);
  });
});
