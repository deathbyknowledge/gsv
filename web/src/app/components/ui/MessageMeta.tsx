import type { ComponentChildren } from "preact";
import { Hint } from "./Tooltip";
import "./MessageMeta.css";

export interface MessageMetaProps {
  /** Timestamp revealed on hover/focus (always visible on touch), like the
   *  icon actions. Consumers may widen the reveal to the whole message via
   *  `<ancestor>:hover .gsv-mm-time, <ancestor>:hover .gsv-mm-actions`. */
  time?: string;
  /** Leading icon actions rendered before the copy button (branch,
   *  reasoning, badges). Use `.gsv-mm-btn` for consistent icon buttons. */
  actions?: ComponentChildren;
  /** Mirror the row for left-aligned messages (assistant/system): icon
   *  actions lead on the left, timestamp trails on the right. Default is the
   *  user-bubble arrangement — timestamp left, actions right. */
  mirror?: boolean;
  copyLabel?: string;
  copyAriaLabel?: string;
  copyDisabled?: boolean;
  copyFailed?: boolean;
  onCopy?: () => void;
}

export interface CopyIconButtonProps {
  copyLabel?: string;
  copyAriaLabel?: string;
  copyDisabled?: boolean;
  copyFailed?: boolean;
  onCopy?: () => void;
}

/** CopyIconButton — the shared copy control: `.gsv-mm-btn` icon button with a
 *  Hint tooltip. Rendered inline by MessageMeta on desktop and inside the
 *  mobile swipe rail, so both surfaces stay one control. */
export function CopyIconButton({
  copyLabel = "Copy message",
  copyAriaLabel,
  copyDisabled = false,
  copyFailed = false,
  onCopy,
}: CopyIconButtonProps) {
  return (
    <Hint position="top" text={copyLabel}>
      <button
        type="button"
        class={`gsv-mm-btn${copyFailed ? " is-failed" : ""}`}
        disabled={copyDisabled}
        aria-label={copyAriaLabel ?? copyLabel}
        onClick={onCopy}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="6" y="6" width="7" height="7" />
          </g>
        </svg>
      </button>
    </Hint>
  );
}

/** MessageMeta — the quiet meta row shared by chat messages: hover-revealed
 *  timestamp and icon-only actions (tooltip labels), arranged to hug the
 *  message's aligned edge. */
export function MessageMeta({
  time = "",
  actions,
  mirror = false,
  copyLabel = "Copy message",
  copyAriaLabel,
  copyDisabled = false,
  copyFailed = false,
  onCopy,
}: MessageMetaProps) {
  return (
    <div class={`gsv-mm gsv-sublabel${mirror ? " gsv-mm--mirror" : ""}`}>
      {time ? <span class="gsv-mm-time">{time}</span> : null}
      <span class="gsv-mm-actions">
        {actions}
        {onCopy ? (
          <CopyIconButton
            copyLabel={copyLabel}
            copyAriaLabel={copyAriaLabel}
            copyDisabled={copyDisabled}
            copyFailed={copyFailed}
            onCopy={onCopy}
          />
        ) : null}
      </span>
    </div>
  );
}
