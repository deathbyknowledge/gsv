import { useEffect, useRef } from "preact/hooks";

type Star = {
  idx: number;
  phase: number;
  rate: number;
  bright: boolean;
  base: number;
};

type StarGrid = {
  cols: number;
  rows: number;
  stars: Star[];
};

const FONT_SIZE = 8;
const CHAR_WIDTH = 5;
const DEFAULT_DENSITY = 0.022;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gridSize(element: HTMLElement) {
  const width = element.clientWidth || window.innerWidth || 1440;
  const height = element.clientHeight || window.innerHeight || 900;
  return {
    cols: Math.max(80, Math.ceil(width / CHAR_WIDTH) + 4),
    rows: Math.max(48, Math.ceil(height / FONT_SIZE) + 4),
  };
}

function buildGrid(cols: number, rows: number, density: number): StarGrid {
  const stars: Star[] = [];
  const random = makeRandom(137);
  const total = cols * rows;

  for (let i = 0; i < total; i += 1) {
    if (random() > 1 - density) {
      stars.push({
        idx: i,
        phase: random() * Math.PI * 2,
        rate: 0.7 + random() * 2.4,
        bright: random() > 0.82,
        base: 0.2 + random() * 0.45,
      });
    }
  }

  return {
    cols,
    rows,
    stars,
  };
}

function starGlyph(star: Star, elapsed: number): string {
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
  left: 50%;
  top: 50%;
  margin: 0;
  color: #5d5798;
  font-family: var(--gsv-font-mono, ui-monospace, monospace);
  font-size: ${FONT_SIZE}px;
  font-variant-ligatures: none;
  line-height: ${FONT_SIZE}px;
  letter-spacing: 0;
  pointer-events: none;
  text-rendering: geometricPrecision;
  /* Blurred shadows on the animated glyphs caused persistent input latency in WebKitGTK. */
  text-shadow: none;
  transform: translate(-50%, -50%);
  white-space: pre;
  -webkit-font-smoothing: none;
}
.gsv-glyph-stars pre span {
  position: absolute;
  width: ${CHAR_WIDTH}px;
  height: ${FONT_SIZE}px;
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
    const initialSize = gridSize(root);
    let grid = buildGrid(initialSize.cols, initialSize.rows, density);
    let raf = 0;
    let timer = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let visible = true;
    const frameMs = 1000 / 8;
    let painted: { star: Star; text: Text; glyph: string }[] = [];

    const mount = () => {
      const fragment = document.createDocumentFragment();
      painted = grid.stars.map((star) => {
        const cell = document.createElement("span");
        cell.style.left = `${star.idx % grid.cols * CHAR_WIDTH}px`;
        cell.style.top = `${Math.floor(star.idx / grid.cols) * FONT_SIZE}px`;
        const text = document.createTextNode("");
        cell.append(text);
        fragment.append(cell);
        return { star, text, glyph: "" };
      });
      pre.style.width = `${grid.cols * CHAR_WIDTH}px`;
      pre.style.height = `${grid.rows * FONT_SIZE}px`;
      pre.replaceChildren(fragment);
    };

    const draw = (elapsed: number) => {
      for (const cell of painted) {
        const glyph = starGlyph(cell.star, elapsed);
        if (glyph === cell.glyph) continue;
        cell.text.data = glyph;
        cell.glyph = glyph;
      }
    };

    const resize = () => {
      const size = gridSize(root);
      if (size.cols === grid.cols && size.rows === grid.rows) {
        return;
      }
      grid = buildGrid(size.cols, size.rows, density);
      mount();
      draw(elapsed);
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
    mount();
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
    };
  }, [density]);

  return (
    <div ref={rootRef} class={className ? `gsv-glyph-stars ${className}` : "gsv-glyph-stars"} aria-hidden="true">
      <style>{STYLE}</style>
      <pre ref={preRef} />
    </div>
  );
}
