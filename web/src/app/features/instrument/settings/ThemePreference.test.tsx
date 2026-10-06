import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { ThemePreference } from "./ThemePreference";

const THEME_KEY = "gsv.instrument.theme";
type SelectProps = { value?: string; onChange?: (event: { currentTarget: { value: string } }) => void; children?: ComponentChildren };

let stored: Map<string, string>;
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
function Harness() { tree = ThemePreference(); return null; }
function select(): VNode<SelectProps> {
  // SAFETY: ThemePreference renders exactly one native select.
  const node = collectNodes(tree).find((candidate) => candidate.type === "select") as VNode<SelectProps> | undefined;
  if (!node) throw new Error("Missing select");
  return node;
}
const choose = (value: string) => act(() => select().props.onChange!({ currentTarget: { value } }));

beforeEach(async () => {
  stored = new Map();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener); },
    dispatchEvent: (event: Event) => { for (const listener of listeners.get(event.type) ?? []) listener(event); return true; },
  });
  root = createTestRoot("Theme preference");
  await root.render(<Harness />);
});
afterEach(async () => { await root.unmount(); vi.unstubAllGlobals(); });

describe("theme preference", () => {
  it("offers system, light and dark and starts by following the system", () => {
    expect(select().props.value).toBe("system");
    const options = collectNodes(select().props.children).filter((node) => node.type === "option");
    expect(options.map((option) => option.props.value)).toEqual(["system", "light", "dark"]);
    expect(collectText(tree)).toContain("this device only");
  });

  it("saves the choice on this device and shows it as selected", async () => {
    await choose("light");
    expect(stored.get(THEME_KEY)).toBe("light");
    expect(select().props.value).toBe("light");
    await choose("system");
    expect(stored.has(THEME_KEY)).toBe(false);
    expect(select().props.value).toBe("system");
  });

  it("ignores a value that is not one of the offered themes", async () => {
    await choose("purple");
    expect(stored.has(THEME_KEY)).toBe(false);
    expect(select().props.value).toBe("system");
  });
});
