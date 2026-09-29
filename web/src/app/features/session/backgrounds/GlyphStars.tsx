import { useEffect, useRef } from "preact/hooks";
import { createStarSphere, projectStarSphere, STAR_HEIGHT, STAR_WIDTH, visibleStars } from "./starSphere";
import type { SkyStar } from "./starSphere";

const DEFAULT_DENSITY = 0.022;

type PaintedStar = { star: SkyStar; cell: HTMLSpanElement; text: Text; glyph: string };

function starGlyph(star: SkyStar, elapsed: number): string {
  const twinkle = 0.5 + 0.5 * Math.sin(elapsed * star.rate * 0.5 + star.phase);
  const level = star.base + twinkle * 0.62;
  return star.bright
    ? level > 0.95 ? "*" : level > 0.72 ? "+" : level > 0.48 ? "·" : level > 0.27 ? "." : " "
    : level > 0.8 ? "+" : level > 0.52 ? "·" : level > 0.32 ? "." : " ";
}

const STYLE = `
.gsv-glyph-stars {
  overflow: hidden;
  contain: layout paint;
}
.gsv-glyph-stars pre {
  position: absolute;
  width: 0;
  height: 0;
  margin: 0;
  color: #5d5798;
  font-family: var(--gsv-font-mono, ui-monospace, monospace);
  font-size: ${STAR_HEIGHT}px;
  font-variant-ligatures: none;
  line-height: ${STAR_HEIGHT}px;
  letter-spacing: 0;
  pointer-events: none;
  text-rendering: geometricPrecision;
  /* Blurred shadows on the animated glyphs caused persistent input latency in WebKitGTK. */
  text-shadow: none;
  white-space: pre;
  -webkit-font-smoothing: none;
}
.gsv-glyph-stars pre span {
  position: absolute;
  width: ${STAR_WIDTH}px;
  height: ${STAR_HEIGHT}px;
}
`;

export type GlyphStarsProps = {
  /** Fraction of cells that hold a star. The auth screen uses the default; Zen thins it. */
  density?: number;
  class?: string;
};

export function GlyphStars({ density = DEFAULT_DENSITY, class: className }: GlyphStarsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const pre = preRef.current;
    if (!root || !pre) {
      return;
    }

    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const projected = projectStarSphere(createStarSphere(density));
    let width = -1;
    let height = -1;
    let raf = 0;
    let timer = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let visible = true;
    const frameMs = 1000 / 8;
    const painted = new Map<number, PaintedStar>();
    let animated: PaintedStar[] = [];

    const draw = (elapsed: number) => {
      for (const cell of animated) {
        const glyph = starGlyph(cell.star, elapsed);
        if (glyph === cell.glyph) continue;
        cell.text.data = glyph;
        cell.glyph = glyph;
      }
    };

    const resize = () => {
      const nextWidth = root.clientWidth;
      const nextHeight = root.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      pre.style.left = `${Math.floor(width / 2)}px`;
      pre.style.top = `${Math.floor(height / 2)}px`;
      const next = visibleStars(projected, width, height);
      const ids = new Set(next.map(({ star }) => star.id));
      for (const [id, paintedStar] of painted) {
        if (ids.has(id)) continue;
        paintedStar.cell.remove();
        painted.delete(id);
      }
      const fragment = document.createDocumentFragment();
      for (const { star, x, y } of next) {
        if (painted.has(star.id)) continue;
        const cell = document.createElement("span");
        cell.style.left = `${x}px`;
        cell.style.top = `${y}px`;
        const glyph = starGlyph(star, motion?.matches ? 0 : elapsed);
        const text = document.createTextNode(glyph);
        cell.append(text);
        fragment.append(cell);
        painted.set(star.id, { star, cell, text, glyph });
      }
      pre.append(fragment);
      animated = Array.from(painted.values());
    };

    const loop = (now: number) => {
      if (lastFrame) elapsed += (now - lastFrame) / 1000;
      lastFrame = now;
      draw(elapsed);
      timer = window.setTimeout(() => { raf = window.requestAnimationFrame(loop); }, frameMs);
    };
    const followMotion = () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      lastFrame = 0;
      if (motion?.matches) draw(0);
      else if (!document.hidden && document.hasFocus() && visible) raf = window.requestAnimationFrame(loop);
    };

    const observer = globalThis.ResizeObserver ? new ResizeObserver(resize) : null;
    observer?.observe(root);
    const intersection = globalThis.IntersectionObserver ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      followMotion();
    }) : null;
    intersection?.observe(root);
    resize();
    draw(0);

    motion?.addEventListener("change", followMotion);
    document.addEventListener("visibilitychange", followMotion);
    window.addEventListener("focus", followMotion);
    window.addEventListener("blur", followMotion);
    followMotion();

    return () => {
      observer?.disconnect();
      intersection?.disconnect();
      motion?.removeEventListener("change", followMotion);
      document.removeEventListener("visibilitychange", followMotion);
      window.removeEventListener("focus", followMotion);
      window.removeEventListener("blur", followMotion);
      window.clearTimeout(timer);
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      pre.replaceChildren();
    };
  }, [density]);

  return (
    <div ref={rootRef} class={className ? `gsv-glyph-stars ${className}` : "gsv-glyph-stars"} aria-hidden="true">
      <style>{STYLE}</style>
      <pre ref={preRef} />
    </div>
  );
}
