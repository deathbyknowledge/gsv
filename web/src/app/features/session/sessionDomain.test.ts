import { describe, expect, it } from "vitest";
import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import type { SessionPhase, SessionSnapshot } from "../../services/session/sessionService";
import {
  buildNodeBootstrapCommand,
  resolveVisibleView,
  validateSetupDetails,
  type PendingAction,
} from "./sessionDomain";

function snapshot(phase: SessionPhase): SessionSnapshot {
  return {
    phase,
    url: "ws://localhost/ws",
    username: "root",
    connectionId: phase === "ready" ? "connection-id" : null,
    message: null,
    setupResult: null,
  };
}

function setupDraft(account: Partial<OnboardingDraft["account"]> = {}): OnboardingDraft {
  return {
    lane: "quick",
    mode: "manual",
    stage: "details",
    detailStep: "account",
    account: {
      username: "hank",
      agentName: "friday",
      password: "password123",
      passwordConfirm: "password123",
      ...account,
    },
    admin: {
      mode: "same",
      password: "",
      passwordConfirm: "",
    },
    system: {
      timezone: "UTC",
    },
    ai: {
      enabled: false,
      provider: "",
      model: "",
      apiKey: "",
    },
    source: {
      enabled: false,
      value: "",
      ref: "",
    },
    device: {
      enabled: false,
      deviceId: "",
      label: "",
      expiryDays: "",
    },
  };
}

describe("resolveVisibleView", () => {
  it("keeps booting separate from login and desktop", () => {
    expect(resolveVisibleView(snapshot("booting"), null)).toBe("booting");
  });

  it("shows the desktop only after the session is ready", () => {
    expect(resolveVisibleView(snapshot("ready"), null)).toBe("desktop");
  });

  it("keeps manual authentication on the login view", () => {
    expect(resolveVisibleView(snapshot("authenticating"), "login")).toBe("login");
  });

  it("shows provisioning while setup is being submitted", () => {
    expect(resolveVisibleView(snapshot("authenticating"), "setup")).toBe("provisioning");
  });

  it("routes setup and setup-complete phases to their dedicated views", () => {
    expect(resolveVisibleView(snapshot("setup"), null)).toBe("setup");
    expect(resolveVisibleView(snapshot("setup-complete"), null)).toBe("complete");
  });
});

describe("validateSetupDetails", () => {
  it("explains invalid desktop usernames without exposing the regex", () => {
    const result = validateSetupDetails(setupDraft({ username: "Hank" }), true);

    expect(result).toEqual({
      message: "Username must be 1-32 characters, start with a lowercase letter or underscore, and use only lowercase letters, numbers, underscores, or hyphens.",
      step: "account",
    });
    expect(result.message).not.toContain("^[a-z_]");
  });

  it("explains invalid personal agent usernames without exposing the regex", () => {
    const result = validateSetupDetails(setupDraft({ agentName: "Friday!" }), true);

    expect(result).toEqual({
      message: "Personal agent username must be 1-32 characters, start with a lowercase letter or underscore, and use only lowercase letters, numbers, underscores, or hyphens.",
      step: "account",
    });
    expect(result.message).not.toContain("^[a-z_]");
  });
});

describe("buildNodeBootstrapCommand", () => {
  it("uses gsv.exe for Windows follow-up commands", () => {
    expect(buildNodeBootstrapCommand(
      "https://gsv.example.com",
      "windows",
      "studio-pc",
      "tok",
    )).toBe([
      "$env:GSV_BASE_URL='https://gsv.example.com'; irm https://gsv.example.com/public/gsv/downloads/cli/install.ps1 | iex",
      "gsv.exe config --local set gateway.url \"wss://gsv.example.com/ws\"",
      "gsv.exe config --local set node.id \"studio-pc\"",
      "gsv.exe config --local set node.token \"tok\"",
      "gsv.exe device install --id \"studio-pc\" --workspace \"$HOME\"",
    ].join("\n"));
  });
});
