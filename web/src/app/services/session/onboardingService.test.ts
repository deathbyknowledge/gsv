import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOnboardingService, type OnboardingClient } from "./onboardingService";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { host: "example.test", protocol: "https:", pathname: "/", hash: "" },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("initial personal agent", () => {
  it("normalizes a saved name and later draft replacements to algo", () => {
    window.sessionStorage.setItem("gsv.ui.onboarding.v2", JSON.stringify({
      draft: { account: { username: "hank", agentName: "friday" } },
    }));
    const service = createOnboardingService({ requestOnce: vi.fn() });

    expect(service.snapshot().draft.account).toMatchObject({ username: "hank", agentName: "algo" });
    service.updateDraft((draft) => ({ ...draft, account: { ...draft.account, agentName: "echo" } }));
    expect(service.snapshot().draft.account.agentName).toBe("algo");
    const replacement = structuredClone(service.snapshot().draft);
    replacement.account.agentName = "iris";
    service.replaceDraft(replacement);
    expect(service.snapshot().draft.account.agentName).toBe("algo");
    service.reset("hank");
    expect(service.snapshot().draft.account.agentName).toBe("algo");
  });

  it("keeps algo when the setup guide patches account details", async () => {
    const requestOnce = vi.fn<OnboardingClient["requestOnce"]>().mockResolvedValue({
      message: "Account details updated.",
      patches: [
        { op: "set", path: "account.username", value: "hank" },
        { op: "set", path: "account.agentName", value: "friday" },
      ],
      focus: "account",
      reviewReady: false,
    });
    const service = createOnboardingService({ requestOnce });

    await service.assist("Use these account details.");

    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().draft.account).toMatchObject({ username: "hank", agentName: "algo" });
    expect(requestOnce).toHaveBeenCalledWith("wss://example.test/ws", "sys.setup.assist", expect.objectContaining({
      draft: expect.objectContaining({ account: expect.objectContaining({ agentName: "algo" }) }),
    }));
  });
});
