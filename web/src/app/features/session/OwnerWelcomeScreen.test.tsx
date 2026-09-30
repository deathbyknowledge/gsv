import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "../../components/ui/TextInput";
import { OwnerWelcome, type WelcomeSnapshot } from "../../services/session/ownerWelcome";
import { collectNodes, collectText, createTestRoot, deferred } from "../../testing/testHarness";
import { OwnerWelcomeScreen } from "./OwnerWelcomeScreen";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("owner welcome", () => {
  it.each([false, true])("requires agreement before sending a signup email (resumed: %s)", async (resumed) => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: resumed ? {
      origin: "https://accounts.example.com", flow: "create", sessionSecret: null,
      challenge: null, inviteCode: "invite_fixture", inviteId: null, handle: null,
    } : null };
    const fetcher = vi.fn(async () => Response.json({ deliveryStatus: "sent" }));
    const client = new OwnerWelcome(snapshot, { save: async (_revision, value) => {
      snapshot = { revision: crypto.randomUUID(), value };
      return structuredClone(snapshot);
    } }, "https://accounts.example.com", fetcher);
    const root = createTestRoot("Owner signup agreement");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, initialStep: "invite", load: async () => client, onConnect: vi.fn() });
      return null;
    }
    // SAFETY: The screen's native form owns an Event-based submit handler.
    const form = () => collectNodes(tree).find((node) => node.type === "form") as VNode<{ onSubmit: (event: Event) => void }>;
    // SAFETY: The screen's only native input is its agreement checkbox.
    const checkbox = () => collectNodes(tree).find((node) => node.type === "input") as VNode<JSX.InputHTMLAttributes<HTMLInputElement>>;
    const field = (label: string) => collectNodes(tree).find((node) => node.type === TextInput && node.props.label === label)!;
    try {
      await root.render(<Harness />);
      if (!resumed) {
        await vi.waitFor(() => expect(field("Invite code")?.props.disabled).toBe(false));
        await act(() => { field("Invite code").props.onChange?.("invite_fixture"); });
        await act(() => form().props.onSubmit(new Event("submit")));
      }
      await vi.waitFor(() => expect(field("Email")?.props.disabled).toBe(false));
      await act(() => { field("Email").props.onChange?.("owner@example.com"); });
      expect(checkbox().props.required).toBe(true);
      expect(checkbox().props.checked).toBe(false);
      await act(() => form().props.onSubmit(new Event("submit")));
      expect(fetcher).not.toHaveBeenCalled();
      expect(checkbox().props["aria-invalid"]).toBe(true);
      expect(collectText(tree)).toContain("Confirm your age and agreement to continue.");

      // SAFETY: The handler only reads the checkbox's checked state.
      await act(() => checkbox().props.onChange?.({ currentTarget: { checked: true } } as JSX.TargetedEvent<HTMLInputElement>));
      expect(checkbox().props["aria-invalid"]).toBeUndefined();
      await act(() => form().props.onSubmit(new Event("submit")));
      await vi.waitFor(() => expect(field("Code")).toBeDefined());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://accounts.example.com/owner/api/code", expect.objectContaining({ method: "POST" }));
    } finally { await root.unmount(); }
  });

  it("does not require a signup agreement to sign in to an existing owner account", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const fetcher = vi.fn(async () => Response.json({ deliveryStatus: "sent" }));
    const client = new OwnerWelcome(snapshot, { save: async (_revision, value) => {
      snapshot = { revision: crypto.randomUUID(), value };
      return structuredClone(snapshot);
    } }, "https://accounts.example.com", fetcher);
    const root = createTestRoot("Owner sign-in");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load: async () => client, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      const email = () => collectNodes(tree).find((node) => node.type === TextInput && node.props.label === "Email");
      await vi.waitFor(() => expect(email()?.props.disabled).toBe(false));
      expect(collectNodes(tree).some((node) => node.type === "input")).toBe(false);
      await act(() => { email()!.props.onChange?.("owner@example.com"); });
      // SAFETY: The screen's native form owns an Event-based submit handler.
      const form = collectNodes(tree).find((node) => node.type === "form") as VNode<{ onSubmit: (event: Event) => void }>;
      await act(() => form.props.onSubmit(new Event("submit")));
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
      await act(() => { button("Open your space").props.onClick?.(); });
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

  it("previews the configured space domain when Accounts uses a separate hostname", async () => {
    const invite = { id: "invite_fixture", state: "claimed", handle: null, origin: null, lastError: null };
    let snapshot: WelcomeSnapshot = { revision: "initial", value: {
      origin: "https://accounts.example.com", flow: "create", sessionSecret: "a".repeat(64),
      challenge: null, inviteCode: null, inviteId: invite.id, handle: null,
    } };
    const fetcher = vi.fn(async () => Response.json({ email: "owner@example.com", expiresAt: Date.now() + 60_000,
      spaceDomain: "example.com", spaces: [], invites: [invite] }));
    const load = async () => new OwnerWelcome(snapshot, { save: async (revision, value) => {
      expect(revision).toBe(snapshot.revision);
      snapshot = { revision: crypto.randomUUID(), value };
      return structuredClone(snapshot);
    } }, "https://accounts.example.com", fetcher);
    const root = createTestRoot("Owner welcome");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: true, load, onConnect: vi.fn() });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.type === TextInput && node.props.label === "Handle")?.props)
        .toMatchObject({ suffix: ".example.com" }));
      expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://accounts.example.com/owner/api/session", expect.objectContaining({ method: "GET" }));
      // Desktop renders this screen too; the beta app link belongs to the browser signup entry alone.
      expect(collectNodes(tree).some((node) => node.type === "a")).toBe(false);
    } finally { await root.unmount(); }
  });

  it("leaves a completed signup at the welcome screen after a disconnect", async () => {
    const snapshot: WelcomeSnapshot = { revision: "completed", value: {
      origin: "https://accounts.example.com", flow: "open", sessionSecret: "a".repeat(64),
      challenge: null, inviteCode: null, inviteId: null, handle: null,
    } };
    const fetcher = vi.fn<typeof fetch>();
    const onConnect = vi.fn();
    const root = createTestRoot("Owner welcome after disconnect");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, onConnect,
        load: async () => new OwnerWelcome(snapshot, { save: vi.fn() }, "https://accounts.example.com", fetcher) });
      return null;
    }
    try {
      await root.render(<Harness />);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props["aria-label"] === "Open your space")?.props.disabled).toBe(false));
      expect(fetcher).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });

  it("starts with two choices, then offers email and direct address together", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const fetcher = vi.fn<typeof fetch>();
    const connection = deferred<void>();
    const onConnect = vi.fn(() => connection.promise);
    const addressPanel = vi.fn(({ disabled, connect }: { disabled: boolean; connect(origin: string): Promise<void> }) =>
      <button type="button" disabled={disabled} onClick={() => connect("https://custom.example.com")}>Direct address</button>);
    const client = new OwnerWelcome(snapshot, { save: async (_revision, value) => {
      snapshot = { revision: crypto.randomUUID(), value };
      return structuredClone(snapshot);
    } }, "https://accounts.example.com", fetcher);
    const root = createTestRoot("Owner welcome choices");
    let tree: ComponentChildren;
    function Harness() {
      tree = OwnerWelcomeScreen({ ready: true, resume: false, load: async () => client, onConnect, addressPanel });
      return null;
    }
    try {
      await root.render(<Harness />);
      const choice = (label: string) => collectNodes(tree).find((node) => node.props["aria-label"] === label)!;
      await vi.waitFor(() => expect(choice("Create your space")?.props.disabled).toBe(false));
      expect(choice("Open your space")).toBeDefined();
      expect(addressPanel).not.toHaveBeenCalled();
      expect(collectNodes(tree).some((node) => node.type === TextInput)).toBe(false);

      await act(() => { choice("Create your space").props.onClick?.(); });
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.type === TextInput && node.props.label === "Invite code")?.props.disabled).toBe(false));
      expect(addressPanel).not.toHaveBeenCalled();
      await act(() => { collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "Back")?.props.onClick?.(); });
      await act(() => { choice("Open your space").props.onClick?.(); });
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.type === TextInput && node.props.label === "Email")?.props.disabled).toBe(false));
      expect(collectText(tree)).toContain("Sign in with email");
      expect(collectText(tree)).toContain("Enter a space address");
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
