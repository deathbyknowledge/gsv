import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "../../components/ui/TextInput";
import { SessionContext } from "../../services/session/SessionProvider";
import { createSessionService, type SessionClient } from "../../services/session/sessionService";
import { collectNodes, collectText, createTestRoot, type TestNodeProps } from "../../testing/testHarness";
import { AccountRecoveryScreen } from "./AccountRecoveryScreen";
import { MemberRecoveryScreen } from "./MemberRecoveryScreen";

const requestOnce = vi.fn<SessionClient["requestOnce"]>();
const client = {
  connect: vi.fn(), disconnect: vi.fn(), isConnected: () => false, requestOnce, onStatus: () => () => undefined,
  sys: { token: { create: vi.fn(), revoke: vi.fn(), list: vi.fn() } },
} satisfies SessionClient;
const url = "wss://ship.example/ws";
const session = () => {
  const service = createSessionService(client, { url });
  return { service, snapshot: { ...service.snapshot(), url } };
};

function stubBrowser(path: string) {
  let location = new URL(path, "https://ship.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    get location() { return location; },
    history: { state: null, replaceState<T>(_state: T, _unused: string, url: string) { location = new URL(url, location); } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  });
  return { get location() { return location; } };
}

const roots: ReturnType<typeof createTestRoot>[] = [];
async function mount(Screen: () => ComponentChildren, name: string) {
  const root = createTestRoot(name);
  roots.push(root);
  let tree: ComponentChildren;
  function Harness() { tree = Screen(); return null; }
  await root.render(<SessionContext.Provider value={session()}><Harness /></SessionContext.Provider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { get tree() { return tree; }, get text() { return collectText(tree); } };
}
const emailLink = (tree: ComponentChildren) => collectNodes(tree).find((node) => node.type === "a" && "data-recovery-email" in node.props);
const accountToggle = (tree: ComponentChildren) => collectNodes(tree).find((node) => "data-recovery-account" in node.props);

beforeEach(() => requestOnce.mockReset());
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.unstubAllGlobals();
});

describe("Forgot your password?", () => {
  it("leads with email through the Ship's owner page and keeps the messenger code as an alternative", async () => {
    requestOnce.mockResolvedValue({ emailUrl: "https://accounts.example/owner/recover?handle=my-ship" });
    stubBrowser("/recover-member");
    const screen = await mount(MemberRecoveryScreen, "forgot with email");
    expect(requestOnce).toHaveBeenCalledWith("wss://ship.example/ws", "account.recovery.options", {});
    expect(emailLink(screen.tree)?.props.href).toBe("https://accounts.example/owner/recover?handle=my-ship");
    expect(screen.text).toMatch(/messenger/i);
    expect(screen.text).not.toMatch(/operator/i);
    expect(screen.text).not.toContain("@");
  });

  it("says honestly what to do when email recovery is not available", async () => {
    requestOnce.mockResolvedValue({});
    stubBrowser("/recover-member");
    const screen = await mount(MemberRecoveryScreen, "forgot without email");
    expect(emailLink(screen.tree)).toBeUndefined();
    expect(screen.text).toMatch(/isn.t set up/i);
    expect(screen.text).toMatch(/messenger/i);
  });
});

describe("setting a new password from the emailed link", () => {
  const link = () => `/recover#id=${crypto.randomUUID()}&secret=${"s".repeat(43)}`;

  it("defaults to the personal password, scrubs the link and says what stops working", async () => {
    const browser = stubBrowser(link());
    const screen = await mount(AccountRecoveryScreen, "personal reset");
    expect(browser.location.hash).toBe("");
    expect(screen.text).toMatch(/signs you out/i);
    expect(screen.text).toMatch(/messenger/i);
    expect(screen.text).toMatch(/administrator password doesn.t change/i);
    expect(accountToggle(screen.tree)).toBeDefined();
  });

  it("sends the chosen account and offers the administrator when the personal account can't be reset", async () => {
    stubBrowser(link());
    requestOnce.mockRejectedValueOnce(Object.assign(new Error("failed"), { details: { recovery: "personal-unavailable" } }));
    const screen = await mount(AccountRecoveryScreen, "personal unavailable");
    // SAFETY: the screen's one TextInput takes these props.
    const field = () => collectNodes(screen.tree).find((node) => node.type === TextInput) as VNode<TestNodeProps>;
    await act(async () => { field().props.onChange?.("new-password"); });
    // SAFETY: the screen's native form owns an Event-based submit handler.
    const form = collectNodes(screen.tree).find((node) => node.type === "form") as VNode<{ onSubmit: (event: Event) => void }>;
    await act(async () => { form.props.onSubmit(new Event("submit")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(requestOnce.mock.calls[0][2]).toMatchObject({ account: "personal", password: "new-password" });
    expect(field().props.label).toMatch(/ADMINISTRATOR/);
  });
});
