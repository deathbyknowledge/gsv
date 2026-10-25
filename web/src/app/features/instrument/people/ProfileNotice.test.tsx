import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hint } from "../../../components/ui/Tooltip";
import { es } from "../../../i18n/es";
import { applyLanguagePreference } from "../../../i18n/locale";
import { ptBR } from "../../../i18n/pt-BR";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
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

/** "open network" in the notice, with the tip it opens. */
function openNetwork() {
  return collectNodes(tree).find((node) => node.type === Hint);
}

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("profile notice");
});
afterEach(async () => {
  await root.unmount();
  cache.clear();
  await applyLanguagePreference("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the public profile notice", () => {
  it("shows to someone who hasn't dismissed it, explains the open network, and stays dismissed once they do", async () => {
    const request = await mount(null);
    expect(collectText(openNetwork())).toBe("open network");
    expect(openNetwork()?.props.text).toBe("Bluesky and other apps can show a public profile, and any app or search engine can save it and make it searchable. Your Ship doesn't see follows, replies or messages on Bluesky.");
    const dismiss = collectNodes(tree).find((node) => node.props.label === "got it");
    await act(async () => { await dismiss!.props.onClick!(); });
    expect(request).toHaveBeenCalledWith("sys.config.set", { key: KEY, value: "1" });
    await vi.waitFor(() => expect(tree).toBeNull());
  });

  it("stays dismissed for someone who dismissed it before it named Bluesky", async () => {
    await mount("1");
    expect(tree).toBeNull();
  });

  it.each([["es", es], ["pt-BR", ptBR]] as const)("explains the open network in %s", async (tag, catalog) => {
    await applyLanguagePreference(tag);
    await mount(null);
    expect(collectText(openNetwork())).toBe(catalog["people.profile.openNetwork"]);
    expect(openNetwork()?.props.text).toBe(catalog["people.profile.openNetworkTip"]);
  });
});
