import type { ComponentChildren } from "preact";
import { Tag, type TagTone } from "../../../components/ui/Tag";

export type ChatFeedbackStatus = "running" | "success" | "error" | "attention";

const STATUS_TONE: Record<ChatFeedbackStatus, TagTone> = {
  running: "info",
  success: "online",
  error: "error",
  attention: "update",
};

type ChatFeedbackMessageProps = {
  label: string;
  status: ChatFeedbackStatus;
  /** Quiet trailing text beside the label (e.g. the live elapsed ticker).
   *  Hidden from assistive tech: it changes every second inside the
   *  transcript's aria-live region, which would announce each tick. */
  detail?: string;
  /** Optional right-aligned affordance (e.g. an expand-reasoning link). */
  action?: ComponentChildren;
};

/** ChatFeedbackMessage — the plain feedback line used for operation status and
 *  run activity in the chat body: a plain Tag whose dot pulses while running,
 *  then flips to the success/error tone. Carries no live-region role of its
 *  own — the transcript container's aria-live announces changes (a role per
 *  historical line would spam screen readers as virtualized rows mount). */
export function ChatFeedbackMessage({ label, status, detail, action }: ChatFeedbackMessageProps) {
  return (
    <div class={`gsv-chat-feedback is-${status}`}>
      <Tag tone={STATUS_TONE[status]} label={label} dot pulse={status === "running"} size="medium" />
      {detail ? <span class="gsv-chat-feedback-detail" aria-hidden="true">{detail}</span> : null}
      {action ? <span class="gsv-chat-feedback-action">{action}</span> : null}
    </div>
  );
}
