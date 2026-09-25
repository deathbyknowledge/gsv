import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { createTestRoot } from "../../testing/testHarness";
import { useSessionScreensState } from "./useSessionScreensState";

afterEach(() => vi.unstubAllGlobals());

type SetupHistoryState = { gsvSetupConsent: boolean } | null;
type HistoryEntry = { url: string; state: SetupHistoryState };

async function setupScreen(path = "/") {
  vi.stubGlobal("document", {});
  const events = new EventTarget();
  const entries: HistoryEntry[] = [
    { url: "https://space.example/previous", state: null },
    { url: `https://space.example${path}`, state: null },
  ];
  let index = 1;
  const traverse = (offset: number) => queueMicrotask(() => {
    index += offset;
    events.dispatchEvent(new Event("popstate"));
  });
  vi.stubGlobal("window", {
    get location() { return new URL(entries[index]!.url); },
    history: {
      get state() { return entries[index]!.state; },
      replaceState: (state: SetupHistoryState, _unused: string, url?: string) => {
        entries[index] = { state, url: new URL(url ?? entries[index]!.url, entries[index]!.url).href };
      },
      pushState: (state: SetupHistoryState) => {
        entries.splice(index + 1, entries.length, { state, url: entries[index]!.url });
        index++;
      },
      back: () => traverse(-1),
      forward: () => traverse(1),
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  const root = createTestRoot("Session account form");
  let snapshot: SessionSnapshot = {
    phase: "setup", url: "wss://space.example/ws", username: "",
    connectionId: null, server: null, message: null,
  };
  const setup = vi.fn<SessionService["setup"]>(() => new Promise(() => {}));
  const login = vi.fn<SessionService["login"]>(() => new Promise(() => {}));
  const session: SessionService = {
    client: {
      connect: vi.fn(), disconnect: vi.fn(), isConnected: () => false,
      onStatus: vi.fn(), requestOnce: vi.fn(),
      sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
    },
    snapshot: () => snapshot, subscribe: () => () => {},
    setup, login, lock: async () => {}, start: async () => {},
  };
  let state!: ReturnType<typeof useSessionScreensState>;
  function Harness() { state = useSessionScreensState({ session, snapshot }); return null; }
  const render = () => root.render(<Harness />);
  await render();
  return {
    state: () => state, setup, login,
    async visitConsentStep() {
      await act(() => window.history.forward());
    },
    async change(next: Partial<SessionSnapshot>) { snapshot = { ...snapshot, ...next }; await render(); },
    unmount: () => root.unmount(),
  };
}

describe("minimal account setup", () => {
  it.each(["/", "/onboarding"])("collapses the completed wizard before the next browser Back from %s", async (path) => {
    const screen = await setupScreen(path);
    await act(() => {
      screen.state().setup.onUsername("alice");
      screen.state().setup.onPassword("password123");
      screen.state().setup.onPasswordConfirm("password123");
    });
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    // Capability setup rewrites the current entry before the ready screen
    // unmounts SessionScreens, without delivering a ready snapshot to its hook.
    window.history.replaceState(window.history.state, "", "/");
    await screen.unmount();
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
    await act(() => window.history.back());
    expect(window.location.pathname).toBe("/previous");
    await act(() => window.history.forward());
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
  });

  it("does not navigate back when leaving the first step or a different route", async () => {
    const screen = await setupScreen();
    await screen.unmount();
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();

    const next = await setupScreen();
    await act(() => {
      next.state().setup.onUsername("alice");
      next.state().setup.onPassword("password123");
      next.state().setup.onPasswordConfirm("password123");
    });
    await act(() => next.state().setup.onSubmit(new Event("submit")));
    window.history.pushState(null, "");
    window.history.replaceState(null, "", "/recover");
    await next.unmount();
    expect(window.location.pathname).toBe("/recover");
  });

  it("requires consent before submitting credentials, retaining the form after a retryable failure", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onUsername("Alice");
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password123");
      });
      expect(screen.state().setup.consent).toBe(false);
      expect(screen.state().setup.consentError).toBeNull();
      expect(screen.state().setup.step).toBe("credentials");
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.state().setup.step).toBe("consent");
      expect(screen.state().setup.consentError).toBeNull();
      expect(screen.setup).not.toHaveBeenCalled();
      await act(() => { screen.state().setup.onBack(); });
      expect(screen.state().setup).toMatchObject({ step: "credentials", username: "alice", password: "password123", passwordConfirm: "password123" });
      await screen.visitConsentStep();
      expect(screen.state().setup.step).toBe("consent");
      expect(screen.setup).not.toHaveBeenCalled();
      await act(() => { screen.state().setup.onBack(); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).not.toHaveBeenCalled();
      expect(screen.state().setup.consentError).toBe("Confirm your age and agreement to continue.");
      await act(() => { screen.state().setup.onConsent(true); });
      expect(screen.state().setup.consentError).toBeNull();
      await act(() => { screen.state().setup.onConsent(false); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).not.toHaveBeenCalled();
      await act(() => { screen.state().setup.onConsent(true); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledWith({
        username: "alice", password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });

      await screen.change({ phase: "authenticating" });
      expect(screen.state()).toMatchObject({ visibleView: "setup", busy: true });
      await act(() => { screen.state().setup.onBack(); });
      expect(screen.state().setup.step).toBe("consent");
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledOnce();

      await screen.change({ phase: "setup", message: "Please try again." });
      expect(screen.state().setup).toMatchObject({ step: "consent", username: "alice", password: "password123", passwordConfirm: "password123", consent: true, error: "Please try again." });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledTimes(2);
    } finally { await screen.unmount(); }
  });

  it("shows ordinary sign-in with the new username if connecting after setup fails", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onUsername("Alice");
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password123");
        screen.state().setup.onConsent(true);
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await screen.change({ phase: "authenticating" });
      await screen.change({ phase: "locked", username: "alice", message: "Connection interrupted." });
      expect(screen.state().visibleView).toBe("login");
      expect(screen.state().login).toMatchObject({ username: "alice", password: "", error: "Connection interrupted." });
      expect(screen.state().setup.password).toBe("");
      expect(screen.state().setup.passwordConfirm).toBe("");
      expect(screen.state().setup.consent).toBe(false);
      expect(screen.state().setup.step).toBe("credentials");
      expect(window.location.pathname).toBe("/");
      expect(window.history.state).toBeNull();

      await act(() => { screen.state().login.onPassword("password123"); });
      await act(() => { screen.state().login.onSubmit(new Event("submit")); });
      expect(screen.login).toHaveBeenCalledWith({ username: "alice", password: "password123" });
      expect(screen.setup).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it("does not create an account until the password confirmation matches", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onUsername("alice");
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password124");
        screen.state().setup.onConsent(true);
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).not.toHaveBeenCalled();
      expect(screen.state().setup.step).toBe("credentials");
      expect(screen.state().setup.fieldErrors.passwordConfirm).toBe("Passwords do not match.");

      await act(() => { screen.state().setup.onPasswordConfirm("password123"); });
      expect(screen.state().setup.fieldErrors.passwordConfirm).toBeUndefined();
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).not.toHaveBeenCalled();
      expect(screen.state().setup.step).toBe("consent");
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledWith({
        username: "alice", password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
    } finally { await screen.unmount(); }
  });
});
