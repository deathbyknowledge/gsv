import { useEffect, useState } from "preact/hooks";
import { RESOLVE_GLYPHS } from "./zenModel";

export type ThinkingMarkKind = "glyphs" | "dot";

/**
 * What stands where the reply will be while Ship has no words yet. It must never read as a place to type.
 * "glyphs" is the stream's own noise: four glyphs settling towards where the words will start.
 * "dot" is one accent dot with a slow breath. Flip here to compare the two.
 */
export const THINKING_MARK: ThinkingMarkKind = "glyphs";

const GLYPH_COUNT = 4;
/** How readily each glyph, left to right, changes on a frame: calmer where the words will start, restless at the end. */
const RESTLESSNESS = [0.1, 0.22, 0.4, 0.65];

function roll(): string {
  return RESOLVE_GLYPHS[Math.floor(Math.random() * RESOLVE_GLYPHS.length)];
}

/** Moves on Zen's resolve clock: `tick` advances while anything is settling, and stands still under reduced motion. */
export function ThinkingMark({ tick }: { tick: number }) {
  const [glyphs, setGlyphs] = useState<string[]>(() => Array.from({ length: GLYPH_COUNT }, roll));
  useEffect(() => {
    if (THINKING_MARK !== "glyphs") return;
    setGlyphs((current) => current.map((glyph, index) => (Math.random() < RESTLESSNESS[index] ? roll() : glyph)));
  }, [tick]);
  if (THINKING_MARK === "dot") return <span class="zen-thinking is-dot" aria-hidden="true"><i class="dot" /></span>;
  return <span class="zen-thinking is-glyphs" aria-hidden="true">{glyphs.map((glyph, index) => <i key={index}>{glyph}</i>)}</span>;
}
