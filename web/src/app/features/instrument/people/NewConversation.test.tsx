import { GSVClient } from "@humansandmachines/gsv/client";
import type { ApproachSummary, PublicProfile } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { NewConversation } from "./NewConversation";
import { emptyApproachDraft, type ApproachDraft } from "./peopleModel";

type ElementProps = {
  type?: string;
  role?: string;
  disabled?: boolean;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  children?: ComponentChildren;
};

const account: ConsoleAccount = {
  uid: 1000, username: "alice", displayName: "Alice", relation: "self", runnable: false, gecos: "",
  capabilities: ["approach.create", "profile.resolve", "contact.preferences.update"],
};
const profile: PublicProfile = {
  did: "did:plc:bobbobbobbobbobbobbobbob", handle: "bob.ship.test", cid: "bafyreiprofile", displayName: "Bob",
  about: "Hello", contactPolicy: "requests", url: "https://bob.ship.test/profile",
};
const sent: ApproachSummary = {
  id: "approach:sent", direction: "outgoing", requestId: "request:sent", peerDid: profile.did, displayName: "Bob",
  conversationId: "conv:sent", state: "preparing", revision: 1, delivery: "queued", createdAtMs: 1, updatedAtMs: 1, expiresAtMs: 2,
};
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness({ draft }: { draft: ApproachDraft }) {
  tree = NewConversation({ account, draft, onChange: () => {}, onSent: () => {}, onBusy: () => {}, contacts: [], onOpen: () => {} });
  return null;
}
function elements(type: string): Array<VNode<ElementProps>> {
  // SAFETY: these are the intrinsic elements NewConversation renders above.
  return collectNodes(tree).filter((candidate) => candidate.type === type) as Array<VNode<ElementProps>>;
}
const alerts = () => elements("p").filter((node) => node.props.role === "alert");
const sendButton = () => elements("button").find((node) => node.props.type === "submit");

async function mount(text: string) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "approach.create") return { data: { approach: sent } };
    throw new Error(`Unexpected request ${call}`);
  });
  const draft = { ...emptyApproachDraft(), profile, displayName: "Alice", text, shipHandlesMessages: false };
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness draft={draft} /></QueryClientProvider></GatewayProvider>);
  return request;
}

beforeEach(() => {
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("new conversation");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("writing a message request", () => {
  it("sends a message past 32 KiB of UTF-8 that is within the 32,768 UTF-16 code units a request carries", async () => {
    // 語 takes three UTF-8 bytes, so 20,000 of them are about 60 KB.
    const text = "語".repeat(20_000);
    const request = await mount(text);
    expect(alerts()).toEqual([]);
    expect(sendButton()?.props.disabled).toBe(false);
    await act(async () => { elements("form")[1].props.onSubmit!({ preventDefault: () => {} }); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("approach.create", expect.objectContaining({ did: profile.did, text })));
  });

  it("says a message longer than a request carries is too long", async () => {
    await mount("語".repeat(32_769));
    expect(alerts()).toHaveLength(1);
    expect(sendButton()?.props.disabled).toBe(true);
  });
});
