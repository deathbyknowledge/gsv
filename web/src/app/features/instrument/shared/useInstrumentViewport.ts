import { useLayoutEffect, useRef } from "preact/hooks";

/** The content follows the visible viewport; the star field keeps the full screen. */
export function useInstrumentViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    let frame = 0;
    const clear = () => {
      root.style.removeProperty("--instrument-viewport-top");
      root.style.removeProperty("--instrument-viewport-bottom");
      root.style.removeProperty("--instrument-viewport-height");
    };
    const measure = () => {
      frame = 0;
      // Pinch zoom must magnify and pan the existing layout, not reflow it.
      if (viewport.scale !== 1) return;
      const top = Math.max(0, viewport.offsetTop);
      const bottom = Math.max(0, root.clientHeight - top - viewport.height);
      root.style.setProperty("--instrument-viewport-top", `${top}px`);
      root.style.setProperty("--instrument-viewport-bottom", `${bottom}px`);
      root.style.setProperty("--instrument-viewport-height", `${root.clientHeight - top - bottom}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      clear();
    };
  }, []);
  return ref;
}
