import type { ComponentChildren } from "preact";
import { Tag, type TagTone } from "../../../components/ui/Tag";

export type ChatFeedbackStatus = "running" | "success" | "error";

const STATUS_TONE: Record<ChatFeedbackStatus, TagTone> = {
  running: "info",
  success: "online",
  error: "error",
};

type ChatFeedbackMessageProps = {
  label: string;
  status: ChatFeedbackStatus;
  /** Optional right-aligned affordance (e.g. an expand-reasoning link). */
  action?: ComponentChildren;
};

/** ChatFeedbackMessage — the plain feedback line used for operation status and
 *  run activity in the chat body: a plain Tag whose dot pulses while running,
 *  then flips to the success/error tone. Carries no live-region role of its
 *  own — the transcript container's aria-live announces changes (a role per
 *  historical line would spam screen readers as virtualized rows mount). */
export function ChatFeedbackMessage({ label, status, action }: ChatFeedbackMessageProps) {
  return (
    <div class={`gsv-chat-feedback is-${status}`}>
      <Tag tone={STATUS_TONE[status]} label={label} dot pulse={status === "running"} size="medium" />
      {action ? <span class="gsv-chat-feedback-action">{action}</span> : null}
    </div>
  );
}
