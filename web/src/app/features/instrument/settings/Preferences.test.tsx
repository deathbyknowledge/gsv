import type { ComponentChildren } from "preact";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Language } from "./Language";
import { Timezone } from "./Timezone";
import { ThemePreference } from "./ThemePreference";
import { Preferences } from "./Preferences";

import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { settingsGatewayFixture } from "./settingsGatewayFixture";

let gateway: ReturnType<typeof settingsGatewayFixture>;
const account: ConsoleAccount = { uid: 1000, username: "owner", displayName: "Owner", relation: "self", runnable: false, gecos: "", capabilities: ["sys.config.*"] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: new URL("https://ship.example/chat/settings"), history: { state: { gsvAppIndex: 0 } }, confirm: vi.fn(() => false),
  }));
  gateway = settingsGatewayFixture();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  const root = createTestRoot("Shared preferences save");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const dirty = vi.fn();
  let tree: ComponentChildren;
  function Harness() { tree = Preferences({ account, active: true, onDirty: dirty }); return null; }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
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
    expect(gateway.write).not.toHaveBeenCalled();
    expect(screen.save().props.disabled).toBe(false);
    expect(screen.dirty).toHaveBeenLastCalledWith(true);
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
    expect(gateway.write.mock.calls.map(([entry]) => entry)).toEqual([
      { key: "users/1000/locale/language", value: "pt-BR" },
      { key: "users/1000/locale/timezone", value: "Europe/Amsterdam" },
    ]);
    expect(screen.text()).toContain("saved");
  } finally { await screen.close(); }
});

it("keeps every draft after a save failure and validates before any write", async () => {
  const screen = await mount();
  try {
    await act(() => {
      screen.nodes().find((node) => node.type === Language)!.props.onChange!("es");
      screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Mars/Olympus");
    });
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.nodes().some((node) => "error" in node.props && node.props.error instanceof Error)).toBe(true));
    expect(gateway.write).not.toHaveBeenCalled();
    await act(() => screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Europe/Amsterdam"));
    gateway.write.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.save().props.disabled).toBe(false));
    expect(screen.nodes().find((node) => node.type === Language)!.props.value).toBe("es");
    expect(screen.nodes().find((node) => node.type === Timezone)!.props.value).toBe("Europe/Amsterdam");
    expect(screen.dirty).toHaveBeenLastCalledWith(true);
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
  } finally { await screen.close(); }
});

it("preserves an unsupported saved language until the owner explicitly replaces it", async () => {
  gateway = settingsGatewayFixture([{ key: "users/1000/locale/language", value: "fr", redacted: false }]);
  const screen = await mount();
  const language = () => screen.nodes().find((node) => node.type === Language)!;
  try {
    expect(language().props.value).toBe("fr");
    await act(() => screen.nodes().find((node) => node.type === Timezone)!.props.onChange!("Europe/Amsterdam"));
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
    expect(gateway.write.mock.calls.map(([entry]) => entry)).toEqual([
      { key: "users/1000/locale/timezone", value: "Europe/Amsterdam" },
    ]);
    expect(language().props.value).toBe("fr");
    gateway.write.mockClear();
    await act(() => language().props.onChange!("en"));
    expect(screen.save().props.disabled).toBe(false);
    await act(async () => { await screen.save().props.onClick!(); });
    await vi.waitFor(() => expect(screen.dirty).toHaveBeenLastCalledWith(false));
    expect(gateway.write.mock.calls.map(([entry]) => entry)).toEqual([
      { key: "users/1000/locale/language", value: "en" },
    ]);
    expect(language().props.value).toBe("en");
  } finally { await screen.close(); }
});
