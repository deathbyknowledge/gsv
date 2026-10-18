import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";

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
  const root = createTestRoot("Appearance");
  let tree: ComponentChildren;
  let signInTheme: string;
  function Harness() {
    tree = ThemePreference();
    signInTheme = useColorTheme("dark").theme;
    return null;
  }
  // SAFETY: Appearance renders one native select with a native change handler.
  const select = () => collectNodes(tree).find((node) => node.type === "select") as VNode<JSX.SelectHTMLAttributes<HTMLSelectElement>>;
  try {
    await root.render(<Harness />);
    expect(select().props.value).toBe("");
    expect(collectText(tree)).toContain("Default");
    expect(stored.has("gsv.instrument.theme")).toBe(false);
    expect(signInTheme!).toBe("dark");

    // SAFETY: The select's handler reads only currentTarget.value.
    await act(() => select().props.onChange?.({ currentTarget: { value: "light" } } as JSX.TargetedEvent<HTMLSelectElement>));
    expect(select().props.value).toBe("light");
    expect(stored.get("gsv.instrument.theme")).toBe("light");
    expect(signInTheme!).toBe("light");
  } finally { await root.unmount(); }
});
