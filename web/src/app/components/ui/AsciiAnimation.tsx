import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ColorTheme } from "./useColorTheme";
import "./AsciiGalaxyScan.css";

export type AsciiAnimationFrame = {
  foreground: string;
  stars?: string;
  nebula?: string;
  glitch?: boolean;
  transform?: string;
  opacity?: string;
};

/** A scene owns its shape and simulation. The host owns time, glyph layers, and presentation. */
export type AsciiAnimationScene = {
  prepare?: () => void | Promise<void>;
  subscribe?: (redraw: () => void) => () => void;
  stillAt: number;
  frame: (seconds: number, motion: boolean, palette?: ColorTheme) => AsciiAnimationFrame;
};

export type AsciiAnimationProps = {
  scene: AsciiAnimationScene;
  label: string;
  animate?: boolean;
  frameRate?: number;
  fontSize?: number;
  palette?: ColorTheme;
  showTexture?: boolean;
  showReplay?: boolean;
  pauseWhenOffscreen?: boolean;
  respectReducedMotion?: boolean;
  className?: string;
  inline?: boolean;
};

export function AsciiAnimation({ scene, label, animate = true, frameRate = 30, fontSize = 8, palette,
  showTexture = false, showReplay = false, pauseWhenOffscreen = true, respectReducedMotion = true, className, inline = false,
}: AsciiAnimationProps) {
  const root = useRef<HTMLElement>(null);
  const nebula = useRef<HTMLElement>(null);
  const stars = useRef<HTMLElement>(null);
  const foreground = useRef<HTMLElement>(null);
  const replay = useRef<HTMLButtonElement>(null);
  const paletteRef = useRef(palette);
  const redraw = useRef<(() => void) | null>(null);
  paletteRef.current = palette;
  const style: JSX.CSSProperties & { "--gsv-ascii-galaxy-font-size": string } = { "--gsv-ascii-galaxy-font-size": `${fontSize}px` };

  useEffect(() => {
    const element = foreground.current;
    const container = root.current;
    if (!element || !container) return;
    let cancelled = false;
    let ready = false;
    let inViewport = !pauseWhenOffscreen || !("IntersectionObserver" in window);
    let visible = inViewport && !document.hidden;
    let raf = 0;
    let redrawRaf = 0;
    let start = 0;
    let last = 0;
    let frameSeconds = scene.stillAt;
    let frameMotion = false;
    let hiddenAt: number | null = null;
    const frameMs = 1000 / Math.max(1, frameRate);
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const moving = () => animate && !(respectReducedMotion && motion?.matches);
    const draw = (seconds: number, allowMotion: boolean) => {
      const frame = scene.frame(seconds, allowMotion, paletteRef.current);
      frameSeconds = seconds;
      frameMotion = allowMotion;
      if (element.textContent !== frame.foreground) element.textContent = frame.foreground;
      element.classList.toggle("is-glitch", frame.glitch === true);
      element.style.transform = frame.transform ?? "none";
      element.style.opacity = frame.opacity ?? "1";
      if (stars.current && stars.current.textContent !== (frame.stars ?? "")) stars.current.textContent = frame.stars ?? "";
      if (nebula.current && nebula.current.textContent !== (frame.nebula ?? "")) nebula.current.textContent = frame.nebula ?? "";
    };
    redraw.current = () => {
      if (ready && visible && !cancelled) draw(frameSeconds, frameMotion);
    };
    const unsubscribe = scene.subscribe?.(() => {
      if (!ready || !visible || cancelled || redrawRaf) return;
      redrawRaf = window.requestAnimationFrame(() => {
        redrawRaf = 0;
        if (!ready || !visible || cancelled) return;
        const allowMotion = moving();
        draw(allowMotion ? (performance.now() - start) / 1000 : scene.stillAt, allowMotion);
      });
    });
    const revealReplay = (visible: boolean) => {
      if (replay.current) {
        replay.current.hidden = !visible;
        replay.current.style.opacity = visible ? "1" : "0";
      }
    };
    const loop = (now: number) => {
      raf = 0;
      if (cancelled || !visible || !moving()) return;
      const seconds = (now - start) / 1000;
      if (now - last >= frameMs) {
        last = now;
        draw(seconds, true);
        if (seconds > scene.stillAt + 1.5) revealReplay(true);
      }
      raf = window.requestAnimationFrame(loop);
    };
    const restart = () => {
      if (!ready || cancelled) return;
      window.cancelAnimationFrame(raf);
      raf = 0;
      start = performance.now();
      hiddenAt = visible ? null : start;
      last = 0;
      revealReplay(false);
      if (!visible) return;
      if (!moving()) {
        draw(scene.stillAt, false);
        return;
      }
      draw(0, false);
      raf = window.requestAnimationFrame(loop);
    };
    const updateVisibility = () => {
      if (cancelled) return;
      const next = inViewport && !document.hidden;
      if (next === visible) return;
      visible = next;
      if (!visible) {
        hiddenAt = performance.now();
        window.cancelAnimationFrame(raf);
        raf = 0;
      } else {
        if (hiddenAt !== null) start += performance.now() - hiddenAt;
        hiddenAt = null;
        if (!ready) return;
        if (!moving()) draw(scene.stillAt, false);
        else raf = window.requestAnimationFrame(loop);
      }
    };
    const observer = pauseWhenOffscreen && "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      inViewport = entries.some((entry) => entry.isIntersecting);
      updateVisibility();
    }) : null;
    observer?.observe(container);
    document.addEventListener("visibilitychange", updateVisibility);
    const button = replay.current;
    button?.addEventListener("click", restart);
    if (respectReducedMotion) motion?.addEventListener("change", restart);
    void Promise.resolve().then(() => { if (!cancelled) return scene.prepare?.(); }).then(() => {
      if (cancelled) return;
      ready = true;
      restart();
    }).catch(() => {
      if (cancelled) return;
      ready = false;
      window.cancelAnimationFrame(raf);
      element.textContent = label;
      revealReplay(false);
    });
    return () => {
      cancelled = true;
      redraw.current = null;
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(redrawRaf);
      unsubscribe?.();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      button?.removeEventListener("click", restart);
      motion?.removeEventListener("change", restart);
    };
  }, [animate, frameRate, inline, label, pauseWhenOffscreen, respectReducedMotion, scene, showReplay]);

  useEffect(() => { redraw.current?.(); }, [palette]);

  const Root = inline ? "span" : "div";
  const Layer = inline ? "span" : "pre";
  return (
    <Root ref={(element: HTMLElement | null) => { root.current = element; }} class={`gsv-ascii-galaxy${className ? ` ${className}` : ""}`} data-ascii-palette={palette} role="img" aria-label={label} style={style}>
      <Layer ref={(element: HTMLElement | null) => { nebula.current = element; }} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-nebula" aria-hidden="true" />
      <Layer ref={(element: HTMLElement | null) => { stars.current = element; }} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-stars" aria-hidden="true" />
      <Layer ref={(element: HTMLElement | null) => { foreground.current = element; }} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-foreground" aria-hidden="true" />
      {showTexture ? <>
        <div class="gsv-ascii-galaxy-texture gsv-ascii-galaxy-scanlines" aria-hidden="true" />
        <div class="gsv-ascii-galaxy-texture gsv-ascii-galaxy-vignette" aria-hidden="true" />
      </> : null}
      {showReplay ? <button ref={replay} hidden type="button" class="gsv-ascii-galaxy-replay gsv-label" aria-label={`Replay ${label}`}>
        <span class="gsv-ascii-galaxy-replay-icon" aria-hidden="true">↻</span> Replay
      </button> : null}
    </Root>
  );
}
