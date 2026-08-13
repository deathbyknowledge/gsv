import "../textClient.css";

export interface ApprovalPanelProps {
  action: string;
  target: string;
  detail?: string;
  busy?: boolean;
  onAllowOnce: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
  className?: string;
}

/** Presents already-curated approval copy without interpreting tool arguments. */
export function ApprovalPanel({
  action,
  target,
  detail,
  busy = false,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  className,
}: ApprovalPanelProps) {
  const classes = ["text-client-approval", className].filter(Boolean).join(" ");

  return (
    <section
      class={classes}
      aria-label="Approval required"
      aria-busy={busy}
    >
      <p class="text-client-approval-request">
        I want to <span>{action}</span> on <strong>{target || "this device"}</strong>:
      </p>
      {detail ? <pre class="text-client-approval-detail">{detail}</pre> : null}
      <p class="text-client-approval-scope">
        Always allow covers future actions of this kind on {target || "this device"} in this conversation.
      </p>

      <div class="text-client-approval-actions">
        <button
          type="button"
          class="text-client-action is-deny"
          disabled={busy}
          onClick={onDeny}
        >
          Deny
        </button>
        <button
          type="button"
          class="text-client-action"
          disabled={busy}
          onClick={onAllowOnce}
        >
          Allow once
        </button>
        <button
          type="button"
          class="text-client-action is-primary"
          disabled={busy}
          onClick={onAlwaysAllow}
        >
          Always allow
        </button>
      </div>
    </section>
  );
}
