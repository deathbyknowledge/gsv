import { describe, expect, it } from "vitest";
import { shellShortcut, shellShortcutKeys } from "./shellKeys";

const press = (key: string, code: string, held: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = { alt: true }) => ({
  key, code, altKey: held.alt ?? false, ctrlKey: held.ctrl ?? false, metaKey: held.meta ?? false, shiftKey: held.shift ?? false,
});

describe("shell shortcuts", () => {
  it("opens each view, switches the theme and shows Help with Alt and a letter, in text too", () => {
    const pressed = ["c", "w", "m", "p", "s", "l", "h"].map((letter) => shellShortcut(press(letter, `Key${letter.toUpperCase()}`), false));
    expect(pressed).toEqual(["zen", "fleet", "memory", "people", "settings", "theme", "help"]);
    expect(shellShortcut(press("w", "KeyW"), true)).toBe("fleet");
  });

  it("leaves every unmodified key alone, so letters type", () => {
    for (const letter of ["c", "w", "m", "p", "s", "l", "h", "?"]) expect(shellShortcut(press(letter, `Key${letter.toUpperCase()}`, {}), false)).toBeNull();
  });

  it("ignores other modifiers, including AltGr on Windows", () => {
    expect(shellShortcut(press("c", "KeyC", { alt: true, ctrl: true }), false)).toBeNull();
    expect(shellShortcut(press("C", "KeyC", { alt: true, shift: true }), false)).toBeNull();
    expect(shellShortcut(press("c", "KeyC", { alt: true, meta: true }), false)).toBeNull();
  });

  it("uses the key's place for Option's characters on a Mac, but lets them type in text", () => {
    expect(shellShortcut(press("ç", "KeyC"), false)).toBe("zen");
    expect(shellShortcut(press("ß", "KeyS"), false)).toBe("settings");
    expect(shellShortcut(press("ç", "KeyC"), true)).toBeNull();
    expect(shellShortcut(press("Dead", "KeyE"), false)).toBeNull();
  });

  it("follows the letter a layout prints rather than its place when the key gives one", () => {
    // AZERTY swaps W and Z.
    expect(shellShortcut(press("w", "KeyZ"), false)).toBe("fleet");
    expect(shellShortcut(press("z", "KeyW"), false)).toBeNull();
  });

  it("names each shortcut the way aria-keyshortcuts expects", () => {
    expect(shellShortcutKeys("zen")).toBe("Alt+C");
    expect(shellShortcutKeys("help")).toBe("Alt+H");
  });
});
