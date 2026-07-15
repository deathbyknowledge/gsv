import type { ComponentChildren } from "preact";
import { Hint } from "./Tooltip";
import "./SystemMessage.css";

export interface SystemMessageProps {
  children?: ComponentChildren;
  text?: string;
  time?: string;
  copyAriaLabel?: string;
  copyDisabled?: boolean;
  copyLabel?: string;
  copyTitle?: string;
  copyFailed?: boolean;
  meta?: ComponentChildren;
  onCopy?: () => void;
}

/** SystemMessage — message body with a quiet meta row: icon-only actions with
 *  tooltip labels, timestamp at the end of the line revealed on hover/focus. */
export function SystemMessage({
  children,
  copyAriaLabel,
  copyDisabled = false,
  copyFailed = false,
  copyLabel = "Copy message",
  copyTitle = "Copy message",
  meta,
  text = "",
  time = "",
  onCopy,
}: SystemMessageProps) {
  return (
    <div class="gsv-sm">
      <div class="gsv-sm-body">
        <div class="gsv-sm-text gsv-prose">{children ?? text}</div>
        <div class="gsv-sm-meta gsv-sublabel">
          {meta}
          <Hint position="top" text={copyLabel}>
            <button
              type="button"
              class={`gsv-sm-copy${copyFailed ? " is-failed" : ""}`}
              disabled={copyDisabled}
              aria-label={copyAriaLabel ?? copyTitle}
              onClick={onCopy}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <g fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="6" y="6" width="7" height="7" />
                </g>
              </svg>
            </button>
          </Hint>
          {time ? <span class="gsv-sm-time">{time}</span> : null}
        </div>
      </div>
    </div>
  );
}
