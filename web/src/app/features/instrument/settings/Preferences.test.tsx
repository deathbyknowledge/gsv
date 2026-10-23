import type { ComponentChildren } from "preact";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsoleAccount, ConsoleConfigEntry } from "../../../domain/system/consoleModels";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Language } from "./Language";
import { Timezone } from "./Timezone";
import { ThemePreference } from "./ThemePreference";
import { Preferences } from "./Preferences";

const service = vi.hoisted(() => ({ client: {}, loadConfig: vi.fn(), loadModels: vi.fn(), save: vi.fn() }));
vi.mock("../../../services/gateway/GatewayProvider", () => ({ useGateway: () => ({ client: service.client, connected: true }) }));
vi.mock("../../../services/system/consoleService", () => ({
  loadConsoleConfig: service.loadConfig, loadConsoleModels: service.loadModels, saveConsoleConfigEntries: service.save,
}));
const account: ConsoleAccount = { uid: 1000, username: "owner", displayName: "Owner", relation: "self", runnable: false, gecos: "", capabilities: ["sys.config.*"] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: new URL("https://ship.example/chat/settings"), history: { state: { gsvAppIndex: 0 } }, confirm: vi.fn(() => false),
  }));
  let config: ConsoleConfigEntry[] = [];
  service.loadConfig.mockImplementation(async () => config);
  service.loadModels.mockResolvedValue({ models: [], preferredModelId: null });
  service.save.mockImplementation(async (_client, { entries }: { entries: { key: string; value: string }[] }) => {
    config = [...config.filter((entry) => !entries.some((next) => next.key === entry.key)), ...entries.map((entry) => ({ ...entry, redacted: false }))];
    return { ok: true, written: entries.length };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  const root = createTestRoot("Shared preferences save");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const dirty = vi.fn();
  let tree: ComponentChildren;
  function Harness() { tree = Preferences({ account, active: true, onDirty: dirty }); return null; }
  await root.render(<QueryClientProvider client={cache}><Harness /></QueryClientProvider>);
  await vi.waitFor(() => expect(collectNodes(tree).some((node) => node.type === Language)).toBe(true));
  const nodes = () => collectNodes(tree);
  const save = () => nodes().find((node) => node.type === "button" && collectText(node.props.children) === "Save changes")!;
  return { nodes, save, dirty, text: () => collectText(tree), async close() { await root.unmount(); cache.clear(); } };
}

it("puts appearance first and saves language and timezone through one action", async () => {
  const screen = await mount();
  try {
    expect(screen.nodes().findIndex((node) => node.type === ThemePreference)).toBeLessThan(screen.nodes().findIndex((node) => node.props.class === "settings-model-heading"));
    expect(screen.save().props.disabled).toBe(true);
    await act(() => {
      screen.nodes().find((node) => node.type === Language)!.props.onChange!("pt-BR");
      screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Europe/Amsterdam");
    });
    expect(service.save).not.toHaveBeenCalled();
    expect(screen.save().props.disabled).toBe(false);
    expect(screen.dirty).toHaveBeenLastCalledWith(true);
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
    expect(service.save).toHaveBeenCalledWith(service.client, { entries: [
      { key: "users/1000/locale/language", value: "pt-BR" },
      { key: "users/1000/locale/timezone", value: "Europe/Amsterdam" },
    ] });
    expect(screen.text()).toContain("saved");
  } finally { await screen.close(); }
});

it("keeps every draft after a save failure and validates before any write", async () => {
  const screen = await mount();
  try {
    await act(() => {
      screen.nodes().find((node) => node.type === Language)!.props.onChange!("nl");
      screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Mars/Olympus");
    });
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.nodes().some((node) => "error" in node.props && node.props.error instanceof Error)).toBe(true));
    expect(service.save).not.toHaveBeenCalled();
    await act(() => screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Europe/Amsterdam"));
    service.save.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.save().props.disabled).toBe(false));
    expect(screen.nodes().find((node) => node.type === Language)!.props.value).toBe("nl");
    expect(screen.nodes().find((node) => node.type === Timezone)!.props.value).toBe("Europe/Amsterdam");
    expect(screen.dirty).toHaveBeenLastCalledWith(true);
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
  } finally { await screen.close(); }
});
