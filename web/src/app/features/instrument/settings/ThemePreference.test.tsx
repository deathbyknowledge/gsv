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
    signInTheme = useColorTheme("light").theme;
    return null;
  }
  // SAFETY: Appearance renders one native select with a native change handler.
  const select = () => collectNodes(tree).find((node) => node.type === "select") as VNode<JSX.SelectHTMLAttributes<HTMLSelectElement>>;
  try {
    await root.render(<Harness />);
    expect(select().props.value).toBe("");
    expect(collectText(tree)).toContain("Default");
    expect(stored.has("gsv.instrument.theme")).toBe(false);
    expect(signInTheme!).toBe("light");

    // SAFETY: The select's handler reads only currentTarget.value.
    await act(() => select().props.onChange?.({ currentTarget: { value: "light" } } as JSX.TargetedEvent<HTMLSelectElement>));
    expect(select().props.value).toBe("light");
    expect(stored.get("gsv.instrument.theme")).toBe("light");
    expect(signInTheme!).toBe("light");
  } finally { await root.unmount(); }
});

it.each([false, true])("hides stars across the app and sign-in with blocked storage: %s", async (blocked) => {
  vi.resetModules();
  const stored = new Map<string, string>();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("storage blocked"); return stored.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("storage blocked"); stored.set(key, value); },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }));
  const { ThemePreference } = await import("./ThemePreference");
  const { InstrumentBackdrop } = await import("../shared/InstrumentBackdrop");
  const { GlyphStars } = await import("../../session/backgrounds/GlyphStars");
  let controls: ComponentChildren;
  let background: ComponentChildren;
  function Appearance() { controls = ThemePreference(); return null; }
  function Backdrop() { background = InstrumentBackdrop(); return null; }
  // SAFETY: Appearance's checkbox handler reads only currentTarget.checked.
  const checkbox = () => collectNodes(controls).find((node) => node.type === "input") as VNode<JSX.InputHTMLAttributes<HTMLInputElement>>;
  const stars = () => collectNodes(background).filter((node) => node.type === GlyphStars);
  const root = createTestRoot("Stars preference");
  try {
    await root.render(<><Appearance /><Backdrop /></>);
    expect(checkbox().props.checked).toBe(true);
    expect(stars()).toHaveLength(1);
    // SAFETY: The checkbox handler reads only currentTarget.checked.
    await act(() => checkbox().props.onChange?.({ currentTarget: { checked: false } } as JSX.TargetedEvent<HTMLInputElement>));
    expect(checkbox().props.checked).toBe(false);
    expect(stars()).toHaveLength(0);
    if (!blocked) expect(stored.get("gsv.instrument.stars")).toBe("false");

    // Leaving the signed-in view mounts a fresh background without the settings controls.
    await root.render(null);
    await root.render(<Backdrop />);
    expect(stars()).toHaveLength(0);
    await root.render(<><Appearance /><Backdrop /></>);
    expect(checkbox().props.checked).toBe(false);
    // SAFETY: The checkbox handler reads only currentTarget.checked.
    await act(() => checkbox().props.onChange?.({ currentTarget: { checked: true } } as JSX.TargetedEvent<HTMLInputElement>));
    expect(stars()).toHaveLength(1);
    if (!blocked) expect(stored.get("gsv.instrument.stars")).toBe("true");
  } finally { await root.unmount(); }
});
