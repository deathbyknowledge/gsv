import "./Tooltip.css";

export type TooltipPosition = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  trigger?: string;
  text?: string;
  position?: TooltipPosition;
}

const POS_CLASS: Record<TooltipPosition, string> = {
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
}: TooltipProps) {
  return (
    <span class={`gsv-tt ${POS_CLASS[position]}`}>
      <span class="gsv-tt-trigger">{trigger}</span>
      <span class="gsv-tt-bub">
        {text}
        <span class="gsv-tt-arrow" />
      </span>
    </span>
  );
}
