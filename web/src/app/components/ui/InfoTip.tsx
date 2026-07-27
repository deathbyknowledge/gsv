import { IconButton } from "./IconButton";
import { Hint, type TooltipPosition } from "./Tooltip";
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
 *  the IconButton "help" glyph as the trigger, wrapped in the portaled `Hint`
 *  so the bubble escapes any `overflow`-clipping ancestor (a field label row,
 *  a list row, a scroll container). The `gsv-infotip` wrapper is kept so
 *  InfoTip.css can align/space the trigger after a label. */
export function InfoTip({ text, position = "top", label = "More info" }: InfoTipProps) {
  return (
    <span class="gsv-infotip">
      <Hint text={text} position={position}>
        <IconButton glyph="help" ghost size={16} ariaLabel={label} />
      </Hint>
    </span>
  );
}
