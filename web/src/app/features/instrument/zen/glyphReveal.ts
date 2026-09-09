import { resolveTail, RESOLVE_GLYPHS, RESOLVE_TAIL } from "./zenModel";

const MASK_NAME = "gsv-zen-glyphs";
let sharedMask: Highlight | undefined;

type Glyph = { node: Text; start: number; end: number; text: string };
type TextRun = { node: Text; start: number; end: number; range: Range };

export type GlyphReveal = { paint(progress: number): void; dispose(): void };

/** Paint over native text ranges; Markdown, wrapping, selection and link targets stay intact. */
export function createGlyphReveal(container: HTMLElement, content: HTMLElement): GlyphReveal | null {
  if (typeof Highlight === "undefined" || !CSS.highlights || typeof Intl.Segmenter === "undefined") return null;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  canvas.className = "zen-glyphs";
  canvas.setAttribute("aria-hidden", "true");

  const glyphs: Glyph[] = [];
  const runs: TextRun[] = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const start = glyphs.length;
    for (const part of segmenter.segment(text.data)) {
      glyphs.push({ node: text, start: part.index, end: part.index + part.segment.length, text: part.segment });
    }
    runs.push({ node: text, start, end: glyphs.length, range: document.createRange() });
  }
  const mask = sharedMask ??= new Highlight();
  const masked = new Set<Range>();
  const updateMask = () => {
    for (const range of masked) mask.add(range);
    if (mask.size > 0) CSS.highlights.set(MASK_NAME, mask);
    else CSS.highlights.delete(MASK_NAME);
  };
  const clear = () => {
    for (const range of masked) mask.delete(range);
    masked.clear();
    if (mask.size === 0) CSS.highlights.delete(MASK_NAME);
    canvas.remove();
  };

  return {
    dispose: clear,
    paint(progress) {
      for (const range of masked) mask.delete(range);
      masked.clear();
      if (progress >= 1) {
        clear();
        return;
      }
      // Keep offscreen text masked too: Zen can scroll a new reply into view before the next frame.
      // A negative progress means a live reply: only its newest glyphs are unsettled.
      const streaming = progress < 0;
      // Start the entire message as glyphs, then let the real text settle from left to right.
      const front = streaming ? glyphs.length : Math.floor(Math.max(0, (progress - 0.15) / 0.85) * glyphs.length);
      for (const run of runs) {
        if (run.end <= front) continue;
        run.range.setStart(run.node, front <= run.start ? 0 : glyphs[front].start);
        run.range.setEnd(run.node, run.node.length);
        masked.add(run.range);
      }
      const bounds = container.getBoundingClientRect();
      const viewport = container.closest(".zen-moments")?.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport?.top ?? 0, 0);
      const bottom = Math.min(bounds.bottom, viewport?.bottom ?? window.innerHeight, window.innerHeight);
      if (bottom <= top || bounds.width === 0) {
        canvas.remove();
        updateMask();
        return;
      }
      const scale = bounds.width / container.offsetWidth;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.ceil(bounds.width * ratio);
      const height = Math.ceil((bottom - top) * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${bounds.width / scale}px`;
      canvas.style.height = `${(bottom - top) / scale}px`;
      canvas.style.top = `${(top - bounds.top) / scale}px`;
      if (!canvas.isConnected) container.append(canvas);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bottom - top);
      context.fillStyle = getComputedStyle(canvas).color;
      context.textBaseline = "alphabetic";

      const start = streaming ? Math.max(0, glyphs.length - RESOLVE_TAIL) : front;
      const unresolved = glyphs.slice(start);
      const resolved = streaming ? resolveTail(unresolved.map((glyph) => glyph.text).join(""), Math.random) : null;
      const fonts = new Map<Element, string>();
      // Skip offscreen text in blocks before measuring individual glyphs.
      const block = document.createRange();
      for (let first = 0; first < unresolved.length; first += 64) {
        const end = Math.min(first + 64, unresolved.length);
        block.setStart(unresolved[first].node, unresolved[first].start);
        block.setEnd(unresolved[end - 1].node, unresolved[end - 1].end);
        const blockBounds = block.getBoundingClientRect();
        if (blockBounds.bottom <= top || blockBounds.top >= bottom || blockBounds.width === 0) continue;
        for (let index = first; index < end; index += 1) {
          const glyph = unresolved[index];
          if (/^\s+$/u.test(glyph.text)) continue;
          const noise = resolved ? resolved.tail[index]?.noise : RESOLVE_GLYPHS[Math.floor(Math.random() * RESOLVE_GLYPHS.length)];
          if (!noise) continue;
          const range = document.createRange();
          range.setStart(glyph.node, glyph.start);
          range.setEnd(glyph.node, glyph.end);
          const rect = range.getBoundingClientRect();
          if (rect.bottom <= top || rect.top >= bottom || rect.width === 0) continue;
          const parent = glyph.node.parentElement!;
          let font = fonts.get(parent);
          if (!font) {
            const style = getComputedStyle(parent);
            font = `${style.fontStyle} ${style.fontWeight} ${parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
            fonts.set(parent, font);
          }
          context.font = font;
          const metrics = context.measureText(noise);
          const baseline = (rect.height + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
          context.fillText(noise, rect.left - bounds.left, rect.top - top + baseline, rect.width);
          if (streaming) masked.add(range);
        }
      }
      updateMask();
    },
  };
}
