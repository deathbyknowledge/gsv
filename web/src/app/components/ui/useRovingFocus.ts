import { useCallback } from "preact/hooks";
import type { RefObject } from "preact";

/** useRovingFocus — shared arrow-key roving for menu-style popovers. Returns a
 *  keydown handler that moves focus between the enabled `<button>` descendants
 *  of `rootRef` on ArrowUp/ArrowDown (wrapping) and Home/End, preventing the
 *  default scroll. Extracted from TwoLevelSelect so every popover in the family
 *  navigates identically. */
export function useRovingFocus<T extends HTMLElement>(rootRef: RefObject<T>) {
  return useCallback((event: KeyboardEvent) => {
    if (
      event.key !== "ArrowDown" && event.key !== "ArrowUp"
      && event.key !== "Home" && event.key !== "End"
    ) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }, [rootRef]);
}
