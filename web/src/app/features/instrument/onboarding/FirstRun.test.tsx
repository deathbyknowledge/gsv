import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { FirstRun } from "./FirstRun";

let tree: ComponentChildren;
let uid: number;
let seen: Map<number, string>;
let root: ReturnType<typeof createTestRoot>;
const request = vi.fn<GSVClient["request"]>();
const onOpenChange = vi.fn<(open: boolean) => void>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "person", connectionId: "test", message: null };
const SEEN_KEY = "users/1000/ui/welcome_card_seen";

let active = true;
function Harness() { tree = FirstRun({ active, onOpenChange }); return null; }
async function mount(name = "first run") {
  root = createTestRoot(name);
  await root.render(<GatewayProvider><Harness /></GatewayProvider>);
}
const retryButton = () => collectNodes(tree).find((node) => node.type === "button" && collectText(node.props.children) === "Retry")!;
const setCalls = () => request.mock.calls.filter(([call]) => call === "sys.config.set");

beforeEach(() => {
  uid = 1000;
  active = true;
  seen = new Map();
  request.mockReset();
  onOpenChange.mockReset();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { search: "" } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
  request.mockImplementation(async (call, args) => {
    if (call === "account.list") return { data: { accounts: [{ uid, username: "person", displayName: "Person", relation: "self", runnable: false }] } };
    if (call === "sys.config.get") {
      const { key } = z.object({ key: z.string() }).parse(args);
      const keyUid = Number(/^users\/(\d+)\/ui\/welcome_card_seen$/.exec(key)?.[1]);
      return { data: { entries: seen.has(keyUid) ? [{ key, value: seen.get(keyUid)! }] : [] } };
    }
    if (call === "sys.config.set") {
      const { key, value } = z.object({ key: z.string(), value: z.string() }).parse(args);
      const keyUid = Number(/^users\/(\d+)\/ui\/welcome_card_seen$/.exec(key)?.[1]);
      seen.set(keyUid, value);
      return { data: { ok: true } };
    }
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(async () => {
  if (root) await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first run", () => {
  it("wakes Ship as soon as a new owner's chat opens, then stays quiet for that person", async () => {
    await mount();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.set", { key: SEEN_KEY, value: "1" }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(tree).toBeNull();
    expect(setCalls()).toHaveLength(1);

    await root.unmount();
    request.mockClear();
    onOpenChange.mockClear();
    await mount("next session");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: SEEN_KEY }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(setCalls()).toHaveLength(0);
    expect(tree).toBeNull();
  });

  it("waits for the Ship chat to be the open view before waking Ship", async () => {
    active = false;
    await mount("other view");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: SEEN_KEY }));
    await act(async () => {});
    expect(setCalls()).toHaveLength(0);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(tree).toBeNull();
    active = true;
    await act(async () => { await root.render(<GatewayProvider><Harness /></GatewayProvider>); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.set", { key: SEEN_KEY, value: "1" }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
  });

  it("keeps a load failure to itself while another view is open, and offers the retry once the chat is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    request.mockImplementationOnce(async () => { throw new Error("temporarily unavailable"); });
    active = false;
    await mount("failed elsewhere");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("account.list", {}));
    await act(async () => {});
    expect(tree).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    active = true;
    await act(async () => { await root.render(<GatewayProvider><Harness /></GatewayProvider>); });
    expect(collectText(tree)).toContain("Couldn't wake Ship.");
    await act(async () => { retryButton().props.onClick!(); });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(setCalls()).toHaveLength(1);
  });

  it("records the first run separately for another person", async () => {
    seen.set(1000, "1");
    uid = 1001;
    await mount();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.set", { key: "users/1001/ui/welcome_card_seen", value: "1" }));
    expect(request).toHaveBeenCalledWith("sys.config.get", { key: "users/1001/ui/welcome_card_seen" });
  });

  it("does not apply to the root account", async () => {
    uid = 0;
    await mount("root");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("account.list", {}));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(request).not.toHaveBeenCalledWith("sys.config.get", expect.anything());
    expect(setCalls()).toHaveLength(0);
    expect(tree).toBeNull();
  });

  it.each(["account.list", "sys.config.get"])("offers a retry after %s fails, holding the chat's waking state", async (failedCall) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalRequest = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (...args) => {
      if (args[0] === failedCall && fail) throw new Error("temporarily unavailable");
      return originalRequest(...args);
    });
    await mount("recovery");
    await vi.waitFor(() => expect(collectText(tree)).toContain("Couldn't wake Ship."));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => { retryButton().props.onClick!(); });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(collectText(tree)).toContain("Couldn't wake Ship.");
    expect(setCalls()).toHaveLength(0);
    fail = false;
    await act(async () => { retryButton().props.onClick!(); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.set", { key: SEEN_KEY, value: "1" }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(tree).toBeNull();
  });

  it("keeps a retry available when recording the first run fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalRequest = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (...args) => {
      if (args[0] === "sys.config.set" && fail) throw new Error("connection interrupted");
      return originalRequest(...args);
    });
    await mount("write failure");
    await vi.waitFor(() => expect(collectText(tree)).toContain("Couldn't wake Ship."));
    expect(error).toHaveBeenCalledOnce();
    expect(setCalls()).toHaveLength(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fail = false;
    await act(async () => { retryButton().props.onClick!(); });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(setCalls()).toHaveLength(2);
    expect(tree).toBeNull();
  });
});
