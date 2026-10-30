import type { ComponentChildren, JSX, VNode } from "preact";
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

it.each([false, true])("keeps the chat stars off until asked, on this device, with blocked storage: %s", async (blocked) => {
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
    expect(checkbox().props.checked).toBe(false);
    expect(stars()).toHaveLength(0);
    // SAFETY: The checkbox handler reads only currentTarget.checked.
    await act(() => checkbox().props.onChange?.({ currentTarget: { checked: true } } as JSX.TargetedEvent<HTMLInputElement>));
    expect(checkbox().props.checked).toBe(true);
    expect(stars()).toHaveLength(1);
    if (!blocked) expect(stored.get("gsv.instrument.stars")).toBe("true");

    // Leaving the signed-in view mounts a fresh background without the settings controls.
    await root.render(null);
    await root.render(<Backdrop />);
    expect(stars()).toHaveLength(1);
    await root.render(<><Appearance /><Backdrop /></>);
    expect(checkbox().props.checked).toBe(true);
    // SAFETY: The checkbox handler reads only currentTarget.checked.
    await act(() => checkbox().props.onChange?.({ currentTarget: { checked: false } } as JSX.TargetedEvent<HTMLInputElement>));
    expect(stars()).toHaveLength(0);
    if (!blocked) expect(stored.get("gsv.instrument.stars")).toBe("false");

    // Sign-in keeps its stars whatever the chat preference says.
    function SignInBackdrop() { background = InstrumentBackdrop({ stars: true }); return null; }
    await root.render(<SignInBackdrop />);
    expect(stars()).toHaveLength(1);
  } finally { await root.unmount(); }
});
