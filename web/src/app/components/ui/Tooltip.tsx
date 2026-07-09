import type { ComponentChildren, VNode } from "preact";
import { cloneElement, isValidElement } from "preact";
import { useId } from "preact/hooks";
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

/** Tooltip — ported from Tooltip.dc.html. Dashed-underline trigger with a black
 *  bubble revealed on hover, positionable on four sides. */
export function Tooltip({
  trigger = "HOVER ME",
  text = "A short hint about this control.",
  position = "top",
  children,
}: TooltipProps) {
  const bubbleId = useId();
  const bare = children != null;
  return (
    <span class={`gsv-tt ${POS_CLASS[position]}`}>
      <button
        type="button"
        class={`gsv-tt-trigger${bare ? " gsv-tt-trigger-bare" : ""}`}
        aria-describedby={bubbleId}
      >
        {bare ? children : trigger}
      </button>
      <span class="gsv-tt-bub gsv-sublabel" id={bubbleId} role="tooltip">
        {text}
        <span class="gsv-tt-arrow" />
      </span>
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
  const child = isValidElement(children)
    ? cloneElement(children as VNode<{ "aria-describedby"?: string }>, { "aria-describedby": bubbleId })
    : children;
  return (
    <span class={`gsv-tt ${POS_CLASS[position]} gsv-hint`}>
      {child}
      <span class="gsv-tt-bub gsv-sublabel" id={bubbleId} role="tooltip">
        {text}
        <span class="gsv-tt-arrow" />
      </span>
    </span>
  );
}
