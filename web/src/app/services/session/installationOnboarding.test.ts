import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstallationOnboardingToken,
  readInstallationOnboardingToken,
} from "./installationOnboarding";
import { createSessionService, type SessionClient } from "./sessionService";

const TOKEN = `onboard_${"a".repeat(43)}`;

describe("installation onboarding capability", () => {
  beforeEach(() => {
    let location = new URL("https://local.gsv.space/");
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      get location() {
        return location;
      },
      history: {
        state: null,
        replaceState<T>(_state: T, _unused: string, url: string) {
          location = new URL(url, location);
        },
      },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("moves the capability out of the URL fragment into tab storage", () => {
    window.history.replaceState(null, "", `/onboarding#${TOKEN}`);

    expect(readInstallationOnboardingToken()).toBe(TOKEN);
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.location.hash).toBe("");
    expect(readInstallationOnboardingToken()).toBe(TOKEN);
  });

  it("keeps the capability in memory when tab storage rejects it", () => {
    window.history.replaceState(null, "", `/onboarding#${TOKEN}`);
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    expect(readInstallationOnboardingToken()).toBe(TOKEN);
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.location.hash).toBe("");
  });

  it("rejects malformed fragments", () => {
    window.history.replaceState(null, "", "/onboarding#not-a-capability");

    expect(readInstallationOnboardingToken()).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("removes the capability and onboarding path after setup", () => {
    window.history.replaceState(null, "", `/onboarding#${TOKEN}`);
    expect(readInstallationOnboardingToken()).toBe(TOKEN);

    clearInstallationOnboardingToken();

    expect(readInstallationOnboardingToken()).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("adds the capability to setup and clears it after activation", async () => {
    window.history.replaceState(null, "", `/onboarding#${TOKEN}`);
    const requestOnce = vi.fn(async () => ({
      server: { version: "0.4.1", release: "test" },
      user: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
      },
      rootLocked: false,
    })).mockRejectedValueOnce({ code: 425, details: { setupMode: true } });
    const client = {
      connect: vi.fn<SessionClient["connect"]>().mockResolvedValue({
        protocol: 4,
        server: { version: "0.4.1", release: "test", connectionId: "connection:alice" },
        peer: {
          id: "web", sessionId: "connection:alice",
          principal: {
            kind: "human",
            account: {
              uid: 1000, gid: 1000, gids: [1000], username: "alice",
              home: "/home/alice", cwd: "/home/alice",
            },
          },
          grant: { calls: [], signals: [], implements: [] },
        },
      }),
      disconnect: vi.fn(),
      isConnected: () => false,
      onStatus: vi.fn(),
      requestOnce,
      sys: { token: {
        create: vi.fn(async () => { throw new Error("No token storage in this fixture"); }),
        revoke: vi.fn(), list: vi.fn(),
      } },
    } satisfies SessionClient;
    const session = createSessionService(client);

    await session.start();
    expect(session.snapshot().phase).toBe("setup");
    await session.setup({
      username: "alice",
      password: "correct-horse-battery-staple",
    });

    expect(requestOnce).toHaveBeenCalledWith(
      "wss://local.gsv.space/ws",
      "sys.setup",
      {
        username: "alice",
        password: "correct-horse-battery-staple",
        onboardingToken: TOKEN,
      },
    );
    expect(readInstallationOnboardingToken()).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(session.snapshot().phase).toBe("ready");
    expect(client.connect).toHaveBeenCalledWith({
      url: "wss://local.gsv.space/ws",
      username: "alice",
      password: "correct-horse-battery-staple",
    });
  });
});
