import { useEffect, useRef } from "preact/hooks";
import { createStarSphere, projectStarSphere, STAR_HEIGHT, visibleStars } from "./starSphere";
import type { ProjectedStar, SkyStar } from "./starSphere";

const DEFAULT_DENSITY = 0.022;

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
  /* The stars are real glyphs: keep a drag or select-all from sweeping them into the selection. */
  -webkit-user-select: none;
  user-select: none;
}
.gsv-glyph-stars canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
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
`;

export type GlyphStarsProps = {
  /** Fraction of cells that hold a star. The auth screen uses the default; Zen thins it. */
  density?: number;
  class?: string;
};

export function GlyphStars({ density = DEFAULT_DENSITY, class: className }: GlyphStarsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) return;

    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const projected = projectStarSphere(createStarSphere(density));
    let width = -1;
    let height = -1;
    let pixelRatio = 0;
    let raf = 0;
    let timer = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let visible = true;
    const frameMs = 1000 / 8;
    let animated: ProjectedStar[] = [];
    let disposed = false;

    const draw = (elapsed: number) => {
      const style = getComputedStyle(canvas);
      context.clearRect(0, 0, width, height);
      context.font = `${STAR_HEIGHT}px ${style.fontFamily}`;
      context.fillStyle = style.color;
      context.textBaseline = "top";
      for (const { star, x, y } of animated) {
        const glyph = starGlyph(star, elapsed);
        if (glyph !== " ") context.fillText(glyph, Math.floor(width / 2) + x, Math.floor(height / 2) + y);
      }
    };
    const repaint = () => { if (!disposed) draw(motion?.matches ? 0 : elapsed); };

    const resize = () => {
      const nextWidth = root.clientWidth;
      const nextHeight = root.clientHeight;
      const nextRatio = window.devicePixelRatio || 1;
      if (nextWidth === width && nextHeight === height && nextRatio === pixelRatio) return;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextRatio;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      animated = visibleStars(projected, width, height);
      repaint();
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
    // Repaint a static or paused sky when an ancestor switches its theme.
    const theme = new MutationObserver(repaint);
    for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
      theme.observe(ancestor, { attributes: true, attributeFilter: ["class", "data-theme", "data-ascii-palette", "style"] });
    }
    document.fonts?.ready.then(repaint);
    resize();

    motion?.addEventListener("change", followMotion);
    document.addEventListener("visibilitychange", followMotion);
    window.addEventListener("focus", followMotion);
    window.addEventListener("blur", followMotion);
    window.addEventListener("resize", resize);
    followMotion();

    return () => {
      disposed = true;
      observer?.disconnect();
      intersection?.disconnect();
      theme.disconnect();
      motion?.removeEventListener("change", followMotion);
      document.removeEventListener("visibilitychange", followMotion);
      window.removeEventListener("focus", followMotion);
      window.removeEventListener("blur", followMotion);
      window.removeEventListener("resize", resize);
      window.clearTimeout(timer);
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      context.clearRect(0, 0, width, height);
    };
  }, [density]);

  return (
    <div ref={rootRef} class={className ? `gsv-glyph-stars ${className}` : "gsv-glyph-stars"} aria-hidden="true">
      <style>{STYLE}</style>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
