import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { WelcomeCard } from "./WelcomeCard";

let tree: ComponentChildren;
let uid: number;
let seen: Map<number, string>;
let root: ReturnType<typeof createTestRoot>;
const request = vi.fn<GSVClient["request"]>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "person", connectionId: "test", message: null };

function Harness() { tree = WelcomeCard(); return null; }
async function mount() {
  root = createTestRoot("welcome card");
  await root.render(<GatewayProvider><Harness /></GatewayProvider>);
  await vi.waitFor(() => expect(collectText(tree)).toContain("Welcome to your Ship!"));
}

beforeEach(() => {
  uid = 1000;
  seen = new Map();
  request.mockReset();
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

describe("welcome card", () => {
  it.each(["account.list", "sys.config.get"])("offers a retry after %s fails without disconnecting", async (failedCall) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalRequest = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (...args) => {
      if (args[0] === failedCall && fail) throw new Error("temporarily unavailable");
      return originalRequest(...args);
    });
    root = createTestRoot("welcome recovery");
    await root.render(<GatewayProvider><Harness /></GatewayProvider>);
    await vi.waitFor(() => expect(collectText(tree)).toContain("Couldn't load the welcome."));
    const retry = () => collectNodes(tree).find((node) => node.type === "button" && collectText(node.props.children) === "Retry")!.props.onClick!();
    await act(async () => { retry(); });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(collectText(tree)).toContain("Couldn't load the welcome.");
    fail = false;
    await act(async () => { retry(); });
    await vi.waitFor(() => expect(collectText(tree)).toContain("Welcome to your Ship!"));
    expect(request.mock.calls.filter(([call]) => call === failedCall)).toHaveLength(3);
    expect(request).not.toHaveBeenCalledWith("sys.config.set", expect.anything());
  });

  it("shows the message and Discord link, then stays dismissed across sessions for that person", async () => {
    await mount();
    expect(collectText(tree)).toContain("I'm Kawah, one of the founders of Ship.");
    expect(collectText(tree)).toContain("talk to us directly on");
    expect(collectNodes(tree).find((node) => node.type === "a")?.props.href).toBe("https://discord.gg/hy9ExJJFvn");
    const tryButton = collectNodes(tree).find((node) => collectText(node.props.children) === "Try it out!");
    await act(async () => { await tryButton?.props.onClick?.(); });
    expect(tree).toBeNull();
    expect(request).toHaveBeenCalledWith("sys.config.set", { key: "users/1000/ui/welcome_card_seen", value: "1" });
    await root.unmount();
    request.mockClear();
    root = createTestRoot("welcome card next session");
    await root.render(<GatewayProvider><Harness /></GatewayProvider>);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: "users/1000/ui/welcome_card_seen" }));
    expect(tree).toBeNull();
  });

  it("offers a close control and shows separately for another person", async () => {
    await mount();
    const close = collectNodes(tree).find((node) => node.props["aria-label"] === "Dismiss welcome");
    await act(async () => { await close?.props.onClick?.(); });
    expect(tree).toBeNull();
    uid = 1001;
    await root.unmount();
    request.mockClear();
    await mount();
    expect(collectText(tree)).toContain("Welcome to your Ship!");
    expect(request).toHaveBeenCalledWith("sys.config.get", { key: "users/1001/ui/welcome_card_seen" });
  });

  it("reports that it stands until this person dismisses it", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    function Reporting() { tree = WelcomeCard({ onOpenChange }); return null; }
    root = createTestRoot("welcome standing");
    await root.render(<GatewayProvider><Reporting /></GatewayProvider>);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(collectText(tree)).toContain("Welcome to your Ship!"));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const tryIt = collectNodes(tree).find((node) => node.type === "button" && collectText(node.props.children) === "Try it out!")!;
    await act(async () => { await tryIt.props.onClick!(); });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    await root.unmount();

    onOpenChange.mockClear();
    root = createTestRoot("welcome already seen");
    await root.render(<GatewayProvider><Reporting /></GatewayProvider>);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(collectText(tree)).not.toContain("Welcome to your Ship!");
  });

  it("does not show to the root account", async () => {
    uid = 0;
    root = createTestRoot("root welcome card");
    await root.render(<GatewayProvider><Harness /></GatewayProvider>);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("account.list", {}));
    expect(tree).toBeNull();
    expect(request).not.toHaveBeenCalledWith("sys.config.get", expect.anything());
  });

  it("waits for dismissal to succeed and prevents repeated requests", async () => {
    await mount();
    let finish: () => void = () => { throw new Error("dismissal has not started"); };
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: { ok: true } }); }));
    const dismiss = collectNodes(tree).find((node) => node.props["aria-label"] === "Dismiss welcome")!.props.onClick!;
    let pending: unknown;
    await act(() => { pending = dismiss(); });
    expect(tree).not.toBeNull();
    expect(collectNodes(tree).filter((node) => node.type === "button").every((node) => node.props.disabled)).toBe(true);
    await act(async () => { await dismiss(); });
    expect(request.mock.calls.filter(([call]) => call === "sys.config.set")).toHaveLength(1);
    await act(async () => { finish(); await pending; });
    expect(tree).toBeNull();
  });

  it("keeps the card available to retry when dismissal fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    request.mockRejectedValueOnce(new Error("connection interrupted"));
    const dismiss = () => collectNodes(tree).find((node) => node.props["aria-label"] === "Dismiss welcome")!.props.onClick!();
    await act(async () => { await dismiss(); });
    expect(collectText(tree)).toContain("Please try again.");
    expect(error).toHaveBeenCalledOnce();
    await act(async () => { await dismiss(); });
    expect(tree).toBeNull();
  });
});
