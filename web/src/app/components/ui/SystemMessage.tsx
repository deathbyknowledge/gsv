import type { ComponentChildren } from "preact";
import { MessageMeta } from "./MessageMeta";
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
        <MessageMeta
          mirror
          time={time}
          actions={meta}
          copyLabel={copyLabel}
          copyAriaLabel={copyAriaLabel ?? copyTitle}
          copyDisabled={copyDisabled}
          copyFailed={copyFailed}
          onCopy={onCopy}
        />
      </div>
    </div>
  );
}
