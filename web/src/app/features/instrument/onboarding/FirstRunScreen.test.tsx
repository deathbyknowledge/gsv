import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { ListRow } from "../../../components/ui/ListRow";
import { LATEST_RELEASE_PAGE_URL } from "../../../domain/cliInstall";
import { MessengerPairing } from "../settings/Telegram";
import type { ConsoleAdapter, ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { FirstRunScreen } from "./FirstRunScreen";

let tree: ComponentChildren;
let adapters: ConsoleAdapter[];
let links: ConsoleIdentityLink[];
let unreachable: string[];
let completeError: boolean;
let root: ReturnType<typeof createTestRoot>;
const request = vi.fn<GSVClient["request"]>();
const onComplete = vi.fn<(choice: string) => Promise<void>>();
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
const rows = () => collectNodes(tree).filter((node) => node.type === ListRow);
const row = (label: string) => rows().find((node) => node.props.label === label);
const button = (label: string) => collectNodes(tree).find((node) => node.type === Button && node.props.label === label);
const pairing = () => collectNodes(tree).find((node) => node.type === MessengerPairing);
const alert = () => collectNodes(tree).find((node) => node.type === Alert);
const click = async (node: { props: { onClick?: () => void | Promise<void> } } | undefined) => { await act(async () => { await node!.props.onClick!(); }); };

beforeEach(() => {
  adapters = [managedAdapter("whatsapp"), managedAdapter("telegram"), managedAdapter("slack", { canLink: false })];
  links = [];
  unreachable = ["55", "62"];
  completeError = false;
  request.mockReset();
  onComplete.mockReset();
  onComplete.mockResolvedValue(undefined);
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { search: "" }, navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
  request.mockImplementation(async (call, args) => {
    if (call === "adapter.list") return { data: { adapters } };
    if (call === "sys.link.list") return { data: { links } };
    if (call === "adapter.pair.info") {
      const { adapter } = z.object({ adapter: z.string() }).parse(args);
      return { data: { adapter, accountId: `managed-${adapter}`, configured: true, installUrl: "https://wa.me/31612345678?text=%2Flink", unreachableCallingCodes: unreachable } };
    }
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(async () => {
  if (root) await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first-run screen", () => {
  it("lists the deployment's messengers first, then the desktop app and continuing here, naming the countries WhatsApp cannot reach", async () => {
    await mount();
    await vi.waitFor(() => expect(row("WhatsApp")).toBeDefined());
    expect(rows().map((node) => node.props.label)).toEqual(["WhatsApp", "Telegram", "Desktop app", "Continue here"]);
    expect(row("WhatsApp")?.props.labelInfo).toContain("Ship only sees the messages you send it.");
    expect(row("Telegram")?.props.labelInfo).toContain("Ship only sees the messages you send it.");
    expect(row("Continue here")?.props.labelInfo).toBeUndefined();
    expect(row("Continue here")?.props.sub).toBe("You can connect a messenger later.");
    await vi.waitFor(() => expect(collectText(tree)).toContain("Not for numbers in Brazil (+55) and Indonesia (+62)"));
    expect(pairing()).toBeUndefined();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("continues here at once", async () => {
    await mount();
    await click(row("Continue here"));
    expect(onComplete).toHaveBeenCalledWith("web");
  });

  it("opens the desktop drawer with the release download, and continues in the web meanwhile", async () => {
    await mount();
    await click(row("Desktop app"));
    expect(button("DOWNLOAD THE DESKTOP APP")?.props.href).toBe(LATEST_RELEASE_PAGE_URL);
    expect(row("Desktop app")?.props.active).toBe(true);
    await click(row("Desktop app"));
    expect(button("DOWNLOAD THE DESKTOP APP")).toBeUndefined();
    await click(row("Desktop app"));
    await click(button("CONTINUE IN THE WEB FOR NOW"));
    expect(onComplete).toHaveBeenCalledWith("desktop");
  });

  it("offers only the messengers this deployment lets the person pair", async () => {
    adapters = [managedAdapter("whatsapp", { enabled: false }), managedAdapter("telegram", { canLink: false })];
    await mount();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.link.list", {}));
    await act(async () => {});
    expect(rows().map((node) => node.props.label)).toEqual(["Desktop app", "Continue here"]);
    expect(request).not.toHaveBeenCalledWith("adapter.pair.info", expect.anything());
  });

  it("pairs a messenger in its drawer, then offers the chat once it is connected", async () => {
    await mount();
    await vi.waitFor(() => expect(row("Telegram")).toBeDefined());
    await click(row("Telegram"));
    expect(pairing()?.props.adapter).toBe("telegram");
    expect(row("WhatsApp")).toBeDefined();
    await act(async () => { pairing()!.props.onClose!(); });
    await vi.waitFor(() => expect(pairing()).toBeUndefined());

    await click(row("Telegram"));
    await act(async () => { pairing()!.props.onConnected!(); });
    expect(alert()?.props.text).toContain("Ship will say hello on Telegram");
    expect(onComplete).not.toHaveBeenCalled();
    await click(button("OPEN CHAT"));
    expect(onComplete).toHaveBeenCalledWith("telegram");
  });

  it("treats leaving the flow with the messenger linked as the choice", async () => {
    await mount();
    await vi.waitFor(() => expect(row("WhatsApp")).toBeDefined());
    await click(row("WhatsApp"));
    links = [whatsAppLink];
    await act(async () => { pairing()!.props.onClose!(); });
    await vi.waitFor(() => expect(button("OPEN CHAT")).toBeDefined());
    expect(alert()?.props.text).toContain("Ship will say hello on WhatsApp");
    await click(button("OPEN CHAT"));
    expect(onComplete).toHaveBeenCalledWith("whatsapp");
  });

  it("shows an already paired messenger as connected and offers the chat from it", async () => {
    links = [whatsAppLink];
    await mount();
    await vi.waitFor(() => expect(row("WhatsApp")?.props.sub).toBe("Connected"));
    await click(row("WhatsApp"));
    expect(pairing()).toBeUndefined();
    await click(button("OPEN CHAT"));
    expect(onComplete).toHaveBeenCalledWith("whatsapp");
  });

  it("shows the failure to record a choice and keeps the rows available", async () => {
    completeError = true;
    await mount();
    expect(alert()?.props.text).toBe("Couldn't wake Ship.");
    expect(row("Continue here")).toBeDefined();
  });
});
