import { afterEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { SysSetupResult } from "@humansandmachines/gsv/protocol";
import { createSessionService } from "./sessionService";

const SETUP_RESULT: SysSetupResult = {
  server: { version: "0.4.0", release: "test" },
  user: {
    uid: 1000,
    gid: 1000,
    gids: [1000],
    username: "alice",
    home: "/home/alice",
    cwd: "/home/alice",
  },
  rootLocked: false,
};

function installWindow(hash: string, search = "") {
  const location = {
    protocol: "https:",
    host: "tenant.gsv.space",
    pathname: "/",
    search,
    hash,
  };
  const storage = new Map<string, string>();
  const replaceState = vi.fn((_state: unknown, _title: string, path: string | URL | null) => {
    const url = new URL(String(path), "https://tenant.gsv.space");
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  });

  vi.stubGlobal("window", {
    location,
    history: { state: null, replaceState },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    setTimeout,
    clearTimeout,
  });

  return { location, replaceState, storage };
}

function createClient() {
  const requestOnce = vi.fn(async () => SETUP_RESULT);
  const client = {
    onStatus: vi.fn(),
    requestOnce,
    isConnected: vi.fn(() => false),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => ({ state: "disconnected" })),
  } as unknown as GSVClient;
  return { client, requestOnce };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed setup token handoff", () => {
  it("removes the fragment immediately and sends its token only once", async () => {
    const { location, replaceState, storage } = installWindow("#setupToken=raw%2Dsecret");
    const { client, requestOnce } = createClient();

    const service = createSessionService(client);

    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(location.hash).toBe("");
    expect(service.withSetupAuthorization({ lane: "quick" })).toEqual({
      lane: "quick",
      setupToken: "raw-secret",
    });

    requestOnce.mockRejectedValueOnce(Object.assign(new Error("Setup required"), { code: 425 }));
    await service.start();

    const input = { username: "alice", password: "password-123", timezone: "UTC" };
    await service.setup(input);
    await service.setup(input);

    expect(requestOnce).toHaveBeenNthCalledWith(
      1,
      "wss://tenant.gsv.space/ws",
      "sys.connect",
      {
        protocol: 2,
        client: {
          id: "gsv-ui-setup-probe",
          version: "0.4.0",
          platform: "browser",
          role: "user",
        },
      },
    );
    expect(requestOnce).toHaveBeenNthCalledWith(
      2,
      "wss://tenant.gsv.space/ws",
      "sys.setup",
      { ...input, setupToken: "raw-secret" },
    );
    expect(requestOnce).toHaveBeenNthCalledWith(
      3,
      "wss://tenant.gsv.space/ws",
      "sys.setup",
      input,
    );
    expect([...storage.values()].join(" ")).not.toContain("raw-secret");
  });

  it("ignores query-string setup tokens", async () => {
    const { replaceState } = installWindow("", "?setupToken=query-secret");
    const { client, requestOnce } = createClient();
    const service = createSessionService(client);
    const input = { username: "alice", password: "password-123" };

    await service.setup(input);

    expect(replaceState).not.toHaveBeenCalled();
    expect(requestOnce).toHaveBeenCalledWith(
      "wss://tenant.gsv.space/ws",
      "sys.setup",
      input,
    );
  });
});
