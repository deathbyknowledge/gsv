import { describe, expect, it } from "vitest";
import { shortcutDefaults, shortcutFromKey, shortcutFromMouse, shortcutLabel } from "./shortcutKeys";

const key = (code: string, options = {}) => ({ code, key: code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, getModifierState: () => false, ...options });

describe("voice shortcut keys", () => {
  it("captures physical keys with platform modifiers, without consuming ordinary typing", () => {
    expect(shortcutFromKey(key("Space", { ctrlKey: true, shiftKey: true })).shortcut).toBe("Ctrl+Shift+Space");
    expect(shortcutFromKey(key("KeyV", { metaKey: true })).shortcut).toBe("Super+KeyV");
    expect(shortcutFromKey(key("KeyA")).error).toBeTruthy();
    expect(shortcutFromKey(key("KeyA", { shiftKey: true })).error).toBeTruthy();
    expect(shortcutFromKey(key("F9")).shortcut).toBe("F9");
  });

  it("handles cancellation, held keys, and composition without recording accidental shortcuts", () => {
    expect(shortcutFromKey(key("Escape")).cancel).toBe(true);
    expect(shortcutFromKey(key("Tab")).cancel).toBe(true);
    expect(shortcutFromKey(key("Escape", { altKey: true })).shortcut).toBe("Alt+Escape");
    expect(shortcutFromKey(key("ControlLeft", { ctrlKey: true }))).toEqual({});
    expect(shortcutFromKey(key("Space", { ctrlKey: true, repeat: true }))).toEqual({});
    expect(shortcutFromKey(key("KeyE", { isComposing: true }))).toEqual({});
  });

  it("records the physical key when Option or AltGr changes the character", () => {
    const altGraph = (name: string) => name === "AltGraph";
    // macOS reports Option as AltGraph, and Option+letter types an accent or a symbol.
    expect(shortcutFromKey(key("Space", { key: " ", altKey: true, getModifierState: altGraph })).shortcut).toBe("Alt+Space");
    expect(shortcutFromKey(key("KeyE", { key: "Dead", altKey: true, getModifierState: altGraph })).shortcut).toBe("Alt+KeyE");
    expect(shortcutFromKey(key("KeyV", { key: "√", altKey: true, getModifierState: altGraph })).shortcut).toBe("Alt+KeyV");
    // Windows layouts with AltGr, such as Spanish, report Ctrl+Alt as AltGraph.
    expect(shortcutFromKey(key("Escape", { ctrlKey: true, altKey: true, getModifierState: altGraph })).shortcut).toBe("Ctrl+Alt+Escape");
  });

  it("refuses the mouse back and forward buttons with an explanation instead of navigating", () => {
    expect(shortcutFromMouse({ button: 3 })).toEqual({ error: "desktop.shortcut.errors.mouse" });
    expect(shortcutFromMouse({ button: 4 })).toEqual({ error: "desktop.shortcut.errors.mouse" });
    expect(shortcutFromMouse({ button: 0 })).toBeNull();
    expect(shortcutFromMouse({ button: 2 })).toBeNull();
  });

  it("offers platform defaults and readable labels for existing and captured shortcuts", () => {
    expect(shortcutDefaults("MacIntel").talk).toBe("Alt+Space");
    expect(shortcutDefaults("Win32").talk).toBe("Ctrl+Shift+Space");
    expect(shortcutDefaults("Linux x86_64").talk).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("Alt+Space", "MacIntel")).toBe("⌥ Space");
    expect(shortcutLabel("Super+KeyV", "Win32")).toBe("Win + V");
    expect(shortcutLabel("Ctrl+Alt+Escape", "Linux")).toBe("Ctrl + Alt + Esc");
  });
});
