import type { ComponentChildren, VNode } from "preact";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Permissions } from "./Permissions";
import { MessengerConnections } from "./MessengerConnections";
import { MessengerPairing } from "./Telegram";

const service = vi.hoisted(() => ({ client: {}, config: vi.fn(), targets: vi.fn(), save: vi.fn(), connections: vi.fn() }));
vi.mock("../../../services/gateway/GatewayProvider", () => ({ useGateway: () => ({ client: service.client, connected: true }) }));
vi.mock("../../../services/system/consoleService", () => ({ loadConsoleConfig: service.config, loadConsoleTargets: service.targets, disconnectConsoleAdapterPairing: vi.fn() }));
vi.mock("./permissionService", () => ({ saveApprovalPolicy: service.save }));
vi.mock("./messengerConnectionsService", () => ({ loadMessengerConnections: service.connections, messengerConnectionStatus: () => "connected" }));
const account: ConsoleAccount = { uid: 1000, username: "owner", displayName: "Owner", relation: "self", runnable: false, gecos: "", capabilities: ["*"] };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("document", {}); service.targets.mockResolvedValue([]); service.save.mockResolvedValue({ ok: true }); });
afterEach(() => vi.unstubAllGlobals());

async function mount(component: () => ComponentChildren) {
  const root = createTestRoot("Settings controls");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let tree: ComponentChildren;
  function Harness() { tree = component(); return null; }
  await root.render(<QueryClientProvider client={cache}><Harness /></QueryClientProvider>);
  return { nodes: () => collectNodes(tree), async close() { await root.unmount(); cache.clear(); } };
}

it("keeps Slack and Discord connection controls disabled even when their adapters support pairing", async () => {
  service.connections.mockResolvedValue({ adapters: ["whatsapp", "telegram", "slack", "discord"].map((adapter) => ({ adapter, enabled: true, supportsPairing: true, canLink: true, accounts: [] })), links: [] });
  const screen = await mount(() => MessengerConnections({ account, active: true }));
  try {
    await vi.waitFor(() => expect(screen.nodes().filter((node) => node.props.class === "settings-messenger")).toHaveLength(4));
    for (const name of ["Slack", "Discord"]) {
      const section = screen.nodes().find((node) => node.props["aria-label"] === name)!;
      const connect = collectNodes(section).find((node) => node.type === "button")!;
      expect(connect.props.disabled).toBe(true);
      await act(() => connect.props.onClick?.());
      expect(screen.nodes().some((node) => node.type === MessengerPairing)).toBe(false);
    }
    const whatsapp = screen.nodes().find((node) => node.props["aria-label"] === "WhatsApp")!;
    expect(collectNodes(whatsapp).find((node) => node.type === "button")!.props.disabled).toBe(false);
  } finally { await screen.close(); }
});

it("reorders permission rules with arrows and removes a rule below its tool selector before saving", async () => {
  const rules = [{ match: "fs.*", action: "ask" }, { match: "web.*", action: "auto" }];
  service.config.mockResolvedValue([{ key: "users/1000/ai/tools/approval", value: JSON.stringify({ default: "ask", rules }), redacted: false }]);
  const screen = await mount(() => Permissions({ account, active: true, onDirty: () => {} }));
  try {
    await vi.waitFor(() => expect(screen.nodes().filter((node) => node.props.class === "settings-rule-tool")).toHaveLength(2));
    await act(() => screen.nodes().find((node) => node.props["aria-label"] === "move down")!.props.onClick?.());
    const toolGroup = screen.nodes().find((node) => node.props.class === "settings-rule-tool")!;
    expect(collectNodes(toolGroup).find((node) => node.type === "select")!.props.value).toBe("web.*");
    const remove = collectNodes(toolGroup).find((node) => node.type === "button" && collectText(node) === "remove")!;
    expect(remove).toBeDefined();
    await act(() => remove.props.onClick?.());
    // SAFETY: The form's submit handler only requires preventDefault.
    const form = screen.nodes().find((node) => node.type === "form") as VNode<{ onSubmit: (event: { preventDefault: () => void }) => void }>;
    await act(() => form.props.onSubmit({ preventDefault: () => {} }));
    await vi.waitFor(() => expect(service.save).toHaveBeenCalled());
    expect(JSON.parse(service.save.mock.calls[0][3]).rules).toEqual([rules[0]]);
  } finally { await screen.close(); }
});
