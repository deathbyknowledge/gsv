import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { createTestRoot } from "../../testing/testHarness";
import { useSessionScreensState } from "./useSessionScreensState";

afterEach(() => vi.unstubAllGlobals());

type SetupHistoryState = { gsvSetupConsent: boolean } | { scrollPosition: number } | null;
type HistoryEntry = { url: string; state: SetupHistoryState };

async function setupScreen(path = "/", preceding: HistoryEntry[] = [{ url: "https://space.example/previous", state: null }]) {
  vi.stubGlobal("document", {});
  const events = new EventTarget();
  const entries: HistoryEntry[] = [
    ...preceding,
    { url: `https://space.example${path}`, state: null },
  ];
  let index = preceding.length;
  const traverse = (offset: number) => queueMicrotask(() => {
    if (index + offset < 0 || index + offset >= entries.length) return;
    index += offset;
    events.dispatchEvent(new Event("popstate"));
  });
  vi.stubGlobal("window", {
    get location() { return new URL(entries[index]!.url); },
    history: {
      get length() { return entries.length; },
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
      go: traverse,
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
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
    history: () => ({ index, entries: structuredClone(entries) }),
    async visitConsentStep() {
      await act(() => window.history.forward());
    },
    async change(next: Partial<SessionSnapshot>) { snapshot = { ...snapshot, ...next }; await render(); },
    unmount: () => root.unmount(),
  };
}

describe("minimal account setup", () => {
  it("submits only the personal password after consent", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password123");
      });
      await act(() => screen.state().setup.onSubmit(new Event("submit")));
      expect(screen.state().setup.step).toBe("consent");
      await act(() => screen.state().setup.onConsent(true));
      await act(() => { void screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledWith({ password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
    } finally { await screen.unmount(); }
  });

  it("defers blur errors until submit when a pointer press does not focus Continue", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onSubmitPointerDown();
        screen.state().setup.onFieldBlur("password", null);
      });
      expect(screen.state().setup.fieldErrors.password).toBeUndefined();
      await act(() => { window.dispatchEvent(new Event("pointerup")); });
      expect(screen.state().setup.fieldErrors.password).toBeUndefined();
      await act(() => screen.state().setup.onSubmit(new Event("submit")));
      expect(screen.state().setup.fieldErrors.password).toBe("Password must be at least 8 characters.");
      expect(screen.state().setup.fieldErrors.password).toBeDefined();
      expect(screen.state().setup.fieldErrors.passwordConfirm).toBeDefined();
      expect(screen.setup).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it.each(["pointerup", "pointercancel", "blur"])("resumes blur validation after an abandoned submit press ends with %s", async (event) => {
    const screen = await setupScreen();
    try {
      await act(() => screen.state().setup.onSubmitPointerDown());
      await act(() => { window.dispatchEvent(new Event(event)); });
      await act(() => screen.state().setup.onFieldBlur("password", null));
      expect(screen.state().setup.fieldErrors.password).toBe("Password must be at least 8 characters.");
    } finally { await screen.unmount(); }
  });

  it.each(["/", "/onboarding"])("collapses the completed wizard before the next browser Back from %s", async (path) => {
    const screen = await setupScreen(path);
    await act(() => {
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
      next.state().setup.onPassword("password123");
      next.state().setup.onPasswordConfirm("password123");
    });
    await act(() => next.state().setup.onSubmit(new Event("submit")));
    window.history.pushState(null, "");
    window.history.replaceState(null, "", "/recover");
    await next.unmount();
    expect(window.location.pathname).toBe("/recover");
  });

  it.each(["/", "/onboarding"])("cleans both wizard entries when setup completes after in-flight Back from %s", async (path) => {
    const screen = await setupScreen(path);
    await act(() => {
      screen.state().setup.onPassword("password123");
      screen.state().setup.onPasswordConfirm("password123");
    });
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await act(() => screen.state().setup.onConsent(true));
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await screen.change({ phase: "authenticating" });
    await act(async () => window.history.back());
    expect(screen.state()).toMatchObject({ visibleView: "setup", busy: true, setup: { step: "credentials" } });
    expect(screen.setup).toHaveBeenCalledOnce();

    window.history.replaceState(window.history.state, "", "/");
    await screen.unmount();
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
    await act(() => window.history.back());
    expect(window.location.pathname).toBe("/previous");
    await act(() => window.history.forward());
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
    // Even the former consent slot must point to the completed space when
    // reached from forward history, without restoring wizard state.
    await act(() => window.history.forward());
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
  });

  it.each([
    { path: "/", backCount: 2 },
    { path: "/onboarding", backCount: 2 },
    { path: "/", backCount: 3 },
    { path: "/onboarding", backCount: 3 },
  ])("repairs the wizard after $backCount Back presses from $path without changing preceding entries", async ({ path, backCount }) => {
    const preceding: HistoryEntry[] = [
      { url: "https://space.example/earlier?view=kept#position", state: { scrollPosition: 42 } },
      { url: "https://space.example/previous", state: null },
    ];
    const screen = await setupScreen(path, preceding);
    await act(() => {
      screen.state().setup.onPassword("password123");
      screen.state().setup.onPasswordConfirm("password123");
    });
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await act(() => screen.state().setup.onConsent(true));
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await screen.change({ phase: "authenticating" });
    for (let count = 0; count < backCount; count++) await act(async () => window.history.back());
    const position = screen.history().index;
    expect(window.location.href).toBe(preceding[position]!.url);

    // The completed screen unmounts the wizard while the preceding entry is
    // current. Capability completion must not rewrite that unrelated page.
    await screen.unmount();
    await vi.waitFor(() => expect(screen.history()).toEqual({ index: position, entries: [
      ...preceding,
      { url: "https://space.example/", state: null },
      { url: "https://space.example/", state: null },
    ] }));
    for (let index = position + 1; index < preceding.length + 2; index++) {
      await act(async () => window.history.forward());
      expect(window.location.href).toBe(index < preceding.length ? preceding[index]!.url : "https://space.example/");
      expect(window.history.state).toBeNull();
    }
  });

  it("leaves a new navigation alone after it prunes the forward wizard entries", async () => {
    const screen = await setupScreen("/onboarding");
    await act(() => {
      screen.state().setup.onPassword("password123");
      screen.state().setup.onPasswordConfirm("password123");
    });
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await act(async () => window.history.back());
    await act(async () => window.history.back());
    window.history.pushState(null, "");
    // Keep the same URL to ensure history length, rather than URL alone,
    // distinguishes a new navigation that removed the wizard from history.
    const history = screen.history();
    await screen.unmount();
    expect(screen.history()).toEqual(history);
  });

  it("returns to the original credentials entry after Back, invalid edits and Forward", async () => {
    const screen = await setupScreen("/onboarding");
    await act(() => {
      screen.state().setup.onPassword("password123");
      screen.state().setup.onPasswordConfirm("password123");
    });
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await act(() => window.history.back());
    await act(() => screen.state().setup.onPasswordConfirm("different"));
    await screen.visitConsentStep();
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    expect(screen.state().setup.step).toBe("credentials");
    expect(window.history.state).toEqual({ gsvSetupConsent: false });
    expect(screen.setup).not.toHaveBeenCalled();
    await act(() => screen.state().setup.onPasswordConfirm("password123"));
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    await act(() => screen.state().setup.onConsent(true));
    await act(() => screen.state().setup.onSubmit(new Event("submit")));
    expect(screen.setup).toHaveBeenCalledOnce();
    window.history.replaceState(window.history.state, "", "/");
    await screen.unmount();
    expect(window.location.pathname).toBe("/");
    expect(window.history.state).toBeNull();
    await act(() => window.history.back());
    expect(window.location.pathname).toBe("/previous");
  });

  it("requires consent before submitting credentials, retaining the form after a retryable failure", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
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
      expect(screen.state().setup).toMatchObject({ step: "credentials", password: "password123", passwordConfirm: "password123" });
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
        password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });

      await screen.change({ phase: "authenticating" });
      expect(screen.state()).toMatchObject({ visibleView: "setup", busy: true });
      await act(() => { screen.state().setup.onBack(); });
      expect(screen.state().setup.step).toBe("consent");
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledOnce();

      await screen.change({ phase: "setup", message: "Please try again." });
      expect(screen.state().setup).toMatchObject({ step: "consent", password: "password123", passwordConfirm: "password123", consent: true, error: "Please try again." });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledTimes(2);
    } finally { await screen.unmount(); }
  });

  it("shows personal sign-in if connecting after setup fails", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password123");
        screen.state().setup.onConsent(true);
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await screen.change({ phase: "authenticating" });
      await screen.change({ phase: "locked", username: "alice", message: "Connection interrupted." });
      expect(screen.state().visibleView).toBe("login");
      expect(screen.state().login).toMatchObject({ password: "", error: "Connection interrupted." });
      expect(screen.state().setup.password).toBe("");
      expect(screen.state().setup.passwordConfirm).toBe("");
      expect(screen.state().setup.consent).toBe(false);
      expect(screen.state().setup.step).toBe("credentials");
      expect(window.location.pathname).toBe("/");
      expect(window.history.state).toBeNull();

      await act(() => { screen.state().login.onPassword("password123"); });
      await act(() => { screen.state().login.onSubmit(new Event("submit")); });
      expect(screen.login).toHaveBeenCalledWith({ password: "password123" });
      expect(screen.setup).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it("does not create an account until the password confirmation matches", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
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
        password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
    } finally { await screen.unmount(); }
  });
});
