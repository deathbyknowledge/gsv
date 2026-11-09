import { GSVClient } from "@humansandmachines/gsv/client";
import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { SaveContactTag } from "./SaveContactTag";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "sam", displayName: "Sam", relation: "self", runnable: false, gecos: "Sam", capabilities: ["*"] };
const MARA: ContactSummary = { id: "contact-mara", ownerUid: 1000, state: "active", generation: "1", remoteDid: "did:plc:mara", remoteName: "Mara",
  remoteHandle: "mara.ship.space", conversationId: "conversation-mara", createdAtMs: 1, updatedAtMs: 2,
  preferences: { saved: false, muted: false, shipHandlesMessages: false, revision: 4 } };
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness({ account }: { account: ConsoleAccount }) { tree = SaveContactTag({ contact: MARA, account, disabled: false }); return null; }

async function mount(account = ACCOUNT) {
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness account={account} /></QueryClientProvider></GatewayProvider>);
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("save contact tag");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the not a contact tag", () => {
  it("says they aren't a contact and saves them at the revision it shows", async () => {
    const request = vi.spyOn(GSVClient.prototype, "request").mockResolvedValue({ data: { contact: MARA } });
    await mount();
    const tag = collectNodes(tree).find((node) => node.type === "button");
    expect(collectText(tag)).toContain("not a contact");
    expect(tag?.props["aria-label"]).toBe("Add Mara to your contacts");
    await act(async () => { await tag!.props.onClick!(); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("contact.preferences.update", { contactId: "contact-mara", expectedRevision: 4, patch: { saved: true } }));
  });

  it("says when saving fails and rereads the contact so a retry uses its current revision", async () => {
    const request = vi.spyOn(GSVClient.prototype, "request").mockRejectedValue(new Error("Contact preferences changed"));
    const invalidate = vi.spyOn(cache, "invalidateQueries");
    await mount();
    await act(async () => { await collectNodes(tree).find((node) => node.type === "button")!.props.onClick!(); });
    await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.props.role === "alert")).toBeDefined());
    expect(collectText(tree)).toContain("couldn’t add · try again");
    expect(request).toHaveBeenCalledWith("contact.preferences.update", expect.anything());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["instrument", "contacts"] });
  });

  it("can't save for someone who may not change contact preferences", async () => {
    await mount({ ...ACCOUNT, capabilities: ["contact.list"] });
    expect(collectNodes(tree).find((node) => node.type === "button")?.props.disabled).toBe(true);
  });
});
