import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectText, createTestRoot } from "../../../testing/testHarness";
import { BlockedPeople } from "./BlockedPeople";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "sam", displayName: "Sam", relation: "self", runnable: false, gecos: "Sam", capabilities: ["*"] };
const BLOCKS = [{ did: "did:plc:spam", displayName: "Spam Account", createdAtMs: 1 }, { did: "did:plc:troll", displayName: "Troll", createdAtMs: 2 }];
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness({ filter }: { filter: string }) { tree = BlockedPeople({ account: ACCOUNT, filter }); return null; }

type Block = { did: string; displayName?: string; createdAtMs: number };

/** Shows the blocked section over `blocks`, narrowed by `filter`; `later` is a second page behind it. */
async function mount(blocks: Block[], filter = "", later?: Block[]) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call !== "contact.block.list") throw new Error(`Unexpected request ${call}`);
    const page = z.object({ cursor: z.string().optional() }).parse(args).cursor === "page-2" ? { blocks: later ?? [] } : { blocks, nextCursor: later ? "page-2" : undefined };
    return { data: page };
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness filter={filter} /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("contact.block.list", { cursor: undefined, limit: 30 }));
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  await act(async () => {});
  return request;
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("blocked people");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("blocked people under the contacts list", () => {
  it("stays out of the way until someone is blocked", async () => {
    await mount([]);
    expect(tree).toBeNull();
  });

  it("lists the people blocked", async () => {
    await mount(BLOCKS);
    expect(collectText(tree)).toContain("Blocked people");
    expect(collectText(tree)).toContain("Spam Account");
    expect(collectText(tree)).toContain("Troll");
  });

  it("loads later pages to find a match the first page doesn't hold", async () => {
    const request = await mount(BLOCKS, "quiet", [{ did: "did:plc:quiet", displayName: "Quiet Neighbour", createdAtMs: 3 }]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("contact.block.list", { cursor: "page-2", limit: 30 }));
    await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
    await act(async () => {});
    expect(collectText(tree)).toContain("Quiet Neighbour");
    expect(collectText(tree)).not.toContain("Spam Account");
  });

  it("narrows to the names the search matches", async () => {
    await mount(BLOCKS, "spam");
    expect(collectText(tree)).toContain("Spam Account");
    expect(collectText(tree)).not.toContain("Troll");
  });
});
