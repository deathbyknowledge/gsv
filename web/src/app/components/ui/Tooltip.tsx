import type { ComponentChildren, JSX, RefObject, VNode } from "preact";
import { cloneElement, isValidElement } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
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

/** Wrapper position class. Still used by InfoTip (in-flow bubble) and kept on the
 *  Tooltip/Hint wrapper for parity, though the portaled bubble is positioned in
 *  JS and driven by its resolved-side class instead. */
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

/** Resolved-side class on the portaled bubble — drives which arrow edge shows. */
type Side = "top" | "bottom" | "left" | "right";
const SIDE_CLASS: Record<Side, string> = {
  top: "gsv-tt-side-top",
  bottom: "gsv-tt-side-bottom",
  left: "gsv-tt-side-left",
  right: "gsv-tt-side-right",
};

/** Gap between the trigger's visible edge and the bubble edge. */
const MARGIN = 8;
/** Hover-intent dwell before a pointer opens the bubble. */
const HOVER_DELAY = 300;

interface Placement {
  left: number;
  top: number;
  side: Side;
  arrowOffset: number;
}

/* ── Singleton manager ───────────────────────────────────────────────────────
 * Only one tooltip is ever open. The active instance drives a single shared rAF
 * loop that re-tracks the trigger each frame; opening a new one closes the old.
 * All document/rAF access is lazy (inside these functions), so importing the
 * module in a node test env touches no browser globals. */

interface TooltipHandle {
  close: () => void;
}

interface ActiveTooltip {
  handle: TooltipHandle;
  track: () => void;
}

let activeTooltip: ActiveTooltip | null = null;
let rafId = 0;

function tick() {
  if (!activeTooltip) return;
  activeTooltip.track();
  rafId = requestAnimationFrame(tick);
}

function onDocumentPointerDown() {
  // Any pointerdown anywhere dismisses the open tooltip (the instance also
  // handles activation on its own trigger; this covers everything else).
  activeTooltip?.handle.close();
}

function openTooltip(handle: TooltipHandle, track: () => void) {
  if (activeTooltip && activeTooltip.handle !== handle) activeTooltip.handle.close();
  const first = activeTooltip === null;
  activeTooltip = { handle, track };
  if (first) {
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }
}

function closeTooltip(handle: TooltipHandle) {
  if (!activeTooltip || activeTooltip.handle !== handle) return;
  activeTooltip = null;
  cancelAnimationFrame(rafId);
  rafId = 0;
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
}

/** Force-close whatever tooltip is currently open (e.g. on route change). */
export function closeAllTooltips() {
  activeTooltip?.handle.close();
}

/* ── Geometry ────────────────────────────────────────────────────────────── */

/** The trigger's client rect intersected with every clipping ancestor and the
 *  viewport. Returns null when the trigger is fully scrolled/clipped out. */
function visibleRect(el: Element): DOMRect | null {
  const r0 = el.getBoundingClientRect();
  let left = r0.left;
  let top = r0.top;
  let right = r0.right;
  let bottom = r0.bottom;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const s = getComputedStyle(node);
    const clips =
      (s.overflow && s.overflow !== "visible") ||
      (s.overflowX && s.overflowX !== "visible") ||
      (s.overflowY && s.overflowY !== "visible");
    if (!clips) continue;
    const cr = node.getBoundingClientRect();
    left = Math.max(left, cr.left);
    top = Math.max(top, cr.top);
    right = Math.min(right, cr.right);
    bottom = Math.min(bottom, cr.bottom);
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth);
  bottom = Math.min(bottom, window.innerHeight);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

interface SidePref {
  side: Side;
  align: "center" | "start" | "end";
}

const SIDE_PREF: Record<TooltipPosition, SidePref> = {
  top: { side: "top", align: "center" },
  bottom: { side: "bottom", align: "center" },
  left: { side: "left", align: "center" },
  right: { side: "right", align: "center" },
  "top-start": { side: "top", align: "start" },
  "top-end": { side: "top", align: "end" },
  "bottom-start": { side: "bottom", align: "start" },
  "bottom-end": { side: "bottom", align: "end" },
};

/** Resolve the final on-screen placement of the bubble around the visible anchor
 *  rect: pick a side (flipping when the preferred side lacks room and its
 *  opposite has more), anchor + clamp the cross axis into the viewport, and
 *  compute the arrow offset so it keeps pointing at the anchor after clamping. */
function resolvePlacement(
  anchor: DOMRect,
  bw: number,
  bh: number,
  requested: TooltipPosition,
  margin = MARGIN,
): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { align } = SIDE_PREF[requested];
  let { side } = SIDE_PREF[requested];

  if (side === "top" || side === "bottom") {
    const spaceTop = anchor.top;
    const spaceBottom = vh - anchor.bottom;
    if (side === "top" && spaceTop < bh + margin && spaceBottom > spaceTop) side = "bottom";
    else if (side === "bottom" && spaceBottom < bh + margin && spaceTop > spaceBottom) side = "top";

    const top = side === "top" ? anchor.top - margin - bh : anchor.bottom + margin;
    const anchorX =
      align === "start" ? anchor.left : align === "end" ? anchor.right : anchor.left + anchor.width / 2;
    let left =
      align === "start" ? anchor.left : align === "end" ? anchor.right - bw : anchorX - bw / 2;
    left = clamp(left, margin, Math.max(margin, vw - margin - bw));
    const arrowOffset = clamp(anchorX - left, 10, bw - 10);
    return { left, top, side, arrowOffset };
  }

  // left / right — cross axis is vertical (center-aligned only)
  const spaceLeft = anchor.left;
  const spaceRight = vw - anchor.right;
  if (side === "left" && spaceLeft < bw + margin && spaceRight > spaceLeft) side = "right";
  else if (side === "right" && spaceRight < bw + margin && spaceLeft > spaceRight) side = "left";

  const left = side === "left" ? anchor.left - margin - bw : anchor.right + margin;
  const anchorY = anchor.top + anchor.height / 2;
  let top = anchorY - bh / 2;
  top = clamp(top, margin, Math.max(margin, vh - margin - bh));
  const arrowOffset = clamp(anchorY - top, 10, bh - 10);
  return { left, top, side, arrowOffset };
}

function placementsEqual(a: Placement, b: Placement): boolean {
  return (
    a.side === b.side &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.arrowOffset - b.arrowOffset) < 0.5
  );
}

/* ── Reveal hook ─────────────────────────────────────────────────────────── */

/** Shared reveal + tracking logic for Tooltip and Hint. The bubble is portaled
 *  into <body> (so no ancestor overflow/transform/z-index can clip it) and, while
 *  open, is re-positioned every frame by the singleton manager against the
 *  trigger's currently-visible rect. Reveal is JS-driven since a portaled node is
 *  not a descendant of the hovered wrapper. */
function useTooltipReveal(position: TooltipPosition) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const handleRef = useRef<TooltipHandle | null>(null);
  if (!handleRef.current) handleRef.current = { close: () => setOpen(false) };
  const lastPlacementRef = useRef<Placement | null>(null);
  const shownRef = useRef(false);

  // Reveal listeners on the wrapper. pointerenter/leave don't bubble, focusin/out
  // do (so focusing the inner control still reveals). Hover uses intent: a dwell
  // timer armed on pointermove — NOT pointerenter — so content sliding under a
  // stationary pointer never opens a tooltip. Gated on a real hover pointer.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const canHover =
      typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;

    let hoverTimer = 0;
    // After activation, suppress the focus-open and hover re-arm that would
    // otherwise immediately reopen the just-dismissed bubble.
    let suppressFocusOpen = false;
    let suppressHover = false;

    const disarm = () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
    };
    const onMove = () => {
      if (suppressHover || hoverTimer) return;
      hoverTimer = window.setTimeout(() => {
        hoverTimer = 0;
        setOpen(true);
      }, HOVER_DELAY);
    };
    const onLeave = () => {
      disarm();
      suppressHover = false;
      setOpen(false);
    };
    const onFocusIn = () => {
      if (suppressFocusOpen) return;
      setOpen(true);
    };
    const onFocusOut = () => {
      suppressFocusOpen = false;
      setOpen(false);
    };
    const onActivate = () => {
      disarm();
      suppressHover = true;
      suppressFocusOpen = true;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") onActivate();
    };

    if (canHover) {
      wrap.addEventListener("pointermove", onMove);
      wrap.addEventListener("pointerleave", onLeave);
    }
    wrap.addEventListener("focusin", onFocusIn);
    wrap.addEventListener("focusout", onFocusOut);
    wrap.addEventListener("pointerdown", onActivate);
    wrap.addEventListener("keydown", onKeyDown);
    return () => {
      disarm();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("focusin", onFocusIn);
      wrap.removeEventListener("focusout", onFocusOut);
      wrap.removeEventListener("pointerdown", onActivate);
      wrap.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // While open: register with the manager (drives the shared rAF track loop) and
  // install an Escape handler that closes ONLY this tooltip. Cleanup on close.
  useEffect(() => {
    if (!open) {
      shownRef.current = false;
      setShown(false);
      lastPlacementRef.current = null;
      setPlacement(null);
      return;
    }
    const handle = handleRef.current!;
    const track = () => {
      const wrap = wrapRef.current;
      const bub = bubbleRef.current;
      if (!wrap || !bub) return;
      const rect = visibleRect(wrap);
      if (!rect) {
        handle.close();
        return;
      }
      const next = resolvePlacement(rect, bub.offsetWidth, bub.offsetHeight, position);
      const last = lastPlacementRef.current;
      if (!last || !placementsEqual(last, next)) {
        lastPlacementRef.current = next;
        setPlacement(next);
      }
      if (!shownRef.current) {
        shownRef.current = true;
        setShown(true);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handle.close();
      }
    };
    document.addEventListener("keydown", onEscape, true);
    openTooltip(handle, track);
    return () => {
      document.removeEventListener("keydown", onEscape, true);
      closeTooltip(handle);
    };
  }, [open, position]);

  return { wrapRef, bubbleRef, open, shown, placement };
}

/** Renders the portaled bubble. Returns null until the wrapper is open. */
function TooltipBubble({
  open,
  shown,
  placement,
  bubbleRef,
  bubbleId,
  text,
}: {
  open: boolean;
  shown: boolean;
  placement: Placement | null;
  bubbleRef: RefObject<HTMLSpanElement>;
  bubbleId: string;
  text: string;
}) {
  if (!open) return null;
  const sideClass = placement ? SIDE_CLASS[placement.side] : "";
  const style = placement
    ? ({
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        "--gsv-tt-arrow-offset": `${placement.arrowOffset}px`,
      } as JSX.CSSProperties)
    : undefined;
  return createPortal(
    <span
      ref={bubbleRef}
      class={`gsv-tt-bub gsv-tt-portal gsv-sublabel ${sideClass}${shown ? " is-open" : ""}`}
      id={bubbleId}
      role="tooltip"
      style={style}
    >
      {text}
      <span class="gsv-tt-arrow" />
    </span>,
    document.body,
  );
}

/** Tooltip — ported from Tooltip.dc.html. Dashed-underline trigger with a black
 *  bubble revealed on hover/focus, positionable on eight sides. The bubble is
 *  portaled to <body> so it escapes ancestor clipping/stacking, and tracks the
 *  trigger while open. */
export function Tooltip({
  trigger = "HOVER ME",
  text = "A short hint about this control.",
  position = "top",
  children,
}: TooltipProps) {
  const bubbleId = useId();
  const bare = children != null;
  const { wrapRef, bubbleRef, open, shown, placement } = useTooltipReveal(position);
  return (
    <span ref={wrapRef} class={`gsv-tt ${POS_CLASS[position]}`}>
      <button
        type="button"
        class={`gsv-tt-trigger${bare ? " gsv-tt-trigger-bare" : ""}`}
        aria-describedby={open ? bubbleId : undefined}
      >
        {bare ? children : trigger}
      </button>
      <TooltipBubble
        open={open}
        shown={shown}
        placement={placement}
        bubbleRef={bubbleRef}
        bubbleId={bubbleId}
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
 *  is cloned to receive `aria-describedby` pointing at the bubble (only while it
 *  is mounted). Use this to give icon buttons a styled, explanatory tooltip in
 *  place of native `title`. */
export function Hint({ text, position = "top", children }: HintProps) {
  const bubbleId = useId();
  const { wrapRef, bubbleRef, open, shown, placement } = useTooltipReveal(position);
  const child = isValidElement(children)
    ? cloneElement(children as VNode<{ "aria-describedby"?: string }>, {
        "aria-describedby": open ? bubbleId : undefined,
      })
    : children;
  return (
    <span ref={wrapRef} class={`gsv-tt ${POS_CLASS[position]} gsv-hint`}>
      {child}
      <TooltipBubble
        open={open}
        shown={shown}
        placement={placement}
        bubbleRef={bubbleRef}
        bubbleId={bubbleId}
        text={text}
      />
    </span>
  );
}
