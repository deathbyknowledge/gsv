import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Shows the blocked section over `blocks`, narrowed by `filter`. */
async function mount(blocks: Array<{ did: string; displayName?: string; createdAtMs: number }>, filter = "") {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "contact.block.list") return { data: { blocks } };
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness filter={filter} /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("contact.block.list", { cursor: undefined, limit: 30 }));
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  await act(async () => {});
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

  it("narrows to the names the search matches", async () => {
    await mount(BLOCKS, "spam");
    expect(collectText(tree)).toContain("Spam Account");
    expect(collectText(tree)).not.toContain("Troll");
  });
});
