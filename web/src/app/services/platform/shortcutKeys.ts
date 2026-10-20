import type { TextKey } from "../../i18n/locale";

export function shortcutDefaults(platform = navigator.platform ?? "") {
  return /mac/i.test(platform)
    ? { talk: "Alt+Space", stop: "Alt+Escape" }
    : { talk: "Ctrl+Shift+Space", stop: "Ctrl+Alt+Escape" };
}

type ShortcutKey = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat" | "isComposing" | "getModifierState">;
/** A recorded shortcut, a cancelled recording, or the message that explains why a key cannot be used. */
type ShortcutCapture = { cancel?: true; error?: TextKey; shortcut?: string };
export function shortcutFromKey(event: ShortcutKey): ShortcutCapture {
  if (event.repeat || event.isComposing || /^(Control|Shift|Alt|Meta|OS|Fn)/.test(event.code)) return {};
  const modified = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  if (!modified && (event.key === "Escape" || event.key === "Tab")) return { cancel: true };
  if (event.key === "Dead" || event.getModifierState("AltGraph")) return { error: "desktop.shortcut.errors.altGr" };
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|Minus|Period|Quote|Semicolon|Slash)$/.test(event.code)) {
    return { error: "desktop.shortcut.errors.unsupported" };
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$/.test(event.code)) {
    return { error: "desktop.shortcut.errors.modifier" };
  }
  return { shortcut: [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", event.code].filter(Boolean).join("+") };
}

export function shortcutLabel(shortcut: string, platform = navigator.platform ?? ""): string {
  const mac = /mac/i.test(platform);
  return shortcut.split("+").map((key) => {
    const modifiers: Record<string, string> = mac
      ? { ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧", super: "⌘", meta: "⌘", command: "⌘" }
      : { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", super: /win/i.test(platform) ? "Win" : "Super", meta: /win/i.test(platform) ? "Win" : "Super" };
    return modifiers[key.toLowerCase()] ?? key.replace(/^Key|^Digit/, "").replace(/^Arrow/, "").replace("Escape", "Esc");
  }).join(mac ? " " : " + ");
}
