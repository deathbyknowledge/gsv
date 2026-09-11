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
  stillAt: number;
  frame: (seconds: number, motion: boolean) => AsciiAnimationFrame;
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
  const style: JSX.CSSProperties & { "--gsv-ascii-galaxy-font-size": string } = { "--gsv-ascii-galaxy-font-size": `${fontSize}px` };

  useEffect(() => {
    const element = foreground.current;
    if (!element) return;
    let cancelled = false;
    let ready = false;
    let visible = true;
    let raf = 0;
    let start = 0;
    let last = 0;
    let hiddenAt: number | null = null;
    const frameMs = 1000 / Math.max(1, frameRate);
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const moving = () => animate && !(respectReducedMotion && motion?.matches);
    const draw = (seconds: number, allowMotion: boolean) => {
      const frame = scene.frame(seconds, allowMotion);
      element.textContent = frame.foreground;
      element.classList.toggle("is-glitch", frame.glitch === true);
      element.style.transform = frame.transform ?? "none";
      element.style.opacity = frame.opacity ?? "1";
      if (stars.current) stars.current.textContent = frame.stars ?? "";
      if (nebula.current && nebula.current.textContent !== (frame.nebula ?? "")) nebula.current.textContent = frame.nebula ?? "";
    };
    const revealReplay = (visible: boolean) => {
      if (replay.current) {
        replay.current.hidden = !visible;
        replay.current.style.opacity = visible ? "1" : "0";
      }
    };
    const loop = (now: number) => {
      if (cancelled) return;
      if (visible && now - last >= frameMs) {
        last = now;
        const seconds = (now - start) / 1000;
        draw(seconds, true);
        if (seconds > scene.stillAt + 1.5) revealReplay(true);
      }
      if (visible) raf = window.requestAnimationFrame(loop);
    };
    const restart = () => {
      if (!ready || cancelled) return;
      window.cancelAnimationFrame(raf);
      if (!moving()) {
        draw(scene.stillAt, false);
        revealReplay(false);
        return;
      }
      start = performance.now();
      hiddenAt = visible ? null : start;
      last = 0;
      revealReplay(false);
      draw(0, false);
      if (visible) raf = window.requestAnimationFrame(loop);
    };
    const observer = pauseWhenOffscreen && "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      const next = entries.some((entry) => entry.isIntersecting);
      if (next === visible) return;
      visible = next;
      if (!visible) {
        hiddenAt = performance.now();
        window.cancelAnimationFrame(raf);
      } else {
        if (hiddenAt !== null) start += performance.now() - hiddenAt;
        hiddenAt = null;
        if (ready && moving()) raf = window.requestAnimationFrame(loop);
      }
    }) : null;
    if (root.current) observer?.observe(root.current);
    const button = replay.current;
    button?.addEventListener("click", restart);
    if (respectReducedMotion) motion?.addEventListener("change", restart);
    void Promise.resolve().then(() => scene.prepare?.()).then(() => {
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
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      button?.removeEventListener("click", restart);
      motion?.removeEventListener("change", restart);
    };
  }, [animate, frameRate, inline, label, pauseWhenOffscreen, respectReducedMotion, scene, showReplay]);

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
