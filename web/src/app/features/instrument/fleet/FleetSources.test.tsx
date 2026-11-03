import type { EventSource } from "@humansandmachines/gsv/protocol";
import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { useEventSources } from "../shared/useEventSources";
import { NewSource, SourceInspector, SourcesSection } from "./FleetSources";

const BACKUPS: EventSource = {
  sourceId: "src_backups", name: "backups", label: "Backups", notify: "messenger", ship: "none", shipChoices: ["none", "context", "wake"],
  webhook: "none", enabled: true, createdBy: "person", updatedAtMs: 1,
};
const GITHUB: EventSource = {
  ...BACKUPS, sourceId: "src_github", name: "github", label: "GitHub", lastEventAtMs: 1_000, webhook: "hmac",
  hmac: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", idHeader: "x-github-delivery", typeHeader: "x-github-event" },
};
const SHOP: EventSource = {
  ...BACKUPS, sourceId: "src_shop", name: "shop", label: "Shop", webhook: "hmac", senderSecret: true, awaitingSecret: true,
  hmac: { header: "x-shop-signature", encoding: "base64" },
};

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: new URL("https://ship.example/fleet"), confirm: () => true });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({
    state: "connected", url: "wss://ship.example/ws", username: "owner", connectionId: null, message: null,
  });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function gateway(sources: EventSource[]) {
  return vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "event.source.list") return { data: { sources } };
    if (call === "event.list") return { data: { events: [{ sourceId: "src_github", eventId: "1", title: "Deploy failed", preview: "On main", body: "The whole log", emittedBy: "webhook", receivedAtMs: 1_000 }] } };
    if (call === "event.source.rotate") return { data: { source: GITHUB, secret: "fresh-secret", webhookUrl: "https://ship.example/hooks/github" } };
    if (call === "event.source.remove") return { data: { removed: true } };
    if (call === "event.source.add") return { data: { source: SHOP, webhookUrl: "https://ship.example/hooks/src_shop" } };
    throw new Error(`Unexpected request: ${call} ${JSON.stringify(args)}`);
  });
}

async function mount(view: (events: ReturnType<typeof useEventSources>) => ComponentChildren) {
  const root = createTestRoot("Sources");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let tree: ComponentChildren;
  let current: ReturnType<typeof useEventSources> | null = null;
  function Harness() { current = useEventSources(true); tree = view(current); return null; }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  const button = (label: string) => {
    // SAFETY: only the buttons' click handlers are read, and they ignore their event.
    const found = collectNodes(tree).find((node) => node.type === "button" && collectText(node).includes(label)) as VNode<JSX.ButtonHTMLAttributes<HTMLButtonElement>> | undefined;
    // SAFETY: the same handlers ignore their event.
    return { found, press: () => act(() => found?.props.onClick?.({} as JSX.TargetedMouseEvent<HTMLButtonElement>)) };
  };
  /** A field's handlers, found by its label; each runs as a user's change would. */
  const field = (label: string) => {
    // SAFETY: the form's fields are TextInput and Select, whose handlers take a string.
    const found = collectNodes(tree).find((node) => node.props && (node.props as { label?: unknown }).label === label) as VNode<{ onChange?: (value: string) => void; onSelect?: (value: string) => void }> | undefined;
    if (!found) throw new Error(`no field labelled ${label}`);
    return {
      onChange: (value: string) => act(() => found.props.onChange?.(value)),
      onSelect: (value: string) => act(() => found.props.onSelect?.(value)),
    };
  };
  const submit = () => {
    // SAFETY: the form's submit handler only calls preventDefault on its event.
    const form = collectNodes(tree).find((node) => node.type === "form") as VNode<JSX.HTMLAttributes<HTMLFormElement>> | undefined;
    // SAFETY: as above.
    return act(() => form?.props.onSubmit?.({ preventDefault: () => {} } as JSX.TargetedSubmitEvent<HTMLFormElement>));
  };
  return { button, field, submit, events: () => {
    if (!current) throw new Error("not rendered");
    return current;
  }, text: () => collectText(tree), async close() { await root.unmount(); cache.clear(); } };
}

const inspector = (events: ReturnType<typeof useEventSources>, source: EventSource, onRemoved = () => {}) =>
  SourceInspector({ source, events, canChange: true, canRead: true, now: 2_000, onChoices: () => {}, onRemoved });

it("lists each source with how its events arrive and when one last came", async () => {
  gateway([BACKUPS, GITHUB]);
  const screen = await mount((events) => SourcesSection({ events, canChange: true, now: 2_000, onSelect: () => {}, onCreate: () => {} }));
  try {
    await vi.waitFor(() => expect(screen.text()).toContain("GitHub webhook"));
    expect(screen.text()).toContain("never");
    expect(screen.text()).toContain("Backups");
  } finally { await screen.close(); }
});

it("shows what arrived for this source only", async () => {
  const request = gateway([GITHUB]);
  const screen = await mount((events) => inspector(events, GITHUB));
  try {
    await vi.waitFor(() => expect(screen.text()).toContain("Deploy failed"));
    expect(screen.text()).toContain("from a webhook");
    expect(request).toHaveBeenCalledWith("event.list", { source: "github", limit: 20 });
  } finally { await screen.close(); }
});

it("shows a new secret on its own source, not on another one", async () => {
  gateway([BACKUPS, GITHUB]);
  const own = await mount((events) => inspector(events, GITHUB));
  try {
    await vi.waitFor(() => expect(own.button("New secret").found).toBeDefined());
    expect(own.text()).not.toContain("fresh-secret");
    await own.button("New secret").press();
    await vi.waitFor(() => expect(own.text()).toContain("fresh-secret"));
    await act(() => own.events().clearRevealed());
    await vi.waitFor(() => expect(own.text()).not.toContain("fresh-secret"));
  } finally { await own.close(); }
  const other = await mount((events) => inspector(events, BACKUPS));
  try {
    await act(() => { other.events().rotate.mutate({ name: "github" }); });
    await vi.waitFor(() => expect(other.events().revealed?.secret).toBe("fresh-secret"));
    expect(other.text()).not.toContain("fresh-secret");
  } finally { await other.close(); }
});

it("deletes only after asking, then leaves the details", async () => {
  const request = gateway([GITHUB]);
  const onRemoved = vi.fn();
  const screen = await mount((events) => inspector(events, GITHUB, onRemoved));
  try {
    await vi.waitFor(() => expect(screen.button("Delete").found).toBeDefined());
    vi.stubGlobal("window", { location: new URL("https://ship.example/fleet"), confirm: () => false });
    await screen.button("Delete").press();
    expect(request).not.toHaveBeenCalledWith("event.source.remove", expect.anything());
    vi.stubGlobal("window", { location: new URL("https://ship.example/fleet"), confirm: () => true });
    await screen.button("Delete").press();
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("event.source.remove", { name: "github" });
  } finally { await screen.close(); }
});

it("names a sender only when a source's signature is that sender's, and shows one waiting for its sender's secret", async () => {
  gateway([GITHUB, SHOP]);
  const list = await mount((events) => SourcesSection({ events, canChange: true, now: 2_000, onSelect: () => {}, onCreate: () => {} }));
  try {
    await vi.waitFor(() => expect(list.text()).toContain("GitHub webhook"));
    expect(list.text()).toContain("Other signed webhook (HMAC)");
    expect(list.text()).toContain("needs its secret");
  } finally { await list.close(); }
  const details = await mount((events) => inspector(events, SHOP));
  try {
    await vi.waitFor(() => expect(details.text()).toContain("every delivery is refused"));
    expect(details.text()).toContain("x-shop-signature");
    expect(details.button("New secret").found).toBeUndefined();
  } finally { await details.close(); }
});

it("adds a preset as the scheme its sender signs with", async () => {
  const request = gateway([]);
  const screen = await mount((events) => NewSource({ events, disabled: false, onAdded: () => {} }));
  try {
    await screen.field("Name").onChange("pay");
    await screen.field("How they arrive").onSelect("stripe");
    await screen.submit();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("event.source.add", {
      name: "pay", webhook: "hmac", hmac: { header: "stripe-signature", encoding: "hex", pairs: { timestamp: "t", signature: "v1" } }, senderSecret: true,
    }));
  } finally { await screen.close(); }
});
