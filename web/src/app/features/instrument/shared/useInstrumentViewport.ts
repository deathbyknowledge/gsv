import { useLayoutEffect, useRef } from "preact/hooks";
import { preventInputFocusScroll } from "./preventInputFocusScroll";

const KEYBOARD_TRACKING_MS = 700;
const KEYBOARD_ANIMATION_MS = 180;

/** The content follows the visible viewport; the star field keeps the full screen. */
export function useInstrumentViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let trackingUntil = 0;
    let targetHeight = viewport.height;
    let layoutScale = viewport.scale;
    let displayedHeight = targetHeight;
    let animation: { from: number; started: number } | null = null;
    let lastTop: number | undefined;
    let lastHeight: number | undefined;
    const clear = () => {
      root.style.removeProperty("--instrument-viewport-top");
      root.style.removeProperty("--instrument-viewport-height");
    };
    const measure = () => {
      const now = performance.now();
      // Pinch zoom must magnify and pan the existing layout, not reflow it.
      // Safari reported 1.004118 on an unzoomed iPhone after opening the keyboard.
      if (Math.abs(viewport.scale / layoutScale - 1) < 0.01) {
        // The visible viewport and a fixed element can have different origins
        // while Safari scrolls the document to reveal an input.
        const top = viewport.pageTop - window.scrollY - root.getBoundingClientRect().top;
        if (viewport.height !== targetHeight) {
          const jump = Math.abs(viewport.height - targetHeight);
          targetHeight = viewport.height;
          // iOS may report the final keyboard height in a single step. Animate
          // that step; browsers reporting intermediate heights already animate it.
          animation = now < trackingUntil && jump > 80 && !reducedMotion.matches
            ? { from: displayedHeight, started: now }
            : null;
        }
        if (animation && !reducedMotion.matches) {
          const progress = Math.min(1, (now - animation.started) / KEYBOARD_ANIMATION_MS);
          displayedHeight = animation.from + (targetHeight - animation.from) * (1 - (1 - progress) ** 3);
          if (progress === 1) animation = null;
        } else {
          animation = null;
          displayedHeight = targetHeight;
        }
        if (top !== lastTop) {
          root.style.setProperty("--instrument-viewport-top", `${top}px`);
          lastTop = top;
        }
        if (displayedHeight !== lastHeight) {
          root.style.setProperty("--instrument-viewport-height", `${displayedHeight}px`);
          lastHeight = displayedHeight;
        }
      } else {
        animation = null;
      }
      if ((now < trackingUntil || animation) && !frame) frame = requestAnimationFrame(tick);
    };
    const tick = () => {
      frame = 0;
      measure();
    };
    const trackKeyboard = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)
        || !event.target.matches("input, textarea, [contenteditable]:not([contenteditable=false])")) return;
      // Safari can change viewport geometry between, or after, its resize events.
      // Poll only through this focus transition, never for the whole typing session.
      // Fit the keyboard at the person's current zoom. A pinch between focus
      // transitions still magnifies the existing layout without reflowing it.
      layoutScale = viewport.scale;
      trackingUntil = performance.now() + KEYBOARD_TRACKING_MS;
      measure();
    };
    measure();
    const restoreFocus = preventInputFocusScroll(root);
    root.addEventListener("focusin", trackKeyboard);
    root.addEventListener("focusout", trackKeyboard);
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
      restoreFocus();
      root.removeEventListener("focusin", trackKeyboard);
      root.removeEventListener("focusout", trackKeyboard);
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      clear();
    };
  }, []);
  return ref;
}
