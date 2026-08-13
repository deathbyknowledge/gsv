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
      <header class="text-client-approval-header">
        <span class="text-client-approval-kicker">Approval required</span>
        <h2>Review before continuing</h2>
      </header>

      <dl class="text-client-approval-fields">
        <div>
          <dt>Action</dt>
          <dd>{action}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{target}</dd>
        </div>
      </dl>

      {detail ? <p class="text-client-approval-detail">{detail}</p> : null}

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
