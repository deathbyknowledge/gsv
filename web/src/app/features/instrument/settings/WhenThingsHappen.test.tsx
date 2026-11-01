import type { NoticeRule, ResponsibilitySourcePolicy } from "@humansandmachines/gsv/protocol";
import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { SettingsError } from "./settingsShared";
import { WhenThingsHappen } from "./WhenThingsHappen";

type Box = VNode<JSX.InputHTMLAttributes<HTMLInputElement>>;

const OWNER: ConsoleAccount = { uid: 1000, username: "owner", displayName: "Owner", gecos: "", relation: "self", runnable: false, capabilities: ["notify.rule.*", "r12y.source.*"] };
const RULES: NoticeRule[] = [
  { kind: "contact.request", notify: "messenger", defaultNotify: "messenger" },
  { kind: "contact.message", notify: "none", defaultNotify: "messenger", changedBy: "ship", updatedAtMs: 1 },
  { kind: "contact.invite.accepted", notify: "messenger", defaultNotify: "messenger" },
];
const SOURCES = [
  { id: "interaction.response", name: "Conversation replies", description: "", control: "required", enabled: true, defaultEnabled: true },
  { id: "mail.received", name: "Incoming mail", description: "", control: "configurable", enabled: true, defaultEnabled: true },
  { id: "memory.review", name: "Personal memory", description: "", control: "configurable", enabled: false, defaultEnabled: true },
] satisfies ResponsibilitySourcePolicy[];

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: new URL("https://ship.example/chat/settings") });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({
    state: "connected", url: "wss://ship.example/ws", username: "owner", connectionId: null, message: null,
  });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(account = OWNER) {
  const root = createTestRoot("When things happen");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let tree: ComponentChildren;
  function Harness() { tree = WhenThingsHappen({ account }); return null; }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  // SAFETY: every input this section renders is a checkbox.
  const box = (name: string) => collectNodes(tree).find((node) => node.type === "input" && node.props["aria-label"] === name) as Box | undefined;
  // SAFETY: the section renders one SettingsError once it is past its access check.
  const error = () => (collectNodes(tree).find((node) => node.type === SettingsError) as VNode<{ error: Error | null }>).props.error;
  // SAFETY: the change handlers read only currentTarget.checked.
  const toggle = (target: Box, checked: boolean) => act(() => target.props.onChange?.({ currentTarget: { checked } } as JSX.TargetedEvent<HTMLInputElement>));
  return { box, error, toggle, text: () => collectText(tree), async close() { await root.unmount(); cache.clear(); } };
}

function gateway(overrides: Record<string, () => object> = {}) {
  return vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (overrides[call]) return { data: overrides[call]() };
    if (call === "notify.rule.list") return { data: { rules: RULES } };
    if (call === "r12y.source.list") return { data: { sources: SOURCES } };
    throw new Error(`Unexpected request: ${call} ${JSON.stringify(args)}`);
  });
}

it("joins notice rules and sources by event, and keeps upkeep and duties out of the table", async () => {
  gateway();
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.box("Mail arrives: Ship handles it")).toBeDefined());
    expect(screen.box("Someone asks to message you: Tell me")?.props.checked).toBe(true);
    expect(screen.box("A contact messages you: Tell me")?.props.checked).toBe(false);
    expect(screen.box("Mail arrives: Tell me")).toBeUndefined();
    expect(screen.box("Someone asks to message you: Ship handles it")).toBeUndefined();
    const text = screen.text();
    expect(text).toContain("Your Ship changed this.");
    expect(text).toContain("you decide");
    expect(text).toContain("set per person");
    expect(text).toContain("Review conversations for memory");
    expect(text).not.toContain("Conversation replies");
    expect(text).toContain("Always on: replying to you, delegated work and your routines.");
  } finally { await screen.close(); }
});

it("saves each column through its own call", async () => {
  const request = gateway({
    "notify.rule.set": () => ({ rule: { ...RULES[0]!, notify: "none", changedBy: "person", updatedAtMs: 2 } }),
    "r12y.source.update": () => ({ source: SOURCES[1]! }),
  });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.box("Mail arrives: Ship handles it")).toBeDefined());
    await screen.toggle(screen.box("Someone asks to message you: Tell me")!, false);
    await vi.waitFor(() => expect(screen.box("Someone asks to message you: Tell me")?.props.checked).toBe(false));
    await vi.waitFor(() => expect(screen.box("Mail arrives: Ship handles it")?.props.disabled).toBe(false));
    await screen.toggle(screen.box("Mail arrives: Ship handles it")!, false);
    const writes = request.mock.calls.filter(([call]) => call === "notify.rule.set" || call === "r12y.source.update").map(([call, args]) => [call, args]);
    expect(writes).toEqual([
      ["notify.rule.set", { kind: "contact.request", notify: "none" }],
      ["r12y.source.update", { id: "mail.received", enabled: false }],
    ]);
  } finally { await screen.close(); }
});

it("keeps the saved choice and shows the error when a change fails", async () => {
  gateway({ "notify.rule.set": () => { throw new Error("Could not save"); } });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.box("Someone asks to message you: Tell me")).toBeDefined());
    await screen.toggle(screen.box("Someone asks to message you: Tell me")!, false);
    await vi.waitFor(() => expect(screen.error()?.message).toBe("Could not save"));
    expect(screen.box("Someone asks to message you: Tell me")?.props.checked).toBe(true);
  } finally { await screen.close(); }
});

it("doesn't ask for notice rules on root, which has none", async () => {
  const request = gateway();
  const screen = await mount({ ...OWNER, uid: 0, username: "root" });
  try {
    await vi.waitFor(() => expect(screen.box("Mail arrives: Ship handles it")).toBeDefined());
    expect(request.mock.calls.some(([call]) => call === "notify.rule.list")).toBe(false);
    expect(screen.box("Someone asks to message you: Tell me")).toBeUndefined();
  } finally { await screen.close(); }
});
