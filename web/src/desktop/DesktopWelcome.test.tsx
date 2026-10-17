import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WelcomeSnapshot, WelcomeState } from "../app/services/session/ownerWelcome";
import { collectNodes, collectText, createTestRoot } from "../app/testing/testHarness";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("shows the configured Ship address in fresh Desktop signup before verification", async () => {
  vi.stubEnv("VITE_GSV_PUBLIC_CONFIG", JSON.stringify({ primaryDomain: "fleet.example", accountsOrigin: "https://identity.example" }));
  vi.stubGlobal("document", { getElementById: () => null });
  let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
  vi.stubGlobal("window", { __TAURI__: { core: { invoke: async (command: string, args?: { value: WelcomeState }) => {
    if (command === "desktop_welcome") return snapshot;
    if (command === "desktop_save_welcome") return snapshot = { revision: crypto.randomUUID(), value: args!.value };
    throw new Error(`Unexpected native command: ${command}`);
  } } } });
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const { DesktopWelcome } = await import("./DesktopWelcome");
  const { OwnerWelcomeScreen } = await import("../app/features/session/OwnerWelcomeScreen");
  const { TextInput } = await import("../app/components/ui/TextInput");
  const welcome = DesktopWelcome({ ready: true, resume: false, onConnect: vi.fn() });
  expect(welcome.type).toBe(OwnerWelcomeScreen);
  let tree: ComponentChildren;
  function Harness() { tree = OwnerWelcomeScreen(welcome.props); return null; }
  const root = createTestRoot("Desktop signup address");
  try {
    await root.render(<Harness />);
    const create = () => collectNodes(tree).find((node) => node.props["aria-label"] === "Create your ship")!;
    await vi.waitFor(() => expect(create().props.disabled).toBe(false));
    await act(() => { create().props.onClick?.(); });
    await vi.waitFor(() => expect(collectText(tree)).toMatch(/Ship address\s+your-name\s*\.\s*fleet\.example/));
    const handle = collectNodes(tree).find((node) => node.type === TextInput && node.props.label === "Handle")!;
    await act(() => { handle.props.onChange?.("luna"); });
    expect(collectText(tree)).toMatch(/Ship address\s+luna\s*\.\s*fleet\.example/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await root.unmount(); }
});
