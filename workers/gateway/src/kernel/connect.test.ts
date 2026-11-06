import { describe, expect, it, vi } from "vitest";
import { ensureKernelBootstrapped } from "./connect";
import type { KernelContext } from "./context";

/** A Kernel whose first-boot state already exists, recording each check against storage. */
function bootedKernel() {
  const storage = {
    head: vi.fn(async (_key: string) => ({})),
    put: vi.fn(async () => ({})),
  };
  const ripgit = {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/refs")) return Response.json({ heads: { main: "existing" }, tags: {} });
      if (url.pathname.endsWith("/apply")) return Response.json({ ok: true, head: "next" });
      return new Response("missing", { status: 404 });
    }),
  };
  const auth = {
    bootstrap: vi.fn(async () => false),
    getPasswdEntries: vi.fn(() => []),
  };
  const caps = { seed: vi.fn() };
  // SAFETY: first-boot provisioning reads only these collaborators.
  const ctx = { auth, caps, env: { STORAGE: storage, RIPGIT: ripgit } } as unknown as KernelContext;
  return { ctx, auth, caps, storage, ripgit };
}

const refsReads = (ripgit: ReturnType<typeof bootedKernel>["ripgit"]) =>
  ripgit.fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/refs")).length;

describe("first-boot provisioning", () => {
  it("checks first-boot state once per Kernel lifetime", async () => {
    const kernel = bootedKernel();

    await Promise.all([ensureKernelBootstrapped(kernel.ctx), ensureKernelBootstrapped(kernel.ctx)]);
    await ensureKernelBootstrapped(kernel.ctx);

    expect(kernel.auth.bootstrap).toHaveBeenCalledOnce();
    expect(kernel.caps.seed).toHaveBeenCalledOnce();
    expect(kernel.storage.head.mock.calls.map(([key]) => key).sort()).toEqual(["public/.dir", "root/.dir"]);
    expect(refsReads(kernel.ripgit)).toBe(1);

    const other = bootedKernel();
    await ensureKernelBootstrapped(other.ctx);
    expect(other.auth.bootstrap).toHaveBeenCalledOnce();
    expect(refsReads(other.ripgit)).toBe(1);
  });

  it("checks again after a failed first boot", async () => {
    const kernel = bootedKernel();
    kernel.storage.head.mockRejectedValueOnce(new Error("storage temporarily unavailable"));

    await expect(ensureKernelBootstrapped(kernel.ctx)).rejects.toThrow("storage temporarily unavailable");
    await ensureKernelBootstrapped(kernel.ctx);
    await ensureKernelBootstrapped(kernel.ctx);

    expect(kernel.auth.bootstrap).toHaveBeenCalledTimes(2);
    expect(refsReads(kernel.ripgit)).toBe(1);
  });
});
