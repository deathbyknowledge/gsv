import { GSVClient } from "@humansandmachines/gsv/client";
import type { ProfileState } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hint } from "../../../components/ui/Tooltip";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Profile } from "./Profile";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "sam", displayName: "Sam", relation: "self", runnable: false, gecos: "Sam", capabilities: ["*"] };
const PRIVATE: ProfileState = { revision: 1, url: "https://sam.space.example/profile", draft: { displayName: "Sam", about: "", contactPolicy: "requests" } };
const PUBLIC: ProfileState = { ...PRIVATE, published: { url: PRIVATE.url, cid: "bafyrecord", contactPolicy: "requests", revision: 1 } };
const OPEN_NETWORK_TIP = "Bluesky and other apps can show a public profile, and any app or search engine can save it and make it searchable. Your Ship doesn't see follows, replies or messages on Bluesky.";
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness() {
  tree = Profile({ account: ACCOUNT, active: true, edit: true, focusBio: false, onDirty: () => {}, onEdit: () => {}, onBack: () => {} });
  return null;
}

/** Opens the profile editor on `profile` once People has read it. */
async function mount(profile: ProfileState) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "profile.get") return { data: { profile } };
    if (call === "atproto.identity") return { data: { identity: null, takedowns: [] } };
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("profile.get", {}));
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  await act(async () => {});
}

/** "open network" in the note that begins `start`, with the tip it opens. */
function openNetworkIn(start: string) {
  const note = collectNodes(tree).find((node) => node.type === "p" && collectText(node).startsWith(start));
  return collectNodes(note?.props.children).find((node) => node.type === Hint && collectText(node) === "open network");
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("profile editor");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the open network in the profile editor", () => {
  it("is explained where publishing would put the profile on it", async () => {
    await mount(PRIVATE);
    expect(openNetworkIn("Publish makes")?.props.text).toBe(OPEN_NETWORK_TIP);
  });

  it("is explained where unpublishing would take the profile off it", async () => {
    await mount(PUBLIC);
    expect(openNetworkIn("Unpublishing removes")?.props.text).toBe(OPEN_NETWORK_TIP);
  });
});
