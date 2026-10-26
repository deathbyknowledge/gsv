import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import type { SelectProps } from "../../../components/ui/Select";

afterEach(() => vi.unstubAllGlobals());

it("lets a fresh device pin Light directly instead of presenting it as already saved", async () => {
  vi.resetModules();
  const stored = new Map<string, string>();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }));
  const { ThemePreference } = await import("./ThemePreference");
  const { useColorTheme } = await import("../../../components/ui/useColorTheme");
  const { Select } = await import("../../../components/ui/Select");
  const root = createTestRoot("Appearance");
  let tree: ComponentChildren;
  let signInTheme: string;
  function Harness() {
    tree = ThemePreference();
    signInTheme = useColorTheme("dark").theme;
    return null;
  }
  // SAFETY: Appearance renders one design-system Select.
  const select = () => collectNodes(tree).find((node) => node.type === Select) as VNode<SelectProps>;
  try {
    await root.render(<Harness />);
    expect(select().props.selected).toBe("");
    expect(select().props.options).not.toContainEqual(expect.objectContaining({ value: "" }));
    expect(select().props.placeholder).toBe("Default");
    expect(stored.has("gsv.instrument.theme")).toBe(false);
    expect(signInTheme!).toBe("dark");

    await act(() => select().props.onSelect?.("light"));
    expect(select().props.selected).toBe("light");
    expect(stored.get("gsv.instrument.theme")).toBe("light");
    expect(signInTheme!).toBe("light");
  } finally { await root.unmount(); }
});
