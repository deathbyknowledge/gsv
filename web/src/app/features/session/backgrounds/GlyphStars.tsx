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
  buffer: string[];
};

const FONT_SIZE = 8;
const CHAR_WIDTH = 5;
const STAR_DENSITY = 0.022;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gridSize(element: HTMLElement): { cols: number; rows: number } {
  const width = element.clientWidth || window.innerWidth || 1440;
  const height = element.clientHeight || window.innerHeight || 900;
  return {
    cols: Math.max(80, Math.ceil(width / CHAR_WIDTH) + 4),
    rows: Math.max(48, Math.ceil(height / FONT_SIZE) + 4),
  };
}

function buildGrid(cols: number, rows: number): StarGrid {
  const stars: Star[] = [];
  const random = makeRandom(137);
  const total = cols * rows;

  for (let i = 0; i < total; i += 1) {
    if (random() > 1 - STAR_DENSITY) {
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
    buffer: new Array(total),
  };
}

function renderGrid(grid: StarGrid, elapsed: number): string {
  grid.buffer.fill(" ");

  for (const star of grid.stars) {
    const twinkle = 0.5 + 0.5 * Math.sin(elapsed * star.rate + star.phase);
    const level = star.base + twinkle * 0.62;
    let char = " ";

    if (star.bright) {
      char = level > 0.95 ? "*" : level > 0.72 ? "+" : level > 0.48 ? "·" : level > 0.27 ? "." : " ";
    } else {
      char = level > 0.8 ? "+" : level > 0.52 ? "·" : level > 0.32 ? "." : " ";
    }

    grid.buffer[star.idx] = char;
  }

  let output = "";
  for (let y = 0; y < grid.rows; y += 1) {
    let line = "";
    const base = y * grid.cols;
    for (let x = 0; x < grid.cols; x += 1) {
      line += grid.buffer[base + x];
    }
    output += `${y ? "\n" : ""}${line}`;
  }
  return output;
}

const STYLE = `
.gsv-glyph-stars {
  overflow: hidden;
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
  text-shadow: 0 0 4px rgba(128, 113, 221, 0.4);
  transform: translate(-50%, -50%);
  white-space: pre;
  -webkit-font-smoothing: none;
}
`;

export function GlyphStars() {
  const rootRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const pre = preRef.current;
    if (!root || !pre) {
      return;
    }

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const initialSize = gridSize(root);
    let grid = buildGrid(initialSize.cols, initialSize.rows);
    let raf = 0;
    let lastFrame = 0;
    let start = performance.now();
    const frameMs = reduced ? Infinity : 1000 / 24;

    const draw = (elapsed: number) => {
      pre.textContent = renderGrid(grid, elapsed);
    };

    const resize = () => {
      const size = gridSize(root);
      if (size.cols === grid.cols && size.rows === grid.rows) {
        return;
      }
      grid = buildGrid(size.cols, size.rows);
      start = performance.now();
      draw(0);
    };

    const loop = (now: number) => {
      if (now - lastFrame >= frameMs) {
        lastFrame = now;
        draw((now - start) / 1000);
      }
      raf = window.requestAnimationFrame(loop);
    };

    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(root);
    resize();
    draw(0);

    if (!reduced) {
      raf = window.requestAnimationFrame(loop);
    }

    return () => {
      observer?.disconnect();
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, []);

  return (
    <div ref={rootRef} class="gsv-glyph-stars" aria-hidden="true">
      <style>{STYLE}</style>
      <pre ref={preRef} />
    </div>
  );
}
