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

type Control = VNode<JSX.InputHTMLAttributes<HTMLInputElement>>;
type Choice = VNode<JSX.ButtonHTMLAttributes<HTMLButtonElement>>;

const OWNER: ConsoleAccount = { uid: 1000, username: "owner", displayName: "Owner", gecos: "", relation: "self", runnable: false, capabilities: ["notify.rule.*", "r12y.source.*"] };
const CONTACT = { defaultNotify: "messenger", defaultShip: "context", shipChoices: ["none", "context"] } as const;
const SOURCE = { defaultNotify: "none", defaultShip: "wake", shipChoices: ["none", "context", "wake"] } as const;
const RULES: NoticeRule[] = [
  { ...CONTACT, shipChoices: [...CONTACT.shipChoices], kind: "contact.request", notify: "messenger", ship: "context" },
  { ...CONTACT, shipChoices: [...CONTACT.shipChoices], kind: "contact.message", notify: "none", ship: "context", changedBy: "ship", updatedAtMs: 1 },
  { ...SOURCE, shipChoices: [...SOURCE.shipChoices], kind: "mail.received", notify: "none", ship: "wake" },
  { ...SOURCE, shipChoices: [...SOURCE.shipChoices], kind: "machine.added", notify: "none", ship: "none" },
];
const SOURCES = [
  { id: "interaction.response", name: "Conversation replies", description: "", control: "required", enabled: true, defaultEnabled: true },
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
  const control = (name: string) => {
    // SAFETY: this section labels each Tell me input by its aria-label.
    return collectNodes(tree).find((node) => node.type === "input" && node.props["aria-label"] === name) as Control | undefined;
  };
  const choice = (name: string) => {
    // SAFETY: this section labels each Ship choice button by its aria-label.
    return collectNodes(tree).find((node) => node.type === "button" && node.props["aria-label"] === name) as Choice | undefined;
  };
  const memory = () => {
    const label = collectNodes(tree).find((node) => node.type === "label");
    // SAFETY: the memory review row is the only enclosing label, around one checkbox.
    return label && collectNodes(label).find((node) => node.type === "input") as Control | undefined;
  };
  // SAFETY: the section renders one SettingsError once it is past its access check.
  const error = () => (collectNodes(tree).find((node) => node.type === SettingsError) as VNode<{ error: Error | null }>).props.error;
  // SAFETY: the change handlers read only currentTarget.checked.
  const change = (target: Control, currentTarget: { checked: boolean }) => act(() => target.props.onChange?.({ currentTarget } as JSX.TargetedEvent<HTMLInputElement>));
  // SAFETY: the Ship choice handler ignores its event.
  const pick = (target: Choice) => act(() => target.props.onClick?.({} as JSX.TargetedMouseEvent<HTMLButtonElement>));
  return { control, choice, pick, memory, error, change, text: () => collectText(tree), async close() { await root.unmount(); cache.clear(); } };
}

function gateway(overrides: Record<string, () => object> = {}) {
  return vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (overrides[call]) return { data: overrides[call]() };
    if (call === "notify.rule.list") return { data: { rules: RULES } };
    if (call === "r12y.source.list") return { data: { sources: SOURCES } };
    throw new Error(`Unexpected request: ${call} ${JSON.stringify(args)}`);
  });
}

it("gives every event the same two choices, offering only what its rule allows", async () => {
  gateway();
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.control("Tell me: Mail arrives")).toBeDefined());
    expect(screen.control("Tell me: Someone asks to message you")?.props.checked).toBe(true);
    expect(screen.control("Tell me: A contact messages you")?.props.checked).toBe(false);
    expect(screen.choice("Ship: Mail arrives: Acts")?.props["aria-checked"]).toBe(true);
    expect(screen.choice("Ship: Mail arrives: Sees it")?.props["aria-checked"]).toBe(false);
    expect(screen.choice("Ship: Someone asks to message you: Acts")).toBeUndefined();
    expect(screen.memory()?.props.checked).toBe(false);
    const text = screen.text();
    expect(text).toContain("Off");
    expect(text).toContain("Sees it");
    expect(text).toContain("Acts");
    expect(text).toContain("Your Ship changed this.");
    expect(text).toContain("Always on: replying to you, delegated work and your routines.");
    expect(text).not.toContain("Conversation replies");
  } finally { await screen.close(); }
});

it("warns only on the row nobody hears about", async () => {
  gateway();
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.choice("Ship: A new computer connects: Off")).toBeDefined());
    expect(screen.text().match(/Nobody will hear about this\./g)).toHaveLength(1);
  } finally { await screen.close(); }
});

it("saves each choice as a change to that event's rule", async () => {
  const request = gateway({
    "notify.rule.set": () => ({ rule: { ...RULES[2]!, ship: "context", changedBy: "person", updatedAtMs: 2 } }),
  });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.choice("Ship: Mail arrives: Sees it")).toBeDefined());
    await screen.pick(screen.choice("Ship: Mail arrives: Sees it")!);
    await vi.waitFor(() => expect(screen.choice("Ship: Mail arrives: Sees it")?.props["aria-checked"]).toBe(true));
    await vi.waitFor(() => expect(screen.control("Tell me: Mail arrives")?.props.disabled).toBe(false));
    await screen.change(screen.control("Tell me: Mail arrives")!, { checked: true });
    const writes = request.mock.calls.filter(([call]) => call === "notify.rule.set").map(([, args]) => args);
    expect(writes).toEqual([{ kind: "mail.received", ship: "context" }, { kind: "mail.received", notify: "messenger" }]);
  } finally { await screen.close(); }
});

it("keeps memory review as its own switch on its own source", async () => {
  const request = gateway({ "r12y.source.update": () => ({ source: SOURCES[1]! }) });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.memory()).toBeDefined());
    await screen.change(screen.memory()!, { checked: true });
    expect(request.mock.calls.filter(([call]) => call === "r12y.source.update").map(([, args]) => args)).toEqual([{ id: "memory.review", enabled: true }]);
  } finally { await screen.close(); }
});

it("keeps the saved choice and shows the error when a change fails", async () => {
  gateway({ "notify.rule.set": () => { throw new Error("Could not save"); } });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.control("Tell me: Someone asks to message you")).toBeDefined());
    await screen.change(screen.control("Tell me: Someone asks to message you")!, { checked: false });
    await vi.waitFor(() => expect(screen.error()?.message).toBe("Could not save"));
    expect(screen.control("Tell me: Someone asks to message you")?.props.checked).toBe(true);
  } finally { await screen.close(); }
});

it("doesn't ask for rules on root, which has none", async () => {
  const request = gateway();
  const screen = await mount({ ...OWNER, uid: 0, username: "root" });
  try {
    await vi.waitFor(() => expect(screen.memory()).toBeDefined());
    expect(request.mock.calls.some(([call]) => call === "notify.rule.list")).toBe(false);
    expect(screen.control("Tell me: Mail arrives")).toBeUndefined();
  } finally { await screen.close(); }
});
