import { describe, expect, it } from "vitest";
import type { SessionPhase, SessionSnapshot } from "../../services/session/sessionService";
import { resolveVisibleView, type PendingAction } from "./sessionDomain";

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
