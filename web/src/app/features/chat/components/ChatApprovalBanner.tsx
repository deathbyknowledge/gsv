import { Button } from "../../../components/ui/Button";
import { Hint } from "../../../components/ui/Tooltip";
import type { ChatHilDecision, ChatHistory } from "../domain/processes";
import { shortId } from "./chatUiFormat";

type PendingHil = NonNullable<ChatHistory["pendingHil"]>;

type ChatApprovalBannerProps = {
  busy: boolean;
  onDecision: (decision: ChatHilDecision, remember?: boolean) => void;
  pendingHil: PendingHil;
};

function formatHilTime(timestamp: number | null | undefined): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function summarizeHilValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function summarizeHilArgs(args: Record<string, unknown> | null | undefined): string {
  if (!args || Object.keys(args).length === 0) {
    return "No tool arguments were provided.";
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
  const argsSummary = summarizeHilArgs(pendingHil.args);
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
