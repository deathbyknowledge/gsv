import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerAccess } from "../app/features/instrument/settings/OwnerAccess";
import { BrowserNavigationProvider } from "../app/services/platform/BrowserNavigation";
import { collectNodes, collectText, createTestRoot, deferred } from "../app/testing/testHarness";
import { openInBrowser } from "./bridge";

const { link } = vi.hoisted(() => ({ link: vi.fn() }));
vi.mock("../app/services/gateway/GatewayProvider", () => ({
  useGateway: () => ({ client: { account: { owner: { link } } }, connected: true }),
}));

const verificationUrl = "https://accounts.example/owner/link#id=fixture&secret=fixture-proof";
let root: ReturnType<typeof createTestRoot>;
let tree: ComponentChildren;
let assign: ReturnType<typeof vi.fn>;
let invoke: ReturnType<typeof vi.fn>;

function Harness() { tree = OwnerAccess(); return null; }
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
  link.mockReset().mockResolvedValue({ url: verificationUrl });
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    location: { assign },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    __TAURI__: { core: { invoke } },
  });
  root = createTestRoot("Owner verification");
});
afterEach(async () => { await root.unmount(); vi.unstubAllGlobals(); });

describe("owner verification navigation", () => {
  it("retains current-tab navigation in the web UI", async () => {
    await root.render(<Harness />);
    await click();
    expect(link).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(verificationUrl);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the complete verification link to the native browser bridge without navigating the webview", async () => {
    const opening = deferred<void>();
    invoke.mockReturnValueOnce(opening.promise);
    await root.render(<BrowserNavigationProvider navigate={openInBrowser}><Harness /></BrowserNavigationProvider>);
    await click();
    expect(link).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_open", { url: verificationUrl });
    expect(assign).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(true);
    await act(async () => { opening.resolve(); });
    expect(button().props.disabled).toBe(false);
  });

  it("shows a browser-launch failure and allows another attempt", async () => {
    invoke.mockRejectedValueOnce("native browser unavailable");
    await root.render(<BrowserNavigationProvider navigate={openInBrowser}><Harness /></BrowserNavigationProvider>);
    await click();
    expect(collectText(tree)).toContain("Could not open your browser.");
    expect(button().props.disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    await click();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(collectText(tree)).not.toContain("Could not open your browser.");
  });

  it("does not open a browser when owner authorization fails", async () => {
    link.mockRejectedValueOnce(new Error("Owner linking unavailable"));
    await root.render(<BrowserNavigationProvider navigate={openInBrowser}><Harness /></BrowserNavigationProvider>);
    await click();
    expect(collectText(tree)).toContain("Owner linking unavailable");
    expect(invoke).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
  });
});
