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
import { TextInput } from "../../../components/ui/TextInput";
import { FirstRunPairing } from "./FirstRunPairing";

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
const request = vi.fn<GSVClient["request"]>();
const onPaired = vi.fn<() => void>();
const onFinish = vi.fn<() => void>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "person", connectionId: "test", message: null };

function Harness() { tree = FirstRunPairing({ adapter: "whatsapp", name: "WhatsApp", linked: false, disabled: false, onPaired, onFinish }); return null; }
const button = (label: string) => collectNodes(tree).find((node) => node.type === Button && node.props.label === label);
const field = () => collectNodes(tree).find((node) => node.type === TextInput)!;
const click = async (label: string) => { await act(async () => { await button(label)!.props.onClick!(); }); };
const type = async (value: string) => { await act(async () => { field().props.onChange!(value); }); };

beforeEach(async () => {
  request.mockReset();
  onPaired.mockReset();
  onFinish.mockReset();
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { location: { search: "", origin: "https://jessica.ship.space" } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
  request.mockImplementation(async (call, args) => {
    const { code } = z.object({ code: z.string().optional() }).parse(args);
    if (call === "adapter.pair.info") return { data: { adapter: "whatsapp", accountId: "managed", configured: true, installUrl: "https://wa.me/31612345678?text=%2Flink" } };
    if (code === "NOPE") throw new Error("Pairing code is invalid");
    if (call === "adapter.pair.inspect") return { data: { adapter: "whatsapp", accountId: "managed", actorId: "a1", surfaceId: "s1", actorName: "Jessica", actorHandle: "+31 •••• 78", expiresAt: 1, linked: false } };
    if (call === "adapter.pair.confirm") return { data: { paired: true, adapter: "whatsapp", accountId: "managed", actorId: "a1", surfaceId: "s1", uid: 1000 } };
    throw new Error(`Unexpected request ${call}`);
  });
  root = createTestRoot("first-run pairing");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(button("OPEN WHATSAPP")?.props.href).toBe("https://wa.me/31612345678?text=%2Flink"));
});
afterEach(async () => {
  await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first-run pairing", () => {
  it("leads with opening WhatsApp, then with connecting the code, and keeps the manual way folded", async () => {
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("primary");
    expect(button("CONNECT")?.props.variant).toBe("secondary");
    expect(collectNodes(tree).find((node) => node.type === "span" && node.props.class === "first-run-contact")?.props.children).toBe("+31612345678");
    await click("OPEN WHATSAPP");
    expect(button("OPEN WHATSAPP")?.props.variant).toBe("secondary");
    expect(button("CONNECT")?.props.variant).toBe("primary");
  });

  it("shows a rejected code inline, confirms who sent a good one, then leads back to WhatsApp", async () => {
    await type("nope");
    await click("CONNECT");
    await vi.waitFor(() => expect(field().props.message).toBe("Pairing code is invalid"));
    expect(field().props.status).toBe("error");

    await type("abcd-efgh-jklm");
    expect(field().props).toMatchObject({ value: "ABCD-EFGH-JKLM", status: "none" });
    await click("CONNECT");
    await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.type === Alert)?.props.text).toContain("Jessica · +31 •••• 78"));
    expect(request).toHaveBeenCalledWith("adapter.pair.inspect", { adapter: "whatsapp", code: "ABCD-EFGH-JKLM" });

    await click("YES, CONNECT THIS ACCOUNT");
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(button("OPEN WHATSAPP")?.props.href).toBe("https://wa.me/31612345678");
    await click("OPEN WHATSAPP");
    await click("OPEN CHAT HERE");
    expect(onFinish).toHaveBeenCalledTimes(2);
  });
});
