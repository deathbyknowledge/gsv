import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "../../components/ui/TextInput";
import { OwnerWelcome, type PendingSetup, type WelcomeSnapshot } from "../../services/session/ownerWelcome";
import { collectNodes, collectText, createTestRoot, deferred } from "../../testing/testHarness";
import { OwnerWelcomeScreen } from "./OwnerWelcomeScreen";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://accounts.example.com";
const TOKEN = `onboard_${"a".repeat(43)}`;
type Space = { handle: string; canonicalOrigin: string; state: "active" | "restricted" };
const session = (setups: PendingSetup[] = [], spaces: Space[] = [], signupEnabled = true) =>
  Response.json({ email: "owner@example.com", expiresAt: Date.now() + 60_000, spaceDomain: "example.com", spaces, setups, signupEnabled });
const prepared = (handle: string) => Response.json({ origin: `https://${handle}.example.com`, handle, onboardingToken: TOKEN, expiresAt: Date.now() + 60_000 });
function memory(initial: WelcomeSnapshot["value"] = null) {
  let snapshot: WelcomeSnapshot = { revision: "initial", value: initial };
  return { snapshot: () => snapshot, save: async (_revision: string, value: WelcomeSnapshot["value"]) => {
    snapshot = { revision: crypto.randomUUID(), value };
    return structuredClone(snapshot);
  } };
}
// SAFETY: The screen's native form owns an Event-based submit handler.
const formOf = (tree: ComponentChildren) => collectNodes(tree).find((node) => node.type === "form") as VNode<{ onSubmit: (event: Event) => void }>;
// SAFETY: The screen's only native input is its agreement checkbox.
const checkboxOf = (tree: ComponentChildren) => collectNodes(tree).find((node) => node.type === "input") as VNode<JSX.InputHTMLAttributes<HTMLInputElement>>;
const fieldOf = (tree: ComponentChildren, label: string) => collectNodes(tree).find((node) => node.type === TextInput && node.props.label === label);
// SAFETY: The handler only reads the checkbox's checked state.
const agree = (tree: ComponentChildren) => act(() => checkboxOf(tree).props.onChange?.({ currentTarget: { checked: true } } as JSX.TargetedEvent<HTMLInputElement>));

describe("owner welcome", () => {
  it.each([false, true])("offers signup only to a friend without an existing Space (existing: %s)", async (existing) => {
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: null, handle: null, contactInvite: "friend-invitation" });
    const fetcher = vi.fn(async (_url: string) => session([], existing ? [{ handle: "friend", canonicalOrigin: "https://friend.example.com", state: "active" }] : []));
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const root = createTestRoot("Friend joins or connects");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, chooseSpace: true, initialStep: "email", load: async () => client, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectText(tree)).toContain(existing ? "Choose your Ship" : "Create your Ship"));
      if (!existing) {
        // A signed-in friend only picks a handle; the email is already verified.
        expect(fieldOf(tree, "Handle")).toBeDefined();
        expect(fieldOf(tree, "Email")).toBeUndefined();
        expect(checkboxOf(tree)).toBeDefined();
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe(`${ORIGIN}/owner/api/session`);
    } finally { await root.unmount(); }
  });

  it("chooses an existing space for a contact invitation without resuming space creation", async () => {
    const snapshot: WelcomeSnapshot = { revision: "saved", value: {
      origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: null, handle: null,
    } };
    const fetcher = vi.fn(async () => session([], [{ handle: "bob", canonicalOrigin: "https://bob.example.com", state: "active" }]));
    const save = vi.fn(async (_revision, value) => ({ revision: "saved", value }));
    const client = new OwnerWelcome(snapshot, { save }, ORIGIN, fetcher);
    const connect = vi.fn(async () => {});
    const root = createTestRoot("Choose a contact recipient space");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, chooseSpace: true, initialStep: "email", load: async () => client,
        onConnect: connect, invitation: { name: "Alice", origin: "alice.example.com" }, compact: true });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")?.props.disabled).toBe(false));
      expect(collectText(tree)).toMatch(/Alice\s+invited you to Ship/);
      expect(collectText(tree)).toContain("alice.example.com");
      expect(fetcher).not.toHaveBeenCalled();
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(collectNodes(tree).some((node) => node.props.label === "bob")).toBe(true));
      expect(collectText(tree)).toContain("Choose your Ship");
      await act(() => { collectNodes(tree).find((node) => node.props.label === "bob")!.props.onClick?.(); });
      expect(connect).toHaveBeenCalledWith("https://bob.example.com");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalled();
    } finally { await root.unmount(); }
  });

  it.each([false, true])("shows the invitation before signup and preserves it when switching accounts (friend: %s)", async (friend) => {
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: null, handle: null, contactInvite: friend ? "friend-invitation" : null });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/logout")) return Response.json({ ok: true });
      if (url.endsWith("/session")) return session([], friend ? [{ handle: "friend", canonicalOrigin: "https://friend.example.com", state: "active" }] : []);
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const connect = vi.fn();
    const root = createTestRoot("Invitation account switching");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, chooseSpace: friend, invitation: friend ? { name: "Alice" } : {}, compact: true, initialStep: "email", load: async () => client, onConnect: connect,
        addressPanel: () => <p>Address form</p> });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")?.props.disabled).toBe(false));
      expect(collectText(tree)).toMatch(friend ? /Alice\s+invited you to Ship/ : /You’re invited to Ship/);
      expect(fetcher).not.toHaveBeenCalled();
      expect(collectNodes(tree).some((node) => node.type === TextInput)).toBe(false);
      expect(collectText(tree)).not.toContain("Address form");

      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(collectText(tree)).toContain(friend ? "Choose your Ship" : "Create your Ship"));
      if (friend) {
        const disclosure = collectNodes(tree).find((node) => node.type === "details");
        expect(disclosure?.props).not.toHaveProperty("open", true);
        expect(collectText(disclosure)).toContain("Use a handle or address");
      }
      await act(() => { collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "Sign out")?.props.onClick?.(); });
      await vi.waitFor(() => expect(client.state.sessionSecret).toBeNull());
      expect(client.state.contactInvite ?? null).toBe(friend ? "friend-invitation" : null);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      // Signed out, a friend signs in first; anyone else claims a handle and enters their email together.
      await vi.waitFor(() => expect(fieldOf(tree, "Email")).toBeDefined());
      expect(fieldOf(tree, "Handle") !== undefined).toBe(!friend);
      if (!friend) expect(checkboxOf(tree)?.props).toMatchObject({ checked: false });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${ORIGIN}/owner/api/session`, `${ORIGIN}/owner/api/logout`]);
      expect(connect).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });

  it.each([false, true])("claims a handle with agreement before sending the signup email (resumed: %s)", async (resumed) => {
    const store = memory(resumed ? { origin: ORIGIN, flow: "create", sessionSecret: null, challenge: null, operationId: null, handle: null } : null);
    const fetcher = vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      if (url.includes("/handle?")) { expect(init.headers.authorization).toBeUndefined(); return Response.json({ available: true }); }
      if (url.endsWith("/code")) return Response.json({ deliveryStatus: "sent" });
      if (url.endsWith("/verify")) return Response.json({ email: "owner@example.com", expiresAt: Date.now() + 60_000 });
      if (url.endsWith("/session")) return session();
      if (url.endsWith("/spaces")) {
        expect(init.headers.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
        expect(JSON.parse(init.body!)).toEqual({ operationId: store.snapshot().value!.operationId, handle: "spacecowboy" });
        return prepared("spacecowboy");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn(async () => {});
    const root = createTestRoot("Owner signup agreement");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: resumed, initialStep: "welcome", spaceDomain: "example.com", load: async () => client, onConnect });
      return null;
    }
    const submit = () => collectNodes(tree).find((node) => node.type === "button" && ["Continue", "Confirm"].includes(String(node.props["aria-label"])))!;
    try {
      await root.render(<Harness />);
      if (!resumed) {
        await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Create your Ship")?.props.disabled).toBe(false));
        expect(collectText(tree)).not.toContain("invite");
        await act(() => { collectNodes(tree).find((node) => node.props["aria-label"] === "Create your Ship")!.props.onClick?.(); });
      }
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      expect(collectText(tree)).toContain("Create your Ship");
      expect(fieldOf(tree, "Handle")!.props).toMatchObject({ prefix: "@" });
      expect(fieldOf(tree, "Handle")!.props).not.toHaveProperty("suffix");
      expect(collectText(tree)).toMatch(/Handle or address\s+your-name\s*\.\s*example\.com/);
      expect(submit().props["aria-label"]).toBe("Continue");
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("SpaceCowboy"); });
      expect(fieldOf(tree, "Handle")!.props.value).toBe("spacecowboy");
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props).toMatchObject({ status: "success", message: "Available" }));
      await act(() => { fieldOf(tree, "Email")!.props.onChange?.("Owner@Example.com"); });
      expect(checkboxOf(tree).props).toMatchObject({ required: true, checked: false });
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      expect(fetcher.mock.calls.some(([url]) => url.endsWith("/code"))).toBe(false);
      expect(checkboxOf(tree).props["aria-invalid"]).toBe(true);
      expect(collectText(tree)).toContain("Confirm your age and agreement to continue.");

      await agree(tree);
      expect(checkboxOf(tree).props["aria-invalid"]).toBeUndefined();
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(fieldOf(tree, "Code")).toBeDefined());
      expect(store.snapshot().value).toMatchObject({ flow: "create", handle: "spacecowboy", challenge: { email: "owner@example.com" } });
      expect(store.snapshot().value!.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(collectText(tree)).toContain("Check your email");
      expect(collectText(tree)).toMatch(/Enter the code sent to\s+owner@example\.com/);
      expect(checkboxOf(tree)).toBeUndefined();
      expect(submit().props["aria-label"]).toBe("Confirm");
      await act(() => { fieldOf(tree, "Code")!.props.onChange?.("123456"); });
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledExactlyOnceWith("https://spacecowboy.example.com", TOKEN));
      expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname).filter((path) => !path.endsWith("/handle"))).toEqual([
        "/owner/api/code", "/owner/api/verify", "/owner/api/session", "/owner/api/spaces",
      ]);
    } finally { await root.unmount(); }
  });

  it("treats an availability check Accounts will not answer yet as unchecked", async () => {
    const store = memory();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/handle?")) return Response.json({ error: "Sign in to continue.", code: "signed_out" }, { status: 401 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const root = createTestRoot("Owner signup availability");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, initialStep: "claim", load: async () => client, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Handle")!.props).not.toHaveProperty("suffix", expect.any(String));
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("spacecowboy"); });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(fieldOf(tree, "Handle")!.props).toMatchObject({ status: "none", message: "" });
      expect(collectText(tree)).not.toContain("Sign in to continue.");
    } finally { await root.unmount(); }
  });

  it.each(["network", "server", "rate limit"])("can submit after an advisory availability %s failure", async (failure) => {
    const store = memory();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/handle?")) {
        if (failure === "network") throw new TypeError("Network unavailable");
        return Response.json({ error: "Try again shortly." }, { status: failure === "server" ? 503 : 429 });
      }
      if (url.endsWith("/code")) return Response.json({ deliveryStatus: "sent" });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const root = createTestRoot("Advisory availability failure");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, initialStep: "claim", load: async () => client, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("valid-handle"); });
      await act(() => { fieldOf(tree, "Email")!.props.onChange?.("owner@example.com"); });
      await agree(tree);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(fieldOf(tree, "Handle")!.props).toMatchObject({ status: "none", message: "" });
      expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!.props.disabled).toBe(false);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(fieldOf(tree, "Code")).toBeDefined());
      expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/owner/api/code`, expect.anything());
    } finally { await root.unmount(); }
  });

  it("returns to the handle when Accounts rejects it at creation", async () => {
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: "op_taken", handle: "taken" });
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/handle?")) return Response.json({ available: true });
      if (url.endsWith("/session")) return session();
      if (url.endsWith("/spaces")) return Response.json({ error: "handle is unavailable" }, { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn();
    const root = createTestRoot("Owner signup handle conflict");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect });
      return null;
    }
    try {
      await root.render(<Harness />);
      // Restoring a session does not imply agreement: the claim step returns with the saved handle.
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Handle")!.props.value).toBe("taken");
      expect(fieldOf(tree, "Email")).toBeUndefined();
      expect(fetcher.mock.calls.some(([url]) => url.endsWith("/spaces"))).toBe(false);
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props.status).toBe("success"));
      await agree(tree);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props).toMatchObject({ status: "error", message: "handle is unavailable" }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
      expect(fieldOf(tree, "Handle")!.props).toMatchObject({ status: "error", message: "handle is unavailable" });
      expect(store.snapshot().value!.operationId).toBe("op_taken");
      expect(onConnect).not.toHaveBeenCalled();
      expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!.props.disabled).toBe(true);
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("taken-again"); });
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props.status).toBe("success"));
      expect(fieldOf(tree, "Handle")!.props.message).toBe("Available");
    } finally { await root.unmount(); }
  });

  it("retries a failed creation from the claim step under the same operation", async () => {
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), operationId: "op_retry", handle: "my-space",
      challenge: { id: crypto.randomUUID(), email: "owner@example.com", browserSecret: "b".repeat(64) } });
    let attempts = 0;
    let verified = false;
    const fetcher = vi.fn(async (url: string, init: { body?: string }) => {
      if (url.endsWith("/verify")) { verified = true; return Response.json({ email: "owner@example.com", expiresAt: Date.now() + 60_000 }); }
      if (url.endsWith("/session")) return verified ? session() : Response.json({ error: "Sign in to continue.", code: "signed_out" }, { status: 401 });
      if (url.includes("/handle?")) return Response.json({ available: true });
      if (url.endsWith("/spaces")) {
        expect(JSON.parse(init.body!)).toEqual({ operationId: "op_retry", handle: "my-space" });
        return ++attempts === 1 ? Response.json({ error: "Ship setup is unavailable. Try again." }, { status: 400 }) : prepared("my-space");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn();
    const root = createTestRoot("Owner creation retry");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(fieldOf(tree, "Code")?.props.disabled).toBe(false));
      await act(() => { fieldOf(tree, "Code")!.props.onChange?.("123456"); });
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      // Restoring the session requires agreement again; the claim step comes back with the handle.
      await vi.waitFor(() => expect(checkboxOf(tree)?.props.disabled).toBe(false));
      await agree(tree);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(collectText(tree)).toContain("Ship setup is unavailable. Try again."));
      expect(fieldOf(tree, "Handle")!.props.value).toBe("my-space");
      expect(fieldOf(tree, "Code")).toBeUndefined();
      expect(onConnect).not.toHaveBeenCalled();
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledExactlyOnceWith("https://my-space.example.com", TOKEN));
      expect(attempts).toBe(2);
    } finally { await root.unmount(); }
  });

  it.each([false, true])("retries opening a completed signup after Desktop connection fails (session lookup fails: %s)", async (lookupFails) => {
    const setup = { operationId: "completed-setup", handle: "my-ship", origin: "https://my-ship.example.com" };
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: setup.operationId, handle: setup.handle });
    let completed = false;
    let failedLookup = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/session")) {
        if (!completed) return session([setup]);
        if (lookupFails && !failedLookup) { failedLookup = true; throw new Error("Session unavailable"); }
        return session([], [{ handle: setup.handle, canonicalOrigin: setup.origin, state: "active" }]);
      }
      if (url.endsWith("/spaces")) {
        completed = true;
        return Response.json({ handle: setup.handle, origin: setup.origin, onboardingToken: null, expiresAt: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn().mockRejectedValueOnce(new Error("Could not open Ship.")).mockResolvedValue(undefined);
    const root = createTestRoot("Completed signup connection retry");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(checkboxOf(tree)?.props.disabled).toBe(false));
      await agree(tree);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(client.state.flow).toBe("open"));
      if (lookupFails) {
        await vi.waitFor(() => expect(collectNodes(tree).find((node) => collectText(node) === "Retry")?.props.disabled).toBe(false));
        await act(() => { collectNodes(tree).find((node) => collectText(node) === "Retry")!.props.onClick?.(); });
      }
      const open = () => collectNodes(tree).find((node) => node.props.label === setup.handle);
      await vi.waitFor(() => expect(open()?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Handle")).toBeUndefined();
      expect(client.state.operationId).toBeNull();
      await act(() => { open()!.props.onClick?.(); });
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
      expect(onConnect.mock.calls).toEqual([[setup.origin, null], [setup.origin]]);
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/spaces"))).toHaveLength(1);
      expect(fetcher.mock.calls.some(([url]) => url.includes("/handle?"))).toBe(false);
    } finally { await root.unmount(); }
  });

  it.each([
    { failure: "policy", conflict: false },
    { failure: "network", conflict: false },
    { failure: "network", conflict: true },
  ])("retries fresh signup after a $failure failure and honors an authoritative conflict ($conflict)", async ({ failure, conflict }) => {
    const store = memory();
    let verified = false;
    let attempts = 0;
    let rechecks = 0;
    const allocations: string[] = [];
    const fetcher = vi.fn(async (url: string, init: { body?: string }) => {
      if (url.endsWith("/code")) return Response.json({ deliveryStatus: "sent" });
      if (url.endsWith("/verify")) { verified = true; return Response.json({ email: "owner@example.com", expiresAt: Date.now() + 60_000 }); }
      if (url.endsWith("/session")) {
        // The initial session predates allocation; another lookup could fail too and must not be needed to retry.
        if (attempts) throw new TypeError("Session lookup unavailable");
        return session();
      }
      if (url.includes("/handle?")) {
        if (!verified) return Response.json({ error: "Sign in to continue.", code: "signed_out" }, { status: 401 });
        if (attempts) rechecks++;
        return Response.json({ available: !attempts });
      }
      if (url.endsWith("/spaces")) {
        allocations.push(init.body!);
        if (++attempts === 1) {
          if (failure === "network") throw new TypeError("Lost creation response");
          return Response.json({ error: "Ship setup failed. Try again. Reference: test-failure" }, { status: 400 });
        }
        return conflict ? Response.json({ error: "handle is unavailable" }, { status: 400 }) : prepared("my-space");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn();
    const root = createTestRoot("Fresh signup creation retry");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, initialStep: "claim", load: async () => client, onConnect });
      return null;
    }
    const submit = () => collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!;
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("my-space"); });
      await act(() => { fieldOf(tree, "Email")!.props.onChange?.("owner@example.com"); });
      await agree(tree);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(fieldOf(tree, "Code")).toBeDefined());
      const operationId = client.state.operationId;
      await act(() => { fieldOf(tree, "Code")!.props.onChange?.("123456"); });
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(rechecks).toBeGreaterThan(0));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(fieldOf(tree, "Code")).toBeUndefined();
      expect(fieldOf(tree, "Handle")!.props).toMatchObject({ value: "my-space", status: "none", message: "" });
      expect(submit().props.disabled).toBe(false);

      // The exception belongs to this operation and handle, not to another handle the owner types.
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("another-taken-handle"); });
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props.message).toBe("Already taken"));
      expect(submit().props.disabled).toBe(true);
      await act(() => { fieldOf(tree, "Handle")!.props.onChange?.("my-space"); });
      await vi.waitFor(() => expect(rechecks).toBeGreaterThan(2));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(submit().props.disabled).toBe(false);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(attempts).toBe(2));
      expect(allocations).toEqual(Array(2).fill(JSON.stringify({ operationId, handle: "my-space" })));
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/session"))).toHaveLength(1);
      if (conflict) {
        await vi.waitFor(() => expect(fieldOf(tree, "Handle")!.props.message).toBe("handle is unavailable"));
        expect(submit().props.disabled).toBe(true);
        expect(onConnect).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledExactlyOnceWith("https://my-space.example.com", TOKEN));
      }
    } finally { await root.unmount(); }
  });

  it.each([false, true])("requires agreement before resuming setup (saved locally: %s)", async (saved) => {
    const setup: PendingSetup = { operationId: "existing-setup", handle: "my-space", origin: "https://my-space.example.com" };
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: saved ? setup.operationId : null, handle: null });
    const fetcher = vi.fn(async (url: string) => url.endsWith("/session") ? session([setup])
      : url.includes("/handle?") ? Response.json({ available: false }) : prepared(setup.handle));
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const onConnect = vi.fn();
    const root = createTestRoot("Resume setup");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect });
      return null;
    }
    try {
      await root.render(<Harness />);
      if (!saved) {
        await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props.label === "Continue my-space")?.props.disabled).toBe(false));
        await act(() => { collectNodes(tree).find((node) => node.props.label === "Continue my-space")!.props.onClick?.(); });
      }
      await vi.waitFor(() => expect(checkboxOf(tree)?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Handle")!.props.value).toBe("my-space");
      // The handle is reserved for this very setup, so it is not checked against the public availability.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
      expect(fieldOf(tree, "Handle")!.props.status).toBe("success");
      expect(fetcher.mock.calls.some(([url]) => url.includes("/handle?"))).toBe(false);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      expect(fetcher.mock.calls.every(([url]) => url.endsWith("/session"))).toBe(true);
      expect(onConnect).not.toHaveBeenCalled();
      await agree(tree);
      expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!.props.disabled).toBe(false);
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith(setup.origin, TOKEN));
      expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/owner/api/spaces`, expect.objectContaining({ body: JSON.stringify({ operationId: setup.operationId, handle: setup.handle }) }));
    } finally { await root.unmount(); }
  });

  it("does not require a signup agreement to sign in to an existing owner account", async () => {
    const store = memory();
    const fetcher = vi.fn(async () => Response.json({ deliveryStatus: "sent" }));
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const root = createTestRoot("Owner sign-in");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(fieldOf(tree, "Email")?.props.disabled).toBe(false));
      expect(collectNodes(tree).some((node) => node.type === "input")).toBe(false);
      await act(() => { fieldOf(tree, "Email")!.props.onChange?.("owner@example.com"); });
      await act(() => formOf(tree).props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    } finally { await root.unmount(); }
  });

  it("keeps sign-in recovery available through direct address and Back after loading fails", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const load = vi.fn(async () => { throw new Error("Storage unavailable"); });
    const onConnect = vi.fn(async () => { throw new Error("Offline"); });
    const addressPanel = vi.fn(({ disabled, connect }: { disabled: boolean; connect(origin: string): Promise<void> }) =>
      <button type="button" disabled={disabled} onClick={() => connect("https://custom.example.com")}>Direct address</button>);
    const root = createTestRoot("Owner welcome load recovery");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, load, onConnect, addressPanel });
      return null;
    }
    const button = (label: string) => collectNodes(tree).find((node) => node.type === "button"
      && (node.props["aria-label"] === label || collectText(node) === label))!;
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectText(tree)).toContain("Could not load sign-in"));
      await act(() => { button("Open Ship").props.onClick?.(); });
      expect(button("Retry")).toBeDefined();
      expect(collectText(tree)).toContain("Could not load sign-in");
      await act(async () => { await addressPanel.mock.lastCall![0].connect("https://custom.example.com"); });
      expect(onConnect).toHaveBeenCalledExactlyOnceWith("https://custom.example.com");
      expect(button("Retry")).toBeDefined();
      await act(() => { button("Back").props.onClick?.(); });
      expect(collectText(tree)).toContain("Could not load sign-in");
      await act(() => { button("Retry").props.onClick?.(); });
      expect(reload).toHaveBeenCalledOnce();
    } finally { await root.unmount(); }
  });

  it("shows direct-address recovery inside a compact invitation when signup storage fails", async () => {
    const root = createTestRoot("Invitation storage recovery");
    const onConnect = vi.fn(async () => {});
    const addressPanel = vi.fn(({ disabled }: { disabled: boolean }) => <button disabled={disabled}>Direct address</button>);
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, compact: true, invitation: { name: "Sponsor" },
        load: async () => { throw new Error("Storage unavailable"); }, addressPanel, onConnect });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectText(tree)).toContain("Could not load sign-in"));
      expect(collectText(tree)).toMatch(/Sponsor\s+invited you to Ship/);
      expect(collectText(tree)).toContain("Use a handle or address");
      expect(addressPanel.mock.lastCall![0].disabled).toBe(false);
      expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!.props.disabled).toBe(true);
    } finally { await root.unmount(); }
  });

  it("prefers the signed-in space domain and reports handle rules beside the field", async () => {
    const store = memory({ origin: ORIGIN, flow: "create", sessionSecret: "a".repeat(64), challenge: null, operationId: null, handle: null });
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/handle?")) return url.includes("not_a_handle")
        ? Response.json({ error: "Use letters, numbers or hyphens." }, { status: 400 })
        : Response.json({ available: true });
      return session();
    });
    const load = async () => new OwnerWelcome(store.snapshot(), { save: async (revision, value) => {
      expect(revision).toBe(store.snapshot().revision);
      return store.save(revision, value);
    } }, ORIGIN, fetcher);
    const root = createTestRoot("Owner welcome");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, spaceDomain: "presumed.example", load, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      const field = () => fieldOf(tree, "Handle")!;
      await vi.waitFor(() => expect(field()?.props.disabled).toBe(false));
      expect(collectText(tree)).toMatch(/Handle or address\s+your-name\s*\.\s*example\.com/);
      expect(collectText(tree)).not.toContain("presumed.example");
      expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/owner/api/session`, expect.objectContaining({ method: "GET" }));
      await act(() => { field().props.onChange?.("Xamenace"); });
      expect(field().props.value).toBe("xamenace");
      await vi.waitFor(() => expect(field().props.status).toBe("success"));
      expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/owner/api/handle?value=xamenace`, expect.anything());
      await act(() => { field().props.onChange?.("not_a_handle"); });
      await vi.waitFor(() => expect(field().props).toMatchObject({ status: "error", message: "Use letters, numbers or hyphens." }));
      expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Continue")!.props.disabled).toBe(true);
      await act(() => { field().props.onChange?.("a-valid-handle"); });
      expect(field().props.message).toBe("");
      await vi.waitFor(() => expect(field().props.status).toBe("success"));
      // Desktop renders this screen too; the beta app link belongs to the browser signup entry alone.
      expect(collectNodes(tree).some((node) => node.type === "a")).toBe(false);
    } finally { await root.unmount(); }
  });

  it("leaves a completed signup at the welcome screen after a disconnect", async () => {
    const snapshot: WelcomeSnapshot = { revision: "completed", value: {
      origin: ORIGIN, flow: "open", sessionSecret: "a".repeat(64), challenge: null, operationId: null, handle: null,
    } };
    const fetcher = vi.fn<typeof fetch>();
    const onConnect = vi.fn();
    const root = createTestRoot("Owner welcome after disconnect");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, onConnect,
        load: async () => new OwnerWelcome(snapshot, { save: vi.fn() }, ORIGIN, fetcher) });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Open Ship")?.props.disabled).toBe(false));
      expect(fetcher).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });

  it("starts with two choices, then offers email and direct address together", async () => {
    const store = memory();
    const fetcher = vi.fn<typeof fetch>();
    const connection = deferred<void>();
    const onConnect = vi.fn(() => connection.promise);
    const addressPanel = vi.fn(({ disabled, connect }: { disabled: boolean; connect(origin: string): Promise<void> }) =>
      <button type="button" disabled={disabled} onClick={() => connect("https://custom.example.com")}>Direct address</button>);
    const client = new OwnerWelcome(store.snapshot(), store, ORIGIN, fetcher);
    const root = createTestRoot("Owner welcome choices");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, load: async () => client, onConnect, addressPanel });
      return null;
    }
    try {
      await root.render(<Harness />);
      const choice = (label: string) => collectNodes(tree).find((node) => node.props["aria-label"] === label)!;
      await vi.waitFor(() => expect(choice("Create your Ship")?.props.disabled).toBe(false));
      expect(choice("Open Ship")).toBeDefined();
      expect(addressPanel).not.toHaveBeenCalled();
      expect(collectNodes(tree).some((node) => node.type === TextInput)).toBe(false);

      await act(() => { choice("Create your Ship").props.onClick?.(); });
      await vi.waitFor(() => expect(fieldOf(tree, "Handle")?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Email")).toBeDefined();
      expect(addressPanel).not.toHaveBeenCalled();
      await act(() => { collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "Back")?.props.onClick?.(); });
      await act(() => { choice("Open Ship").props.onClick?.(); });
      await vi.waitFor(() => expect(fieldOf(tree, "Email")?.props.disabled).toBe(false));
      expect(fieldOf(tree, "Handle")).toBeUndefined();
      expect(collectText(tree)).toContain("Sign in with email");
      expect(collectText(tree)).toContain("Enter a handle or address");
      expect(addressPanel).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false }));
      expect(fetcher).not.toHaveBeenCalled();

      let connected: Promise<void>;
      await act(() => { connected = addressPanel.mock.lastCall![0].connect("https://custom.example.com"); });
      expect(addressPanel).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }));
      await addressPanel.mock.lastCall![0].connect("https://other.example.com");
      expect(onConnect).toHaveBeenCalledExactlyOnceWith("https://custom.example.com");
      await act(async () => { connection.resolve(); await connected; });
      expect(addressPanel).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false }));
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });
});
