import { useId } from "preact/hooks";
import { IconButton } from "./IconButton";
import { POS_CLASS, type TooltipPosition } from "./Tooltip";
import "./Tooltip.css";
import "./InfoTip.css";

export interface InfoTipProps {
  /** The hint shown in the tooltip bubble. */
  text: string;
  /** Which side the bubble opens on (default "top"). */
  position?: TooltipPosition;
  /** Accessible name for the trigger (default "More info"). */
  label?: string;
}

/** InfoTip — a borderless help icon (circle + "?") that reveals a short hint on
 *  hover/focus. Drop it after a field label to surface extra info. It composes
 *  the IconButton "help" glyph as the trigger inside the tooltip bubble
 *  structure, so there's a single button (unlike Tooltip's children mode, which
 *  would nest a button inside a button). */
export function InfoTip({ text, position = "top", label = "More info" }: InfoTipProps) {
  const bubbleId = useId();
  return (
    <span class={`gsv-tt ${POS_CLASS[position]} gsv-infotip`}>
      <IconButton glyph="help" ghost size={16} ariaLabel={label} ariaDescribedBy={bubbleId} />
      <span class="gsv-tt-bub" id={bubbleId} role="tooltip">
        {text}
        <span class="gsv-tt-arrow" />
      </span>
    </span>
  );
}
