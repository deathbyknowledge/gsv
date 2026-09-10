import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ShellSessionStore } from "./shell-sessions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Kernel } from "./do";

describe("ShellSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remembers the owning device for a running session", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new ShellSessionStore(sql);

      store.rememberDeviceSession("sh_1", "macbook");

      expect(store.get("sh_1")).toMatchObject({
        sessionId: "sh_1",
        targetId: "macbook",
        status: "running",
      });
    });
  });

  it("rejects expired sessions during lookup", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new ShellSessionStore(sql);
      store.rememberDeviceSession("sh_1", "macbook", "running", { ttlMs: 10 });

      now.mockReturnValue(1_010);

      expect(store.get("sh_1")).toBeNull();
      expect(store.get("sh_1")).toBeNull();
    });
  });

  it("retains a disconnected device session so a new connection can check it", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (kernel: Kernel) => {
      kernel.shellSessions.rememberDeviceSession("sh_1", "macbook");
      kernel.transport.failRoutesForTarget("macbook");
      expect(kernel.shellSessions.get("sh_1")).toMatchObject({ status: "running", error: null });
    });
  });
});
