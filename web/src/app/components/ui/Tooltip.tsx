import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import "./Tooltip.css";

export type TooltipPosition = "top" | "bottom" | "left" | "right";

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
      <span class="gsv-tt-bub" id={bubbleId} role="tooltip">
        {text}
        <span class="gsv-tt-arrow" />
      </span>
    </span>
  );
}
