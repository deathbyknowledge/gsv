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

export function ChatApprovalBanner({ busy, onDecision, pendingHil }: ChatApprovalBannerProps) {
  const argsSummary = summarizeHilArgs(pendingHil.args);
  const createdAt = formatHilTime(pendingHil.createdAt);

  return (
    <section
      class={`gsv-chat-hil${busy ? " is-busy" : ""}`}
      aria-label="Human approval pending"
      aria-busy={busy}
    >
      <div class="gsv-chat-hil-head">
        <span>APPROVAL REQUIRED</span>
        <strong>{pendingHil.toolName || pendingHil.syscall}</strong>
      </div>
      <p>{argsSummary}</p>
      <small class="gsv-chat-hil-meta">
        {pendingHil.syscall}
        {" · request "}
        {shortId(pendingHil.requestId)}
        {pendingHil.runId ? ` · run ${shortId(pendingHil.runId)}` : ""}
        {createdAt ? ` · ${createdAt}` : ""}
      </small>
      <div class="gsv-chat-hil-actions">
        <button
          type="button"
          class="gsv-chat-hil-deny"
          disabled={busy}
          onClick={() => onDecision("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          class="gsv-chat-hil-approve"
          disabled={busy}
          onClick={() => onDecision("approve")}
        >
          {busy ? "Applying" : "Approve"}
        </button>
        <button
          type="button"
          class="gsv-chat-hil-approve"
          disabled={busy}
          onClick={() => onDecision("approve", true)}
        >
          Always allow
        </button>
      </div>
    </section>
  );
}
