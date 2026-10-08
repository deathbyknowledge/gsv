import { describe, expect, it } from "vitest";
import { bodyFromBytes, decodeBrowserViewStream, encodeBrowserViewPacket, type BrowserViewState } from "@humansandmachines/gsv/protocol";
import { browserDisplayUrl, browserTabMetadata, browserViewTabs, MAX_BROWSER_VIEW_TABS } from "../src/browser-metadata";

describe("page-controlled live browser metadata", () => {
  it("preserves ordinary metadata and clips oversized display text without splitting a surrogate pair", () => {
    expect(browserTabMetadata("Example", "https://example.com/path")).toEqual({ title: "Example", url: "https://example.com/path" });
    const metadata = browserTabMetadata(`${"x".repeat(1022)}😀long title`, `https://example.com/${"😀".repeat(10000)}`);
    expect(metadata.title).toBe(`${"x".repeat(1022)}…`);
    expect(metadata.url.length).toBeLessThanOrEqual(8192);
    expect(metadata.url).not.toMatch(/[\ud800-\udbff]…$/u);
  });

  it("keeps active and selected tabs even when both are beyond the collection limit", () => {
    const metadata = new Map(Array.from({ length: 1000 }, (_, id) => [id + 1, { title: `Tab ${id + 1}`, url: "about:blank" }]));
    const tabs = browserViewTabs(metadata, 999, 1000);
    expect(tabs).toHaveLength(MAX_BROWSER_VIEW_TABS);
    expect(tabs.slice(-2).map(tab => tab.id)).toEqual([999, 1000]);
    expect(new Set(tabs.map(tab => tab.id)).size).toBe(tabs.length);
    expect(browserViewTabs(metadata, 1000, 1000)).toHaveLength(MAX_BROWSER_VIEW_TABS);
  });

  it.each(["x", "\0", '"\\\n', "😀"])("round-trips oversized tab metadata through the public decoder (%j)", async value => {
    const original = { title: value.repeat(20000), url: `https://example.com/${value.repeat(20000)}` };
    const metadata = new Map(Array.from({ length: 1000 }, (_, id) => [id + 1, original]));
    const state: BrowserViewState = {
      kind: "state", activeTabId: 999, tabs: browserViewTabs(metadata, 999, 1000),
      pointer: { tabId: 999, x: 10, y: 20, actor: "ship" },
      handoff: { requestId: "handoff", instanceId: "instance", tabId: 1000,
        purpose: "\0".repeat(500), site: browserDisplayUrl(original.url), state: "active", revision: 1, createdAt: 1, expiresAt: 2 },
    };
    const packet = encodeBrowserViewPacket(state);
    expect(packet.byteLength).toBeLessThan(256 * 1024);
    const decoded = await Array.fromAsync(decodeBrowserViewStream(bodyFromBytes(packet)));
    expect(decoded[0]?.metadata).toEqual(state);
    expect(state.tabs.some(tab => tab.id === 999)).toBe(true);
    expect(state.tabs.some(tab => tab.id === 1000)).toBe(true);
    expect(original.title).toBe(value.repeat(20000));
  });
});
