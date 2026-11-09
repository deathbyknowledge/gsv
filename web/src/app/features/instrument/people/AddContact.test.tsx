import { GSVClient, GsvClientError } from "@humansandmachines/gsv/client";
import type { ContactSummary, PublicProfile } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { AddContact } from "./AddContact";
import { emptyApproachDraft, type ApproachDraft } from "./peopleModel";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "sam", displayName: "Sam", relation: "self", runnable: false, gecos: "Sam", capabilities: ["*"] };
const MARA: ContactSummary = { id: "contact-mara", ownerUid: 1000, state: "active", generation: "1", remoteDid: "did:plc:mara",
  remoteName: "Mara", remoteHandle: "mara.ship.space", conversationId: "conversation-mara", createdAtMs: 1, updatedAtMs: 2 };
const JUNO: PublicProfile = { did: "did:plc:juno", handle: "juno.ship.space", cid: "bafyjuno", displayName: "Juno", about: "", contactPolicy: "requests", url: "https://juno.ship.space/profile" };
let tree: ComponentChildren;
let account = ACCOUNT;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;
const onChange = vi.fn();
const onOpen = vi.fn();

function Harness({ draft }: { draft: ApproachDraft }) {
  tree = AddContact({ account, draft, onChange, onSent: vi.fn(), onBusy: vi.fn(), contacts: [MARA], onOpen, onInvite: vi.fn(), onHaveInvitation: vi.fn() });
  return null;
}

/** Types `text` into Add a contact, with `resolve` answering any profile lookup. */
async function type(text: string, resolve?: () => Promise<{ data: { profile: PublicProfile } }>, blocks: Array<{ did: string; displayName: string; createdAtMs: number }> = []) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "profile.resolve" && resolve) return resolve();
    if (call === "contact.block.list") {
      const { did } = z.object({ did: z.string().optional() }).parse(args);
      return { data: { blocks: blocks.filter((block) => !did || block.did === did) } };
    }
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness draft={emptyApproachDraft(text)} /></QueryClientProvider></GatewayProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  return request;
}
const messageButton = () => collectNodes(tree).find((node) => node.type === "button" && collectText(node).startsWith("Message "));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("add contact");
  onChange.mockReset(); onOpen.mockReset(); account = ACCOUNT;
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("adding a contact", () => {
  it("offers a conversation you already have", async () => {
    await type("mara");
    expect(collectText(messageButton())).toBe("Message Mara");
    await act(async () => { await messageButton()!.props.onClick!(); });
    expect(onOpen).toHaveBeenCalledWith("contact-mara");
  });

  it("finds someone new by handle and opens a request to them", async () => {
    const request = await type("juno.ship.space", async () => ({ data: { profile: JUNO } }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("profile.resolve", { address: "https://juno.ship.space/profile" }));
    await vi.waitFor(() => expect(collectText(messageButton())).toBe("Message Juno"));
    await act(async () => { await messageButton()!.props.onClick!(); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ profile: JUNO, url: "juno.ship.space", saveContact: true }));
  });

  it("won't offer a request to someone you blocked", async () => {
    const request = await type("juno.ship.space", async () => ({ data: { profile: JUNO } }), [{ did: JUNO.did, displayName: "Old name", createdAtMs: 1 }]);
    await vi.waitFor(() => expect(collectText(tree)).toContain("You blocked this person."));
    // Checked by the found person's DID, so a block on any later page of the list still counts.
    expect(request).toHaveBeenCalledWith("contact.block.list", { did: JUNO.did });
    expect(messageButton()).toBeUndefined();
  });

  it("offers no request to an account that may not send one", async () => {
    account = { ...ACCOUNT, capabilities: ["profile.resolve", "approach.create", "contact.list", "contact.block.list"] };
    await type("juno.ship.space", async () => ({ data: { profile: JUNO } }));
    await vi.waitFor(() => expect(collectText(tree)).toContain("cannot send message requests"));
    expect(messageButton()).toBeUndefined();
  });

  it("says no public profile matches when the lookup finds none", async () => {
    await type("nobody.ship.space", async () => { throw new GsvClientError({ code: 404, message: "No public profile" }); });
    await vi.waitFor(() => expect(collectText(tree)).toContain("No public profile matches your search."));
  });
});
