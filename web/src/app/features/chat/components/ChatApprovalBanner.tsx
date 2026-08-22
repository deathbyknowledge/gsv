import { Button } from "../../../components/ui/Button";
import { Hint } from "../../../components/ui/Tooltip";
import type { ChatHilDecision, ChatHistory } from "../domain/processes";
import type { MailSendArgs } from "@humansandmachines/gsv/protocol";
import { shortId } from "./chatUiFormat";

type PendingHil = NonNullable<ChatHistory["pendingHil"]>;
type HilValue = string | number | boolean | null | HilValue[] | { [key: string]: HilValue };
type HilArgs = Record<string, HilValue>;

function isStringValue(value: HilValue): value is string {
  return typeof value === "string";
}

type ChatApprovalBannerProps = {
  busy: boolean;
  onDecision: (decision: ChatHilDecision, remember?: boolean) => void;
  pendingHil: PendingHil;
};

function formatHilTime(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function summarizeHilValue(value: HilValue): string {
  if (isStringValue(value)) return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type MailSendApprovalField = keyof Pick<
  MailSendArgs,
  "to" | "replyToMessageId" | "subject" | "text"
>;

function boundedApprovalText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : normalized;
}

function mailSendString(
  args: HilArgs,
  field: MailSendApprovalField,
): string | null {
  const value = args[field];
  return isStringValue(value) ? value : null;
}

function summarizeMailSendArgs(args: HilArgs): string {
  const to = boundedApprovalText(mailSendString(args, "to") ?? "", 160);
  const replyToMessageId = boundedApprovalText(
    mailSendString(args, "replyToMessageId") ?? "",
    160,
  );
  const subject = boundedApprovalText(mailSendString(args, "subject") ?? "", 120);
  const text = mailSendString(args, "text");
  const destination = to
    ? `To: ${to}`
    : replyToMessageId
      ? `Reply to message: ${replyToMessageId}`
      : "Recipient: not provided";
  const subjectSummary = subject
    ? `Subject: ${subject}`
    : replyToMessageId
      ? "Subject: original thread"
      : "Subject: not provided";
  if (text === null) {
    return `${destination} · ${subjectSummary} · Body: not provided`;
  }
  const bodyBytes = new TextEncoder().encode(text).byteLength;
  const preview = boundedApprovalText(text, 96);
  const bodySummary = preview
    ? `Body: ${bodyBytes} bytes · Preview: ${preview}`
    : `Body: ${bodyBytes} bytes`;
  return `${destination} · ${subjectSummary} · ${bodySummary}`;
}

export function summarizeHilArgs(
  syscall: string,
  args: HilArgs | null | undefined,
): string {
  if (!args || Object.keys(args).length === 0) {
    return "No tool arguments were provided.";
  }
  if (syscall === "mail.send") {
    return summarizeMailSendArgs(args);
  }

  const entries = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => {
      const valueText = summarizeHilValue(value);
      const normalized = valueText.length > 80 ? `${valueText.slice(0, 77)}...` : valueText;
      return `${key}: ${normalized}`;
    });
  const remaining = Object.keys(args).length - entries.length;

  return remaining > 0
    ? `${entries.join(" · ")} · +${remaining} more`
    : entries.join(" · ");
}

/** ChatApprovalBanner — unboxed approval prompt (HAM-487): yellow label title,
 *  muted paragraph message, right-aligned toned link buttons. */
export function ChatApprovalBanner({ busy, onDecision, pendingHil }: ChatApprovalBannerProps) {
  const argsSummary = summarizeHilArgs(pendingHil.syscall, pendingHil.args);
  const createdAt = formatHilTime(pendingHil.createdAt);
  const toolLabel = pendingHil.toolName || pendingHil.syscall;
  const metaLabel = [
    pendingHil.syscall,
    `request ${shortId(pendingHil.requestId)}`,
    ...(pendingHil.runId ? [`run ${shortId(pendingHil.runId)}`] : []),
    ...(createdAt ? [createdAt] : []),
  ].join(" · ");

  return (
    <section
      class={`gsv-chat-hil${busy ? " is-busy" : ""}`}
      aria-label="Human approval pending"
      aria-busy={busy}
    >
      <div class="gsv-chat-hil-title gsv-message-label">
        <span>APPROVAL REQUIRED</span>
        <Hint text={toolLabel}>
          <strong>{toolLabel}</strong>
        </Hint>
      </div>
      <p class="gsv-chat-hil-body gsv-prose">{argsSummary}</p>
      <Hint text={metaLabel}>
        <small class="gsv-chat-hil-meta gsv-sublabel">{metaLabel}</small>
      </Hint>
      <div class="gsv-chat-hil-actions">
        <Button
          variant="link"
          tone="error"
          label="DENY"
          disabled={busy}
          onClick={() => onDecision("deny")}
        />
        <Button
          variant="link"
          tone="neutral"
          label={busy ? "APPLYING" : "ALLOW ONCE"}
          disabled={busy}
          onClick={() => onDecision("approve")}
        />
        <Button
          variant="link"
          tone="success"
          label="ALWAYS ALLOW"
          disabled={busy}
          onClick={() => onDecision("approve", true)}
        />
      </div>
    </section>
  );
}
