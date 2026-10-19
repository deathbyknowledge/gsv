const TEXT_INPUT = "textarea:not(:disabled):not([readonly]), input:is([type=text], [type=search], [type=url], [type=tel], [type=email], [type=password], [type=number], :not([type])):not(:disabled):not([readonly])";

/** Let the shell reveal a touch keyboard without WebKit first panning the page. */
export function preventInputFocusScroll(root: HTMLElement): () => void {
  if (!navigator.maxTouchPoints || !CSS.supports("-webkit-touch-callout", "none")) return () => {};
  let tap: { target: HTMLElement; x: number; y: number; started: number } | null = null;
  const start = (event: TouchEvent) => {
    const target = event.target;
    tap = event.touches.length === 1 && target instanceof HTMLElement && target.matches(TEXT_INPUT)
      ? { target, x: event.touches[0].clientX, y: event.touches[0].clientY, started: performance.now() }
      : null;
  };
  const move = (event: TouchEvent) => {
    if (tap && (event.touches.length !== 1
      || Math.hypot(event.touches[0].clientX - tap.x, event.touches[0].clientY - tap.y) > 8)) tap = null;
  };
  const cancel = () => { tap = null; };
  const end = (event: TouchEvent) => {
    const current = tap;
    tap = null;
    // Preserve caret movement, selection handles, paste menus and scroll gestures.
    if (!current || event.touches.length || performance.now() - current.started > 500
      || document.activeElement === current.target || event.defaultPrevented || !event.cancelable) return;
    event.preventDefault();
    current.target.focus({ preventScroll: true });
  };
  root.addEventListener("touchstart", start, { passive: true });
  root.addEventListener("touchmove", move, { passive: true });
  root.addEventListener("touchcancel", cancel, { passive: true });
  root.addEventListener("touchend", end, { passive: false });
  return () => {
    root.removeEventListener("touchstart", start);
    root.removeEventListener("touchmove", move);
    root.removeEventListener("touchcancel", cancel);
    root.removeEventListener("touchend", end);
  };
}
