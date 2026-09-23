import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { createTestRoot } from "../../testing/testHarness";
import { useSessionScreensState } from "./useSessionScreensState";

afterEach(() => vi.unstubAllGlobals());

async function setupScreen() {
  vi.stubGlobal("document", {});
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
    async change(next: Partial<SessionSnapshot>) { snapshot = { ...snapshot, ...next }; await render(); },
    unmount: () => root.unmount(),
  };
}

describe("minimal account setup", () => {
  it("submits credentials and inferred timezone, retaining the form after a retryable failure", async () => {
    const screen = await setupScreen();
    try {
      await act(() => {
        screen.state().setup.onUsername("Alice");
        screen.state().setup.onPassword("password123");
        screen.state().setup.onPasswordConfirm("password123");
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledWith({
        username: "alice", password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });

      await screen.change({ phase: "authenticating" });
      expect(screen.state()).toMatchObject({ visibleView: "setup", busy: true });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledOnce();

      await screen.change({ phase: "setup", message: "Please try again." });
      expect(screen.state().setup).toMatchObject({ username: "alice", password: "password123", passwordConfirm: "password123", error: "Please try again." });
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
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      await screen.change({ phase: "authenticating" });
      await screen.change({ phase: "locked", username: "alice", message: "Connection interrupted." });
      expect(screen.state().visibleView).toBe("login");
      expect(screen.state().login).toMatchObject({ username: "alice", password: "", error: "Connection interrupted." });
      expect(screen.state().setup.password).toBe("");
      expect(screen.state().setup.passwordConfirm).toBe("");

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
      });
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).not.toHaveBeenCalled();
      expect(screen.state().setup.error).toBe("Passwords do not match.");

      await act(() => { screen.state().setup.onPasswordConfirm("password123"); });
      expect(screen.state().setup.error).toBeNull();
      await act(() => { screen.state().setup.onSubmit(new Event("submit")); });
      expect(screen.setup).toHaveBeenCalledWith({
        username: "alice", password: "password123", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
    } finally { await screen.unmount(); }
  });
});
