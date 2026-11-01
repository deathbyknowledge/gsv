import type { NoticeRule } from "@humansandmachines/gsv/protocol";
import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { NoticeRules } from "./NoticeRules";
import { SettingsError } from "./settingsShared";

const RULES: NoticeRule[] = [
  { kind: "contact.request", notify: "messenger", defaultNotify: "messenger" },
  { kind: "contact.message", notify: "none", defaultNotify: "messenger", changedBy: "ship", updatedAtMs: 1 },
  { kind: "contact.invite.accepted", notify: "messenger", defaultNotify: "messenger" },
];

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: new URL("https://ship.example/chat/settings") });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({
    state: "connected", url: "wss://ship.example/ws", username: "owner", connectionId: null, message: null,
  });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  const root = createTestRoot("Notice rules");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let tree: ComponentChildren;
  function Harness() { tree = NoticeRules({ active: true }); return null; }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  // SAFETY: every input NoticeRules renders is a checkbox.
  const boxes = () => collectNodes(tree).filter((node) => node.type === "input") as VNode<JSX.InputHTMLAttributes<HTMLInputElement>>[];
  // SAFETY: NoticeRules renders one SettingsError.
  const error = () => (collectNodes(tree).find((node) => node.type === SettingsError) as VNode<{ error: Error | null }>).props.error;
  const uncheck = (box: VNode<JSX.InputHTMLAttributes<HTMLInputElement>>) =>
    // SAFETY: the change handler reads only currentTarget.checked.
    act(() => box.props.onChange?.({ currentTarget: { checked: false } } as JSX.TargetedEvent<HTMLInputElement>));
  return { boxes, error, uncheck, text: () => collectText(tree), async close() { await root.unmount(); cache.clear(); } };
}

it("shows each kind's delivery, says when the Ship changed it, and saves a change", async () => {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    if (call === "notify.rule.list") return { data: { rules: RULES } };
    if (call === "notify.rule.set") return { data: { rule: { ...RULES[0], ...args, changedBy: "person", updatedAtMs: 2 } } };
    throw new Error(`Unexpected request: ${call}`);
  });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.boxes()).toHaveLength(3));
    expect(screen.boxes().map((box) => box.props.checked)).toEqual([true, false, true]);
    expect(screen.text()).toContain("Your Ship changed this.");

    await screen.uncheck(screen.boxes()[0]!);

    expect(request.mock.calls.filter(([call]) => call === "notify.rule.set").map(([, args]) => args))
      .toEqual([{ kind: "contact.request", notify: "none" }]);
    await vi.waitFor(() => expect(screen.boxes()[0]!.props.checked).toBe(false));
  } finally { await screen.close(); }
});

it("keeps the saved delivery and shows the error when a change fails", async () => {
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "notify.rule.list") return { data: { rules: RULES } };
    throw new Error("Could not save");
  });
  const screen = await mount();
  try {
    await vi.waitFor(() => expect(screen.boxes()).toHaveLength(3));
    await screen.uncheck(screen.boxes()[0]!);
    await vi.waitFor(() => expect(screen.error()?.message).toBe("Could not save"));
    expect(screen.boxes()[0]!.props.checked).toBe(true);
  } finally { await screen.close(); }
});
