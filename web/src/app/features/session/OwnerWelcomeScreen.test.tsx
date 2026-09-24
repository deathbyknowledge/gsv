import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "../../components/ui/TextInput";
import { OwnerWelcome, type WelcomeSnapshot } from "../../services/session/ownerWelcome";
import { collectNodes, createTestRoot } from "../../testing/testHarness";
import { OwnerWelcomeScreen } from "./OwnerWelcomeScreen";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("owner welcome", () => {
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
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props.label === "Open your space")?.props.disabled).toBe(false));
      expect(fetcher).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
  });
});
