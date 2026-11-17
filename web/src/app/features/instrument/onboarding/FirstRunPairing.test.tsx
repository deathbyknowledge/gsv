import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import type { ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { LinkQrCode } from "../settings/messengers/LinkQrCode";
import { FirstRunPairing, type MessengerChoice } from "./FirstRunPairing";

const CODES = ["ABCD-EFGH-JKLM", "NPQR-STUV-WXYZ"];

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot> | null = null;
let rerender: () => void = () => {};
let adapter: MessengerChoice;
let linked: boolean;
let links: ConsoleIdentityLink[];
/** How long the next link the Kernel makes works for. */
let lifetime: number;
let minted: { code: string; createdAt: number }[];
const request = vi.fn<GSVClient["request"]>();
const onRefreshLinks = vi.fn<() => void>();
const onFinish = vi.fn<() => void>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "person", connectionId: "test", message: null };

function Harness() {
  const [, setTick] = useState(0);
  rerender = () => setTick((tick) => tick + 1);
  tree = FirstRunPairing({ adapter, name: adapter === "whatsapp" ? "WhatsApp" : "Telegram", linked, disabled: false, links, onRefreshLinks, onFinish });
  return null;
}
async function mount() {
  root = createTestRoot("first-run pairing");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
}
/** The host reloaded the owner's links. */
async function reload(next: ConsoleIdentityLink[]) {
  links = next;
  await act(async () => { rerender(); });
}
/** The account the person's message connected, as `sys.link.list` reports it. */
const linkFrom = (linkedAt: number): ConsoleIdentityLink => ({
  adapter, accountId: "managed", actorId: "31612345678", uid: 1000, createdAt: linkedAt, linkedByUid: 1000, linkedAt, actorName: "Esteve", actorHandle: "+31•••••••78",
});
const button = (label: string) => collectNodes(tree).find((node) => node.type === Button && node.props.label === label);
const qr = () => collectNodes(tree).find((node) => node.type === LinkQrCode);
const steps = () => collectNodes(tree).filter((node) => node.type === "li").map((node) => node.props["aria-current"]);
const click = async (label: string) => { await act(async () => { await button(label)!.props.onClick!(); }); };

beforeEach(() => {
  adapter = "whatsapp";
  linked = false;
  links = [];
  lifetime = 600_000;
  minted = [];
  request.mockReset();
  onRefreshLinks.mockReset();
  onFinish.mockReset();
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { location: { search: "", origin: "https://jessica.ship.space" } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
  request.mockImplementation(async (call, args) => {
    const asked = z.object({ adapter: z.string() }).parse(args).adapter;
    if (call === "adapter.pair.info") return { data: { adapter: asked, accountId: "managed", configured: true, pairingLinks: true,
      setupUrl: `https://jessica.ship.space/chat/settings?section=messengers&messenger=${asked}`,
      ...(asked === "whatsapp" ? { installUrl: "https://wa.me/31612345678", unreachableCallingCodes: [] } : { botUsername: "ShipBot" }) } };
    if (call === "adapter.pair.create") {
      const code = CODES[minted.length % CODES.length]!;
      const createdAt = Date.now();
      minted.push({ code, createdAt });
      const url = asked === "whatsapp"
        ? `https://wa.me/31612345678?text=${encodeURIComponent(`Connect my Ship ${code}`)}`
        : `https://t.me/ShipBot?start=${code.replaceAll("-", "")}`;
      return { data: { adapter: asked, code, url, createdAt, expiresAt: createdAt + lifetime } };
    }
    if (call === "adapter.pair.disconnect") return { data: { disconnected: true } };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first-run pairing", () => {
  it("makes a link as the card opens, leads with opening WhatsApp, and moves on once it is open", async () => {
    await mount();
    await vi.waitFor(() => expect(button("OPEN WHATSAPP")?.props.href).toBe("https://wa.me/31612345678?text=Connect%20my%20Ship%20ABCD-EFGH-JKLM"));
    expect(request).toHaveBeenCalledWith("adapter.pair.create", { adapter: "whatsapp" });
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("primary");
    expect(qr()?.props.url).toBe(button("OPEN WHATSAPP")?.props.href);
    expect(steps()).toEqual(["step", undefined]);
    const text = collectText(tree);
    expect(text).toContain("Waiting for your message. This link works once, for 10 minutes.");
    // The way to connect without the link: the code itself, and where to send it.
    expect(text).toContain("You can also send ABCD-EFGH-JKLM to +31612345678 in WhatsApp.");

    await click("OPEN WHATSAPP");
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("secondary");
    expect(steps()).toEqual([undefined, "step"]);
    expect(minted).toHaveLength(1);
  });

  it("finishes on its own when the link's connection arrives, names the account, and leads back to WhatsApp", async () => {
    await mount();
    await vi.waitFor(() => expect(minted).toHaveLength(1));
    // An account connected before this link was made is not its answer.
    await reload([linkFrom(minted[0]!.createdAt - 60_000)]);
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("primary");

    await reload([linkFrom(minted[0]!.createdAt + 5_000)]);
    expect(collectNodes(tree).find((node) => node.type === Alert)?.props.title).toBe("Connected");
    expect(collectText(tree)).toContain("connected to Esteve · +31•••••••78");
    expect(button("OPEN WHATSAPP")?.props).toMatchObject({ href: "https://wa.me/31612345678", variant: "primary" });
    await click("OPEN WHATSAPP");
    await click("OPEN CHAT HERE");
    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it("disconnects an account that is not the person's and makes a new link", async () => {
    await mount();
    await vi.waitFor(() => expect(minted).toHaveLength(1));
    await reload([linkFrom(minted[0]!.createdAt + 5_000)]);
    await click("Not you?");
    await vi.waitFor(() => expect(minted).toHaveLength(2));
    expect(request).toHaveBeenCalledWith("adapter.pair.disconnect", { adapter: "whatsapp", accountId: "managed", actorId: "31612345678" });
    expect(onRefreshLinks).toHaveBeenCalled();
    await reload([]);
    expect(button("OPEN WHATSAPP")?.props.href).toContain("NPQR-STUV-WXYZ");
  });

  it("offers a new link once this one expires", async () => {
    lifetime = 0;
    await mount();
    await vi.waitFor(() => expect(button("MAKE A NEW LINK")).toBeDefined());
    expect(collectText(tree)).toContain("This link expired. Make a new one to connect.");
    // The new link takes the open button's place, so the first step is the one to do again.
    expect(button("OPEN WHATSAPP")).toBeUndefined();
    expect(steps()).toEqual(["step", undefined]);
    expect(qr()).toBeUndefined();
    expect(collectText(tree)).not.toContain("ABCD-EFGH-JKLM");

    lifetime = 600_000;
    await click("MAKE A NEW LINK");
    await vi.waitFor(() => expect(button("OPEN WHATSAPP")?.props.href).toContain("NPQR-STUV-WXYZ"));
    expect(button("MAKE A NEW LINK")).toBeUndefined();
  });

  it("goes back to the first step when a link it opened expires, and stays there with the new one", async () => {
    lifetime = 300;
    await mount();
    await vi.waitFor(() => expect(button("OPEN WHATSAPP")?.props.href).toContain("ABCD-EFGH-JKLM"));
    await click("OPEN WHATSAPP");
    expect(steps()).toEqual([undefined, "step"]);
    await vi.waitFor(() => expect(button("MAKE A NEW LINK")).toBeDefined());
    expect(steps()).toEqual(["step", undefined]);

    lifetime = 600_000;
    await click("MAKE A NEW LINK");
    await vi.waitFor(() => expect(button("OPEN WHATSAPP")?.props.href).toContain("NPQR-STUV-WXYZ"));
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("primary");
    expect(steps()).toEqual(["step", undefined]);
  });

  it("opens Telegram's bot with the code as its start", async () => {
    adapter = "telegram";
    await mount();
    await vi.waitFor(() => expect(button("OPEN TELEGRAM")?.props.href).toBe("https://t.me/ShipBot?start=ABCDEFGHJKLM"));
    expect(collectText(tree)).toContain("You can also send ABCD-EFGH-JKLM to @ShipBot in Telegram.");
  });

  it("makes no link for a messenger that is already connected, and offers the way back to it", async () => {
    adapter = "telegram";
    linked = true;
    await mount();
    await vi.waitFor(() => expect(button("OPEN TELEGRAM")?.props.href).toBe("https://t.me/ShipBot"));
    expect(collectNodes(tree).find((node) => node.type === Alert)?.props.title).toBe("Connected");
    expect(request).not.toHaveBeenCalledWith("adapter.pair.create", expect.anything());
    expect(button("Not you?")).toBeUndefined();
  });
});
