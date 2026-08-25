import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import {
  clearInstallationOnboardingToken,
  readInstallationOnboardingToken,
} from "./installationOnboarding";
import { createOnboardingService } from "./onboardingService";
import { createSessionService } from "./sessionService";

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
        replaceState(_state: unknown, _unused: string, url: string) {
          location = new URL(url, location);
        },
      },
      sessionStorage: {
        clear: () => values.clear(),
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
    }));
    const client = {
      onStatus: vi.fn(),
      requestOnce,
    } as unknown as GSVClient;
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
    expect(session.snapshot().phase).toBe("setup-complete");
    expect(readInstallationOnboardingToken()).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("adds the capability to setup assistant requests", async () => {
    window.history.replaceState(null, "", `/onboarding#${TOKEN}`);
    const requestOnce = vi.fn(async () => ({
      message: "Ready when you are.",
      patches: [],
      reviewReady: true,
    }));
    const onboarding = createOnboardingService({
      requestOnce,
    } as unknown as GSVClient);

    await onboarding.assist("Help me configure this.");

    expect(requestOnce).toHaveBeenCalledWith(
      "wss://local.gsv.space/ws",
      "sys.setup.assist",
      expect.objectContaining({ onboardingToken: TOKEN }),
    );
  });
});
