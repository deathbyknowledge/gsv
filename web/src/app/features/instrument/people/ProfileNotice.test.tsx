import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { ProfileNotice } from "./ProfileNotice";

const KEY = "users/1000/ui/profile_notice_seen";
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness() { tree = ProfileNotice({ ownerUid: 1000, published: true }); return null; }

/** Shows the notice to someone whose config holds `seen` for it. */
async function mount(seen: string | null) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "sys.config.get") return { data: { entries: seen === null ? [] : [{ key: KEY, value: seen }] } };
    if (call === "sys.config.set") return { data: {} };
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: KEY }));
  // The notice shows once People has read whether it was dismissed.
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
  root = createTestRoot("profile notice");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the public profile notice", () => {
  it("shows again to someone who dismissed it before it named Bluesky, and dismissing it now keeps it dismissed", async () => {
    const request = await mount("1");
    expect(tree).not.toBeNull();
    const dismiss = collectNodes(tree).find((node) => node.props.label === "got it");
    await act(async () => { await dismiss!.props.onClick!(); });
    expect(request).toHaveBeenCalledWith("sys.config.set", { key: KEY, value: "2" });
    await vi.waitFor(() => expect(tree).toBeNull());
  });

  it("stays dismissed once dismissed since it named Bluesky", async () => {
    await mount("2");
    expect(tree).toBeNull();
  });
});
