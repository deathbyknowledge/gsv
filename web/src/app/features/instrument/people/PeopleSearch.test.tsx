import { GSVClient, GsvClientError } from "@humansandmachines/gsv/client";
import type { ApproachListResult, ApproachSummary, ContactSummary, PublicProfile } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { ContactRow, RequestRow } from "./PeopleRows";
import { PeopleSearch } from "./PeopleSearch";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "sam", displayName: "Sam", relation: "self", runnable: false, gecos: "Sam", capabilities: ["*"] };
const contact = (id: string, name: string, handle: string, did: string): ContactSummary => ({ id, ownerUid: 1000, state: "active", generation: "1", remoteDid: did,
  remoteName: name, remoteHandle: handle, conversationId: `conversation-${id}`, createdAtMs: 1, updatedAtMs: 2 });
const MARA = contact("contact-mara", "Mara", "mara.ship.space", "did:plc:mara");
const pending = (id: string, direction: ApproachSummary["direction"], displayName: string): ApproachSummary => ({ id, direction, requestId: id, peerDid: `did:plc:${id}`,
  displayName, conversationId: `approach:${id}`, state: "pending", revision: 1, delivery: "received", createdAtMs: 10, updatedAtMs: 10, expiresAtMs: 99 });
const JUNO: PublicProfile = { did: "did:plc:juno", handle: "juno.ship.space", cid: "bafyjuno", displayName: "Juno", about: "", contactPolicy: "requests", url: "https://juno.ship.space/profile" };
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;
const onCompose = vi.fn();

function Harness({ query, contactsLoaded }: { query: string; contactsLoaded: boolean }) {
  tree = PeopleSearch({ account: ACCOUNT, query, contacts: [MARA], contactsLoaded, contactsError: null, inbox: new Map(), busy: false, selectedContactId: null, selectedRequestId: null,
    shipTakenDown: false, onOpenContact: vi.fn(), onOpenRequest: vi.fn(), onCompose });
  return null;
}

/** Searches for `query` against Mara's conversation and the given pending requests and lookup answer. */
async function search(query: string, { incoming = [[]], outgoing = [[]], blocks = [], resolve, contactsLoaded = true }: { incoming?: ApproachSummary[][]; outgoing?: ApproachSummary[][]; blocks?: Array<{ did: string; displayName: string; createdAtMs: number }>; resolve?: () => Promise<{ data: { profile: PublicProfile } }>; contactsLoaded?: boolean } = {}) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "approach.list") {
      const { direction, before } = z.object({ direction: z.enum(["incoming", "outgoing"]), before: z.object({ id: z.string() }).optional() }).parse(args);
      const pages = direction === "incoming" ? incoming : outgoing;
      const index = before ? Number(before.id) : 0;
      const page: ApproachListResult = { approaches: pages[index] };
      if (index + 1 < pages.length) page.next = { createdAtMs: 1, id: String(index + 1) };
      return { data: page };
    }
    if (call === "contact.block.list") return { data: { blocks } };
    if (call === "profile.resolve" && resolve) return resolve();
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness query={query} contactsLoaded={contactsLoaded} /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  await act(async () => {});
  return request;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("people search");
  onCompose.mockReset();
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("searching People", () => {
  it("finds a conversation by name without looking anyone up", async () => {
    const request = await search("mara");
    expect(collectText(tree)).toContain("Conversations");
    expect(collectNodes(tree).filter((node) => node.type === ContactRow).map((node) => node.key)).toEqual(["contact-mara"]);
    expect(request).not.toHaveBeenCalledWith("profile.resolve", expect.anything());
  });

  it("finds pending requests in both directions, loading every page", async () => {
    const request = await search("ana", {
      incoming: [[pending("0a", "incoming", "Ana from the studio")], [pending("1a", "incoming", "Anaïs")]],
      outgoing: [[pending("0b", "outgoing", "Banana Club")]],
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("approach.list", { direction: "incoming", status: "active", before: { createdAtMs: 1, id: "1" }, limit: 100 }));
    await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
    await act(async () => {});
    expect(collectText(tree)).toContain("Requests");
    // Both directions, including the second page of received requests.
    expect(collectNodes(tree).filter((node) => node.type === RequestRow).map((node) => node.key).sort()).toEqual(["0a", "0b", "1a"]);
  });

  it("looks up a handle no one here has and offers to send them a request", async () => {
    const request = await search("juno.ship.space", { resolve: async () => ({ data: { profile: JUNO } }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("profile.resolve", { address: "https://juno.ship.space/profile" }));
    await vi.waitFor(() => expect(collectText(tree)).toContain("Juno"));
    const send = collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "send a message request");
    await act(async () => { await send!.props.onClick!(); });
    expect(onCompose).toHaveBeenCalledWith(JUNO);
  });

  it("treats a blocked person as a match and looks no one up", async () => {
    const request = await search("troll.example", { blocks: [{ did: "did:plc:troll", displayName: "troll.example", createdAtMs: 1 }], resolve: async () => ({ data: { profile: JUNO } }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(request).not.toHaveBeenCalledWith("profile.resolve", expect.anything());
    expect(collectText(tree)).not.toContain("No matching people.");
  });

  it("waits for your contacts before looking anyone up", async () => {
    const request = await search("juno.ship.space", { contactsLoaded: false, resolve: async () => ({ data: { profile: JUNO } }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(request).not.toHaveBeenCalledWith("profile.resolve", expect.anything());
    expect(collectText(tree)).not.toContain("No matching people.");
  });

  it("says when there is no public profile at that address", async () => {
    await search("nobody.ship.space", { resolve: async () => { throw new GsvClientError({ code: 404, message: "No public profile" }); } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await vi.waitFor(() => expect(collectText(tree)).toContain("No public profile at @nobody.ship.space."));
  });
});
