import type { ComponentChildren } from "preact";
import { Hint } from "./Tooltip";
import "./MessageMeta.css";

export interface MessageMetaProps {
  /** Timestamp shown at the line start, revealed on hover/focus (always
   *  visible on touch). Consumers may widen the reveal to the whole message
   *  via `<ancestor>:hover .gsv-mm-time { opacity: 1 }`. */
  time?: string;
  /** Leading icon actions rendered before the copy button (branch,
   *  reasoning, badges). Use `.gsv-mm-btn` for consistent icon buttons. */
  actions?: ComponentChildren;
  copyLabel?: string;
  copyAriaLabel?: string;
  copyDisabled?: boolean;
  copyFailed?: boolean;
  onCopy?: () => void;
}

/** MessageMeta — the quiet meta row shared by chat messages: hover-revealed
 *  timestamp on the left, icon-only actions (tooltip labels) on the right. */
export function MessageMeta({
  time = "",
  actions,
  copyLabel = "Copy message",
  copyAriaLabel,
  copyDisabled = false,
  copyFailed = false,
  onCopy,
}: MessageMetaProps) {
  return (
    <div class="gsv-mm gsv-sublabel">
      {time ? <span class="gsv-mm-time">{time}</span> : null}
      <span class="gsv-mm-actions">
        {actions}
        {onCopy ? (
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
        ) : null}
      </span>
    </div>
  );
}
