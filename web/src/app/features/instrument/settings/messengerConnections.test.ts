import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { loadMessengerConnections, messengerConnectionStatus } from "./messengerConnectionsService";

describe("saved messenger connections", () => {
  it("loads discovery and only the signed-in person's saved identities", async () => {
    const call = vi.fn<GSVClient["call"]>().mockImplementation(async (method) => {
      if (method === "adapter.list") return { adapters: [{ adapter: "telegram", available: true, enabled: true, canLink: true, supportsPairing: true, accounts: [] }] };
      if (method === "sys.link.list") return { links: [
        { adapter: "telegram", accountId: "managed", actorId: "mine", uid: 1000 },
        { adapter: "telegram", accountId: "managed", actorId: "someone-else", uid: 1001 },
      ] };
      throw new Error(`Unexpected call ${method}`);
    });
    const first = await loadMessengerConnections({ call }, 1000);
    const afterReload = await loadMessengerConnections({ call }, 1000);
    expect(first).toEqual(afterReload);
    expect(first.links.map((link) => link.actorId)).toEqual(["mine"]);
    expect(first.adapters[0].supportsPairing).toBe(true);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["adapter.list", "sys.link.list", "adapter.list", "sys.link.list"]);
  });

  it("uses the Kernel's link decision instead of inferring it from a deployed pairing-capable adapter", async () => {
    const call = vi.fn<GSVClient["call"]>().mockImplementation(async (method) => method === "adapter.list"
      ? { adapters: [{ adapter: "telegram", available: true, enabled: true, canLink: false, supportsPairing: true, accounts: [] }] }
      : { links: [] });
    expect((await loadMessengerConnections({ call }, 1000)).adapters[0]).toMatchObject({ enabled: true, canLink: false });
    call.mockImplementation(async (method) => method === "adapter.list"
      ? { adapters: [{ adapter: "telegram", available: true, supportsPairing: true, accounts: [] }] }
      : { links: [] });
    expect((await loadMessengerConnections({ call }, 1000)).adapters[0]).toMatchObject({ enabled: false, canLink: false });
  });

  it.each(["adapter.list", "sys.link.list"])("keeps a failed %s read visible instead of presenting an unlinked account", async (failed) => {
    const call = vi.fn<GSVClient["call"]>().mockImplementation(async (method) => {
      if (method === failed) throw new Error("Connection details are unavailable");
      return method === "adapter.list" ? { adapters: [] } : { links: [] };
    });
    await expect(loadMessengerConnections({ call }, 1000)).rejects.toThrow("Connection details are unavailable");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a saved identity from the transport being ready", () => {
    const account = { adapter: "telegram", accountId: "managed", connected: true, authenticated: true, mode: "managed-shared", lastActivity: null, error: "", extra: {} };
    const adapter = { adapter: "telegram", available: true, enabled: true, canLink: true, supportsConnect: false, supportsDisconnect: false, supportsSend: true, supportsStatus: true, supportsActivity: true, supportsPairing: true, accounts: [account] };
    expect(messengerConnectionStatus(adapter, "managed")).toBe("connected");
    expect(messengerConnectionStatus(adapter, "missing")).toBe("linked · status unavailable");
    expect(messengerConnectionStatus(undefined, "managed")).toBe("linked · service unavailable");
    expect(messengerConnectionStatus({ ...adapter, available: false }, "managed")).toBe("linked · service unavailable");
    expect(messengerConnectionStatus({ ...adapter, accounts: [{ ...account, authenticated: false }] }, "managed")).toBe("linked · reconnect needed");
    expect(messengerConnectionStatus({ ...adapter, accounts: [{ ...account, error: "Delivery unavailable" }] }, "managed")).toBe("linked · needs attention");
  });
});
