import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ShellSessionStore } from "./shell-sessions";

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
        deviceId: "macbook",
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

  it("marks active sessions failed when a device disconnects", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new ShellSessionStore(sql);
      store.rememberDeviceSession("sh_1", "macbook");

      store.failForDevice("macbook", "Device disconnected");

      expect(store.get("sh_1")).toMatchObject({
        status: "failed",
        error: "Device disconnected",
      });
    });
  });
});
