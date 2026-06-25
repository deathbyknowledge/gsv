import type { ComponentChildren } from "preact";
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

/** SystemMessage — avatar + message bubble with a meta row for timestamp/copy actions. */
export function SystemMessage({
  children,
  copyAriaLabel,
  copyDisabled = false,
  copyFailed = false,
  copyLabel = "COPY",
  copyTitle = "Copy message",
  meta,
  text = "",
  time = "",
  onCopy,
}: SystemMessageProps) {
  return (
    <div class="gsv-sm">
      <div class="gsv-sm-avatar">
        <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
          <g fill="#eef1f8">
            <rect x="7" y="1" width="2" height="2" />
            <rect x="6" y="3" width="4" height="6" />
            <rect x="4" y="6" width="2" height="3" />
            <rect x="10" y="6" width="2" height="3" />
            <rect x="7" y="11" width="2" height="3" fill="#a9a4ff" />
          </g>
        </svg>
      </div>
      <div class="gsv-sm-body">
        <div class="gsv-sm-text">{children ?? text}</div>
        <div class="gsv-sm-meta">
          {time ? <span>{time}</span> : null}
          {meta}
          <button
            type="button"
            class={`gsv-sm-copy${copyFailed ? " is-failed" : ""}`}
            disabled={copyDisabled}
            aria-label={copyAriaLabel}
            title={copyTitle}
            onClick={onCopy}
          >
            <svg width="10" height="10" viewBox="0 0 16 16">
              <g fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="6" y="6" width="7" height="7" />
              </g>
            </svg>
            {copyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
