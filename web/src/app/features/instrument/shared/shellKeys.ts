import type { Distance } from "../Instrument";

/** What a shell shortcut does: open a view, switch between light and dark, or show Help. */
export type ShellAction = Distance | "theme" | "help";

/** Each shortcut's letter, as Help and the header's hints show it after Alt (Option on a Mac). */
export const SHELL_SHORTCUTS: ReadonlyArray<readonly [letter: string, action: ShellAction]> = [
  ["c", "zen"], ["w", "fleet"], ["m", "memory"], ["p", "people"], ["s", "settings"], ["l", "theme"], ["h", "help"],
];
const ACTIONS: ReadonlyMap<string, ShellAction> = new Map(SHELL_SHORTCUTS);

type ShellPress = Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/**
 * The shell's shortcuts are Alt (Option on a Mac) with a letter, in every view and while writing, so an
 * unmodified key always belongs to what has focus and a letter typed in Chat always lands in the message.
 * Option turns letters into other characters on a Mac (ç, ß, ł…): outside text the key's place on the
 * keyboard picks the shortcut, while in text the character is typed.
 */
export function shellShortcut(press: ShellPress, typing: boolean): ShellAction | null {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return null;
  if (/^[a-z]$/i.test(press.key)) return ACTIONS.get(press.key.toLowerCase()) ?? null;
  if (typing || !/^Key[A-Z]$/.test(press.code)) return null;
  return ACTIONS.get(press.code.slice(3).toLowerCase()) ?? null;
}

/** The shortcut for an action in `aria-keyshortcuts` form, such as `Alt+C`. */
export function shellShortcutKeys(action: ShellAction): string {
  const letter = SHELL_SHORTCUTS.find(([, candidate]) => candidate === action)![0];
  return `Alt+${letter.toUpperCase()}`;
}
