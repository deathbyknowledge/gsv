import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GsvRequestError } from "@humansandmachines/gsv/client";
import { SESSION_CREDENTIAL_PATTERN } from "@humansandmachines/gsv/protocol";
import type { SessionClient, SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { createTestRoot } from "../../testing/testHarness";
import { createEmailSignInAttempt } from "../../services/session/emailSignIn";
import { useEmailSignIn } from "./useEmailSignIn";

const url = "wss://ship.example/ws";
const snapshot: SessionSnapshot = { phase: "locked", url, username: "", connectionId: null, server: null, message: null };
const requestOnce = vi.fn<SessionClient["requestOnce"]>();
const adoptSession = vi.fn<SessionService["adoptSession"]>();
const session = {
  client: { connect: vi.fn(), disconnect: vi.fn(), isConnected: () => false, requestOnce, onStatus: () => () => undefined,
    sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } } },
  snapshot: () => snapshot, subscribe: () => () => {}, login: vi.fn(), adoptSession, setup: vi.fn(), lock: async () => {}, start: async () => {},
} satisfies SessionService;

let storage: Map<string, string>;
function stubBrowser(path: string) {
  let location = new URL(path, "https://ship.example");
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    get location() { return location; },
    history: { state: null, replaceState<T>(_state: T, _unused: string, next: string) { location = new URL(next, location); } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  return { get location() { return location; } };
}

/** The Ship: email sign-in offered, every code sent, and the session it opens. */
function ship({ emailSignIn = true } = {}) {
  requestOnce.mockImplementation(async (_url, call) => {
    if (call === "account.recovery.options") return emailSignIn ? { emailSignIn: true } : {};
    if (call === "account.signin.start") return { accepted: true };
    if (call === "account.signin.redeem") return { username: "person", tokenId: "token-1", expiresAt: 1_000 };
    throw new Error(`unexpected ${call}`);
  });
}

const roots: ReturnType<typeof createTestRoot>[] = [];
async function mount() {
  const root = createTestRoot("email sign-in");
  roots.push(root);
  let state!: ReturnType<typeof useEmailSignIn>;
  function Harness() { state = useEmailSignIn({ session, snapshot, visible: true }); return null; }
  await root.render(<Harness />);
  await settle();
  return { get state() { return state; } };
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Accounts mails the same address again only after a minute. */
const aMinuteLater = () => act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
const submit = async (screen: { state: ReturnType<typeof useEmailSignIn> }) => {
  // SAFETY: the form's submit handler only prevents the browser's default.
  await act(() => screen.state.view.onSubmit({ preventDefault() {} } as Event));
  await settle();
};
/** The arguments of each request for one call, in order. */
const calls = (name: string) => requestOnce.mock.calls.filter(([, call]) => call === name).map(([, , args]) => z.record(z.string(), z.unknown()).parse(args));

beforeEach(() => { storage = new Map(); requestOnce.mockReset(); adoptSession.mockReset(); });
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("email sign-in", () => {
  it("mails a code and signs in with the session opened from this browser's own credential", async () => {
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    expect(screen.state).toMatchObject({ loaded: true, available: true, method: "email" });
    await act(() => screen.state.view.onEmail(" owner@example.com "));
    await submit(screen);
    const [start] = calls("account.signin.start");
    expect(start).toMatchObject({ email: "owner@example.com" });
    expect(start).not.toHaveProperty("resend");
    expect(screen.state.view).toMatchObject({ step: "code", canResend: false });

    await act(() => screen.state.view.onCode("135 790"));
    await submit(screen);
    const [redeem] = calls("account.signin.redeem");
    expect(redeem).toMatchObject({ id: start?.id, secret: start?.secret, code: "135790", credential: expect.stringMatching(SESSION_CREDENTIAL_PATTERN) });
    expect(adoptSession).toHaveBeenCalledWith({ username: "person", tokenId: "token-1", token: redeem?.credential, expiresAt: 1_000 });
    expect(storage.size).toBe(0);
  });

  it("keeps the attempt when the answer is lost, so retrying repeats the same request", async () => {
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    await submit(screen);
    await act(() => screen.state.view.onCode("135790"));
    requestOnce.mockRejectedValueOnce(new Error("Connection interrupted"));
    await submit(screen);
    expect(screen.state.view.error).toBe("Connection interrupted");
    await submit(screen);
    const [lost, retried] = calls("account.signin.redeem");
    expect(retried).toEqual(lost);
    expect(adoptSession).toHaveBeenCalledOnce();
  });

  it("repeats the same start when its answer is lost, since Accounts mails one attempt once", async () => {
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    requestOnce.mockRejectedValueOnce(new Error("Connection interrupted"));
    await submit(screen);
    expect(screen.state.view).toMatchObject({ step: "email", error: "Connection interrupted" });
    await submit(screen);
    const [lost, retried] = calls("account.signin.start");
    expect(retried).toEqual(lost);
    expect(screen.state.view.step).toBe("code");
  });

  it("repeats a start whose answer was lost before a reload, instead of resending an attempt Accounts never started", async () => {
    ship();
    stubBrowser("/chat");
    const lost = createEmailSignInAttempt("owner@example.com");
    const screen = await mount();
    expect(screen.state.view).toMatchObject({ step: "email", email: "owner@example.com" });
    await submit(screen);
    expect(calls("account.signin.start")).toEqual([{ id: lost.id, secret: lost.secret, email: lost.email }]);
    expect(screen.state.view.step).toBe("code");
  });

  it("starts over instead of repeating a lost start whose ten minutes are over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    requestOnce.mockRejectedValueOnce(new Error("Connection interrupted"));
    await submit(screen);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    await submit(screen);
    const [lost, fresh] = calls("account.signin.start");
    expect(fresh?.id).not.toBe(lost?.id);
  });

  it("finishes from the email's button after a reload lost the start's answer", async () => {
    ship();
    stubBrowser("/chat");
    const lost = createEmailSignInAttempt("owner@example.com");
    stubBrowser(`/chat#signin=${lost.id}&code=246810`);
    await mount();
    await settle();
    expect(calls("account.signin.redeem").at(-1)).toMatchObject({ id: lost.id, code: "246810" });
    expect(adoptSession).toHaveBeenCalledOnce();
  });

  it("finishes from the email's button in the browser that asked, and scrubs the code from the address", async () => {
    ship();
    stubBrowser("/chat");
    const first = await mount();
    await act(() => first.state.view.onEmail("owner@example.com"));
    await submit(first);
    const [start] = calls("account.signin.start");
    const browser = stubBrowser(`/chat#signin=${String(start?.id)}&code=246810`);
    await mount();
    await settle();
    expect(browser.location.hash).toBe("");
    expect(calls("account.signin.redeem").at(-1)).toMatchObject({ id: start?.id, code: "246810" });
    expect(adoptSession).toHaveBeenCalledOnce();
  });

  it("asks for the code where it was requested when the button opens another browser", async () => {
    ship();
    const browser = stubBrowser(`/chat#signin=${crypto.randomUUID()}&code=246810`);
    const screen = await mount();
    expect(browser.location.hash).toBe("");
    expect(screen.state.view.error).toMatch(/device where you asked/);
    expect(calls("account.signin.redeem")).toHaveLength(0);
  });

  it("names what to do about a refused code, and starts over once the code is dead and Accounts would mail again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    await submit(screen);
    await act(() => screen.state.view.onCode("000000"));
    requestOnce.mockRejectedValueOnce(new GsvRequestError(429, "Email sign-in failed.", { details: { signIn: "locked" } }));
    await submit(screen);
    expect(screen.state.view).toMatchObject({ error: expect.stringMatching(/Too many/), canResend: false });
    await aMinuteLater();
    expect(screen.state.view.canResend).toBe(true);
    await act(() => screen.state.view.onResend());
    await settle();
    const [first, second] = calls("account.signin.start");
    expect(second?.id).not.toBe(first?.id);
    expect(second).not.toHaveProperty("resend");
  });

  it("repeats a new code's start whose answer was lost, instead of the dead attempt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    await submit(screen);
    await act(() => screen.state.view.onCode("000000"));
    requestOnce.mockRejectedValueOnce(new GsvRequestError(429, "Email sign-in failed.", { details: { signIn: "locked" } }));
    await submit(screen);
    await aMinuteLater();
    requestOnce.mockRejectedValueOnce(new Error("Connection interrupted"));
    await act(() => screen.state.view.onResend());
    await settle();
    await act(() => screen.state.view.onResend());
    await settle();
    const [dead, lost, retried] = calls("account.signin.start");
    expect(lost?.id).not.toBe(dead?.id);
    expect(retried).toEqual(lost);
    await act(() => screen.state.view.onCode("135790"));
    await submit(screen);
    expect(calls("account.signin.redeem").at(-1)).toMatchObject({ id: lost?.id });
  });

  it("starts over for a new code once the attempt's ten minutes are over, without trying the old code first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ship();
    stubBrowser("/chat");
    const screen = await mount();
    await act(() => screen.state.view.onEmail("owner@example.com"));
    await submit(screen);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(screen.state.view.canResend).toBe(true);
    await act(() => screen.state.view.onResend());
    await settle();
    const [expired, fresh] = calls("account.signin.start");
    expect(fresh?.id).not.toBe(expired?.id);
    expect(fresh).not.toHaveProperty("resend");
  });

  it("signs in with a password where the Ship has no email sign-in", async () => {
    ship({ emailSignIn: false });
    stubBrowser("/chat");
    const screen = await mount();
    expect(screen.state).toMatchObject({ loaded: true, available: false, method: "password" });
  });
});
