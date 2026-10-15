import { useCallback, useState } from "preact/hooks";

/** A message longer than this many of its own lines folds once it stops arriving. */
export const FOLD_AFTER_LINES = 6;
/** How many lines a folded message keeps in view above its fade. */
export const FOLDED_LINES = 4;

export type FoldState = "whole" | "folded" | "open";

/** The height of one line of text in CSS pixels, from an element's computed style. */
export function lineHeight(style: Pick<CSSStyleDeclaration, "fontSize" | "lineHeight">): number {
  const size = parseFloat(style.fontSize) || 16;
  const value = parseFloat(style.lineHeight);
  if (!Number.isFinite(value) || value <= 0) return size * 1.2;
  return style.lineHeight.trim().endsWith("px") ? value : value * size;
}

/**
 * Whether a message shows whole, folded behind "read more", or opened by the reader.
 * A live message never folds, and a reader who watched one arrive finds it open.
 */
export function useFold(live: boolean, opened: boolean) {
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(opened);
  /** Report the message's rendered height in lines. */
  const measured = useCallback((lines: number) => setLong(lines > FOLD_AFTER_LINES), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const reveal = useCallback(() => setOpen(true), []);
  const state: FoldState = live || !long ? "whole" : open ? "open" : "folded";
  return { state, measured, toggle, open: reveal };
}
