import type { ComponentChildren, RefObject, VNode } from "preact";
import { cloneElement, isValidElement } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import "./Tooltip.css";

export type TooltipPosition =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-start"
  | "top-end"
  | "bottom-start"
  | "bottom-end";

export interface TooltipProps {
  trigger?: string;
  text?: string;
  position?: TooltipPosition;
  /** Custom trigger content. When provided it replaces the default
   *  dashed-underline hint text and is rendered bare so the caller's own
   *  styling shows through — only the hover/focus reveal + help cursor remain. */
  children?: ComponentChildren;
}

export const POS_CLASS: Record<TooltipPosition, string> = {
  top: "gsv-tt-top",
  bottom: "gsv-tt-bottom",
  left: "gsv-tt-left",
  right: "gsv-tt-right",
  "top-start": "gsv-tt-top-start",
  "top-end": "gsv-tt-top-end",
  "bottom-start": "gsv-tt-bottom-start",
  "bottom-end": "gsv-tt-bottom-end",
};

/** Gap between the trigger edge and the bubble edge — matches the 9px margin the
 *  CSS used when the bubble was an absolutely-positioned sibling. */
const GAP = 9;

interface Coords {
  left: number;
  top: number;
}

/** Compute the viewport-fixed coordinates for the bubble from the trigger rect,
 *  the bubble's measured size, and the requested side. Mirrors the anchoring the
 *  old CSS did (center for top/bottom/left/right; edge-hug for start/end). */
function computeCoords(rect: DOMRect, bw: number, bh: number, position: TooltipPosition): Coords {
  switch (position) {
    case "bottom":
      return { left: rect.left + rect.width / 2 - bw / 2, top: rect.bottom + GAP };
    case "left":
      return { left: rect.left - GAP - bw, top: rect.top + rect.height / 2 - bh / 2 };
    case "right":
      return { left: rect.right + GAP, top: rect.top + rect.height / 2 - bh / 2 };
    case "top-start":
      return { left: rect.left, top: rect.top - GAP - bh };
    case "top-end":
      return { left: rect.right - bw, top: rect.top - GAP - bh };
    case "bottom-start":
      return { left: rect.left, top: rect.bottom + GAP };
    case "bottom-end":
      return { left: rect.right - bw, top: rect.bottom + GAP };
    case "top":
    default:
      return { left: rect.left + rect.width / 2 - bw / 2, top: rect.top - GAP - bh };
  }
}

/** Shared reveal + portal-positioning logic for Tooltip and Hint. The bubble is
 *  rendered through a portal into <body> (so no ancestor `overflow`/`transform`/
 *  `z-index` can clip it); reveal is driven by JS state instead of CSS `:hover`
 *  since a portaled node isn't a descendant of the hovered wrapper. */
function useTooltipReveal(position: TooltipPosition) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);

  const compute = useCallback(() => {
    const wrap = wrapRef.current;
    const bub = bubbleRef.current;
    if (!wrap || !bub) return;
    const rect = wrap.getBoundingClientRect();
    setCoords(computeCoords(rect, bub.offsetWidth, bub.offsetHeight, position));
  }, [position]);

  // Reveal on pointer/focus of the wrapper. Listeners are attached to the
  // wrapper element directly (pointerenter/leave don't bubble; focusin/out do,
  // so focusing the inner control still reveals). Kept off JSX props to avoid
  // preact focus-event naming ambiguity.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const show = () => setOpen(true);
    const hide = () => setOpen(false);
    wrap.addEventListener("pointerenter", show);
    wrap.addEventListener("pointerleave", hide);
    wrap.addEventListener("focusin", show);
    wrap.addEventListener("focusout", hide);
    return () => {
      wrap.removeEventListener("pointerenter", show);
      wrap.removeEventListener("pointerleave", hide);
      wrap.removeEventListener("focusin", show);
      wrap.removeEventListener("focusout", hide);
    };
  }, []);

  // While open: position before paint, then flip `is-open` on the next frame so
  // the opacity transition plays. Scrolling or resizing closes the bubble — the
  // capture-phase scroll listener catches scrolls in any ancestor scroller.
  useLayoutEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    compute();
    const raf = requestAnimationFrame(() => setShown(true));
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, compute]);

  return { wrapRef, bubbleRef, open, shown, coords };
}

/** Renders the portaled bubble. Returns null until the wrapper is open. */
function TooltipBubble({
  open,
  shown,
  coords,
  bubbleRef,
  bubbleId,
  position,
  text,
}: {
  open: boolean;
  shown: boolean;
  coords: Coords | null;
  bubbleRef: RefObject<HTMLSpanElement>;
  bubbleId: string;
  position: TooltipPosition;
  text: string;
}) {
  if (!open) return null;
  return createPortal(
    <span
      ref={bubbleRef}
      class={`gsv-tt-bub gsv-tt-portal gsv-sublabel ${POS_CLASS[position]}${shown ? " is-open" : ""}`}
      id={bubbleId}
      role="tooltip"
      style={coords ? { left: `${coords.left}px`, top: `${coords.top}px` } : undefined}
    >
      {text}
      <span class="gsv-tt-arrow" />
    </span>,
    document.body,
  );
}

/** Tooltip — ported from Tooltip.dc.html. Dashed-underline trigger with a black
 *  bubble revealed on hover, positionable on four sides. The bubble is portaled
 *  to <body> so it escapes ancestor clipping/stacking. */
export function Tooltip({
  trigger = "HOVER ME",
  text = "A short hint about this control.",
  position = "top",
  children,
}: TooltipProps) {
  const bubbleId = useId();
  const bare = children != null;
  const { wrapRef, bubbleRef, open, shown, coords } = useTooltipReveal(position);
  return (
    <span ref={wrapRef} class={`gsv-tt ${POS_CLASS[position]}`}>
      <button
        type="button"
        class={`gsv-tt-trigger${bare ? " gsv-tt-trigger-bare" : ""}`}
        aria-describedby={bubbleId}
      >
        {bare ? children : trigger}
      </button>
      <TooltipBubble
        open={open}
        shown={shown}
        coords={coords}
        bubbleRef={bubbleRef}
        bubbleId={bubbleId}
        position={position}
        text={text}
      />
    </span>
  );
}

export interface HintProps {
  /** The hint shown in the tooltip bubble. */
  text: string;
  /** Which side the bubble opens on (default "top"). */
  position?: TooltipPosition;
  /** The interactive control to attach the tooltip to. Rendered as-is (no extra
   *  wrapper button) so it stays a single focusable element. */
  children: ComponentChildren;
}

/** Hint — attaches the design-system tooltip bubble to an existing interactive
 *  control (button, label, etc.) instead of rendering its own trigger button.
 *  The child stays the sole focusable element (no nested buttons); the bubble is
 *  revealed on hover/focus of the wrapper. When the child is a single element it
 *  is cloned to receive `aria-describedby` pointing at the bubble. Use this to
 *  give icon buttons a styled, explanatory tooltip in place of native `title`. */
export function Hint({ text, position = "top", children }: HintProps) {
  const bubbleId = useId();
  const { wrapRef, bubbleRef, open, shown, coords } = useTooltipReveal(position);
  const child = isValidElement(children)
    ? cloneElement(children as VNode<{ "aria-describedby"?: string }>, { "aria-describedby": bubbleId })
    : children;
  return (
    <span ref={wrapRef} class={`gsv-tt ${POS_CLASS[position]} gsv-hint`}>
      {child}
      <TooltipBubble
        open={open}
        shown={shown}
        coords={coords}
        bubbleRef={bubbleRef}
        bubbleId={bubbleId}
        position={position}
        text={text}
      />
    </span>
  );
}
