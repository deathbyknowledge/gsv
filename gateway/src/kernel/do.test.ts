import { describe, expect, it, vi } from "vitest";
import { Kernel } from "./do";

describe("Kernel device connection cleanup", () => {
  it("closes live driver connections when a machine is forgotten", () => {
    const alpha = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-alpha" },
      },
      close: vi.fn(),
    };
    const beta = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-beta" },
      },
      close: vi.fn(),
    };
    const user = {
      state: {
        step: "connected",
        identity: { role: "user" },
      },
      close: vi.fn(),
    };
    const kernel = Object.create(Kernel.prototype) as {
      connections: Map<string, unknown>;
      disconnectDeviceConnections(deviceId: string, reason: string): void;
      failRoutesForDevice: ReturnType<typeof vi.fn>;
      runRoutes: {
        clearForConnection: ReturnType<typeof vi.fn>;
      };
    };
    kernel.connections = new Map([
      ["alpha", alpha],
      ["beta", beta],
      ["user", user],
    ]);
    kernel.failRoutesForDevice = vi.fn();
    kernel.runRoutes = {
      clearForConnection: vi.fn(),
    };

    kernel.disconnectDeviceConnections("node-alpha", "Machine forgotten");

    expect(alpha.close).toHaveBeenCalledWith(1000, "Machine forgotten");
    expect(beta.close).not.toHaveBeenCalled();
    expect(user.close).not.toHaveBeenCalled();
    expect(kernel.connections.has("alpha")).toBe(false);
    expect(kernel.connections.has("beta")).toBe(true);
    expect(kernel.connections.has("user")).toBe(true);
    expect(kernel.runRoutes.clearForConnection).toHaveBeenCalledWith("alpha");
    expect(kernel.failRoutesForDevice).toHaveBeenCalledWith("node-alpha");
  });
});

describe("Kernel CLI download refresh coordination", () => {
  it("runs explicit refreshes after an in-flight automatic refresh", async () => {
    const kernel = Object.create(Kernel.prototype) as {
      cliDownloadsRefresh: Promise<void> | null;
      withCliDownloadsRefreshSlot<T>(
        run: () => Promise<T>,
        options?: { waitForExisting?: boolean },
      ): Promise<T>;
    };
    kernel.cliDownloadsRefresh = null;
    const order: string[] = [];
    let releaseAutoRefresh: () => void = () => {};

    const automaticRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      order.push("auto:start");
      await new Promise<void>((resolve) => {
        releaseAutoRefresh = resolve;
      });
      order.push("auto:end");
    });

    let explicitStarted = false;
    const explicitRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      explicitStarted = true;
      order.push("explicit");
      return "updated";
    }, { waitForExisting: true });

    await Promise.resolve();
    expect(explicitStarted).toBe(false);

    releaseAutoRefresh();

    await expect(explicitRefresh).resolves.toBe("updated");
    await automaticRefresh;
    expect(order).toEqual(["auto:start", "auto:end", "explicit"]);
  });
});
