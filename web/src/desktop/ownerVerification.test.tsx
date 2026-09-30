import { GSVClient } from "@humansandmachines/gsv/client";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerAccess } from "../app/features/instrument/settings/OwnerAccess";
import { GatewayProvider } from "../app/services/gateway/GatewayProvider";
import { BrowserNavigationProvider } from "../app/services/platform/BrowserNavigation";
import { collectNodes, collectText, createTestRoot, deferred } from "../app/testing/testHarness";
import { openInBrowser } from "./bridge";

const verificationUrl = "https://accounts.example/owner/link#id=fixture&secret=fixture-proof";
const link = vi.fn<() => Promise<{ url: string; expiresAt: number }>>();
let root: ReturnType<typeof createTestRoot>;
let tree: ComponentChildren;
let assign: ReturnType<typeof vi.fn>;
let invoke: ReturnType<typeof vi.fn>;

function Harness() { tree = OwnerAccess(); return null; }
async function mount(desktop: boolean) {
  await root.render(<GatewayProvider>{desktop
    ? <BrowserNavigationProvider navigate={openInBrowser}><Harness /></BrowserNavigationProvider>
    : <Harness />}</GatewayProvider>);
}
function button() {
  const node = collectNodes(tree).find((node) => node.type === "button");
  if (!node) throw new Error("Missing owner-link control");
  return node;
}
async function click() { await act(async () => { button().props.onClick?.(); }); }

beforeEach(() => {
  const storage = new Map<string, string>();
  assign = vi.fn();
  invoke = vi.fn().mockResolvedValue(undefined);
  link.mockReset().mockResolvedValue({ url: verificationUrl, expiresAt: Date.now() + 600_000 });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call !== "account.owner.link") throw new Error(`Unexpected request ${call}`);
    return { data: await link() };
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    location: { protocol: "https:", host: "space.example", search: "", assign },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    __TAURI__: { core: { invoke } },
  });
  root = createTestRoot("Owner verification");
});
afterEach(async () => { await root.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("owner verification navigation", () => {
  it("retains current-tab navigation in the web UI", async () => {
    await mount(false);
    await click();
    await vi.waitFor(() => expect(button().props.disabled).toBe(false));
    expect(link).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(verificationUrl);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the complete verification link to the native browser bridge without navigating the webview", async () => {
    const opening = deferred<void>();
    invoke.mockReturnValueOnce(opening.promise);
    await mount(true);
    await click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(link).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_open", { url: verificationUrl });
    expect(assign).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(true);
    await act(async () => { opening.resolve(); });
    await vi.waitFor(() => expect(button().props.disabled).toBe(false));
  });

  it("shows a browser-launch failure and allows another attempt", async () => {
    invoke.mockRejectedValueOnce("native browser unavailable");
    await mount(true);
    await click();
    await vi.waitFor(() => expect(collectText(tree)).toContain("Could not open your browser."));
    expect(button().props.disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    await click();
    await vi.waitFor(() => expect(button().props.disabled).toBe(false));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(collectText(tree)).not.toContain("Could not open your browser.");
  });

  it("does not open a browser when owner authorization fails", async () => {
    link.mockRejectedValueOnce(new Error("Owner linking unavailable"));
    await mount(true);
    await click();
    await vi.waitFor(() => expect(collectText(tree)).toContain("Owner linking unavailable"));
    expect(invoke).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
  });
});
