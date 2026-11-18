import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Tag } from "../../../components/ui/Tag";
import type { ConsoleAdapter, ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { MessengerCard } from "../settings/messengers/MessengerCard";
import { MessengerSteps } from "../settings/messengers/MessengerSteps";
import { FirstRunScreen } from "./FirstRunScreen";

let tree: ComponentChildren;
let adapters: ConsoleAdapter[];
let links: ConsoleIdentityLink[];
let completeError: boolean;
let root: ReturnType<typeof createTestRoot>;
const request = vi.fn<GSVClient["request"]>();
const onComplete = vi.fn<() => Promise<void>>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "person", connectionId: "test", message: null };

const managedAdapter = (adapter: string, overrides: Partial<ConsoleAdapter> = {}): ConsoleAdapter => ({
  adapter, available: true, enabled: true, canLink: true, supportsConnect: true, supportsDisconnect: true, supportsSend: true,
  supportsStatus: false, supportsActivity: false, supportsPairing: true, accounts: [], ...overrides,
});
const whatsAppLink: ConsoleIdentityLink = { adapter: "whatsapp", accountId: "managed-whatsapp", actorId: "31612345678", uid: 1000, createdAt: 1, linkedByUid: 1000 };

function Harness() { tree = FirstRunScreen({ ownerUid: 1000, completing: false, completeError, onComplete }); return null; }
async function mount() {
  root = createTestRoot("first-run screen");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(collectText(tree)).toContain("Where do you want to message Ship?"));
}
const cards = () => collectNodes(tree).filter((node) => node.type === MessengerCard).map((node) => node.props.name);
const card = (name: string) => collectNodes(tree).find((node) => node.type === MessengerCard && node.props.name === name);
const toggle = async (name: string) => { await act(async () => { card(name)!.props.onToggle!(); }); };
const pairings = () => collectNodes(tree).filter((node) => node.type === MessengerSteps);
const button = (label: string) => collectNodes(tree).find((node) => node.type === Button && node.props.label === label);
const alert = () => collectNodes(tree).find((node) => node.type === Alert);
const skip = () => button("Skip for now");
const click = async (node: { props: { onClick?: () => void | Promise<void> } } | undefined) => { await act(async () => { await node!.props.onClick!(); }); };
/** Signup left this messenger in tab storage for the first run; returns that storage. */
function arriveFrom(messenger: string): Map<string, string> {
  const stored = new Map([["gsv.ui.first-run.messenger.v1", messenger]]);
  vi.stubGlobal("window", { ...window, sessionStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => { stored.delete(key); },
    setItem: (key: string, value: string) => { stored.set(key, value); },
  } });
  return stored;
}

beforeEach(() => {
  adapters = [managedAdapter("whatsapp"), managedAdapter("telegram"), managedAdapter("slack", { canLink: false })];
  links = [];
  completeError = false;
  request.mockReset();
  onComplete.mockReset();
  onComplete.mockResolvedValue(undefined);
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { search: "", origin: "https://jessica.ship.space" }, navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
  request.mockImplementation(async (call) => {
    if (call === "adapter.list") return { data: { adapters } };
    if (call === "sys.link.list") return { data: { links } };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(async () => {
  if (root) await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first-run screen", () => {
  it("offers each pairable messenger as a card, the first one leading, with the privacy note and a skip", async () => {
    await mount();
    await vi.waitFor(() => expect(cards()).toEqual(["WhatsApp", "Telegram"]));
    expect(card("WhatsApp")?.props).toMatchObject({ action: "Chat on WhatsApp", primary: true });
    expect(card("Telegram")?.props).toMatchObject({ action: "Chat on Telegram", primary: false });
    expect(card("WhatsApp")?.props.expanded).toBe(false);
    expect(collectText(tree)).toContain("You can always reach your Ship at jessica.ship.space.");
    expect(collectText(tree)).toContain("Ship only sees the messages you send it.");
    expect(pairings()).toEqual([]);
    await click(skip());
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("opens one card at a time from its header, which also closes it", async () => {
    await mount();
    await vi.waitFor(() => expect(card("WhatsApp")).toBeDefined());
    await toggle("WhatsApp");
    expect(pairings().map((node) => node.props.adapter)).toEqual(["whatsapp"]);
    expect(card("WhatsApp")?.props.expanded).toBe(true);
    await toggle("Telegram");
    expect(pairings().map((node) => node.props.adapter)).toEqual(["telegram"]);
    await toggle("Telegram");
    expect(pairings()).toEqual([]);
  });

  it("shows a linked messenger as connected, and its pairing sees the links, refreshes them, and finishes", async () => {
    links = [whatsAppLink];
    await mount();
    await vi.waitFor(() => expect(collectNodes(card("WhatsApp")!.props.status).find((node) => node.type === Tag)?.props.label).toBe("Connected"));
    await toggle("WhatsApp");
    expect(pairings()[0]?.props).toMatchObject({ linked: true, links: [whatsAppLink] });
    request.mockClear();
    await act(async () => { pairings()[0]!.props.onRefreshLinks!(); });
    expect(request).toHaveBeenCalledWith("sys.link.list", {});
    await act(async () => { pairings()[0]!.props.onFinish!(); });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("opens the card of the messenger a signup came from, once", async () => {
    const arrival = arriveFrom("telegram");
    await mount();
    await vi.waitFor(() => expect(pairings().map((node) => node.props.adapter)).toEqual(["telegram"]));
    expect(card("Telegram")?.props.expanded).toBe(true);
    expect(arrival.size).toBe(0);
    // Closing it leaves the choice to the person; a later load of the links does not open it again.
    await toggle("Telegram");
    expect(pairings()).toEqual([]);
    await toggle("WhatsApp");
    request.mockClear();
    await act(async () => { pairings()[0]!.props.onRefreshLinks!(); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.link.list", {}));
    expect(pairings().map((node) => node.props.adapter)).toEqual(["whatsapp"]);
  });

  it("opens nothing for a messenger that is already connected or that this deployment does not offer", async () => {
    links = [whatsAppLink];
    const connectedHint = arriveFrom("whatsapp");
    await mount();
    await vi.waitFor(() => expect(connectedHint.size).toBe(0));
    expect(collectNodes(card("WhatsApp")!.props.status).find((node) => node.type === Tag)?.props.label).toBe("Connected");
    expect(pairings()).toEqual([]);
    await root.unmount();

    adapters = [managedAdapter("whatsapp")];
    const unavailable = arriveFrom("telegram");
    await mount();
    await vi.waitFor(() => expect(unavailable.size).toBe(0));
    expect(cards()).toEqual(["WhatsApp"]);
    expect(pairings()).toEqual([]);
  });

  it("opens the chat instead of skipping when no messenger can be paired", async () => {
    adapters = [managedAdapter("whatsapp", { enabled: false }), managedAdapter("telegram", { canLink: false })];
    await mount();
    await vi.waitFor(() => expect(button("OPEN CHAT")).toBeDefined());
    expect(cards()).toEqual([]);
    expect(skip()).toBeUndefined();
    expect(collectText(tree)).not.toContain("Ship only sees the messages you send it.");
    await click(button("OPEN CHAT"));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("says when the messenger inventory could not be loaded and offers a retry, instead of an empty inventory", async () => {
    let listFails = true;
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (call, args) => {
      if (call === "adapter.list" && listFails) throw new Error("adapters unavailable");
      return base(call, args);
    });
    await mount();
    await vi.waitFor(() => expect(alert()?.props.text).toContain("Couldn't check which messengers are available."));
    expect(button("OPEN CHAT")?.props.disabled).toBe(false);
    listFails = false;
    await click(button("try again"));
    await vi.waitFor(() => expect(cards()).toEqual(["WhatsApp", "Telegram"]));
    expect(alert()).toBeUndefined();
    expect(skip()).toBeDefined();
  });


  it("shows the failure to finish and keeps the choices available", async () => {
    completeError = true;
    await mount();
    expect(alert()?.props.text).toBe("Couldn't finish setting up. Try again.");
    expect(skip()).toBeDefined();
  });
});
