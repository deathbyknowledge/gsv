import { useState } from "preact/hooks";
import type {
  PendingAction,
  SendMessageArgs,
  SocialChannelDetail,
  SocialMessageWorkflowItem,
  SocialState,
  UpdateMessageWorkflowArgs,
} from "../../types";
import { filterInboxWorkflows, type InboxFilter, workflowContactHandle } from "../../domain/messageWorkflow";
import { formatShortDate } from "../../utils/format";
import { EmptyState, StatusDot, StatusPill } from "../ui/primitives";
import { ChannelDetailPane } from "../channels/ChannelDetailPane";

export function AttentionSection(props: {
  state: SocialState | null;
  detail: SocialChannelDetail | null;
  selectedWorkflowId: string | null;
  detailOpen: boolean;
  pendingAction: PendingAction | null;
  onSelectWorkflow: (workflow: SocialMessageWorkflowItem) => void;
  onSendMessage: (args: SendMessageArgs) => void;
  onUpdateWorkflow: (args: UpdateMessageWorkflowArgs) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("active");
  const workflows = filterInboxWorkflows(props.state?.messageWorkflows ?? [], filter);

  return (
    <section class={`social-section social-inbox-section${props.detailOpen ? " is-detail-open" : ""}`}>
      <aside class="social-list-pane">
        <header class="social-list-header">
          <div>
            <p class="social-eyebrow">Inbox</p>
            <h1>Attention</h1>
          </div>
          <span>{workflows.length}</span>
        </header>
        <div class="social-segmented" aria-label="Attention filter">
          {([
            ["active", "Active"],
            ["needs-human", "Human"],
            ["all", "All"],
          ] as Array<[InboxFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              class={filter === value ? "is-active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div class="social-scroll-list">
          {props.pendingAction === "load" ? <p class="social-list-note">Loading inbox...</p> : null}
          {workflows.length ? workflows.map((workflow) => (
            <button
              key={workflow.messageId}
              type="button"
              class={`social-row-button${workflow.messageId === props.selectedWorkflowId ? " is-active" : ""}`}
              onClick={() => props.onSelectWorkflow(workflow)}
            >
              <StatusDot status={workflow.state} />
              <span class="social-row-main">
                <strong>{workflow.summary || "Incoming Contact"}</strong>
                <small>{workflowContactHandle(workflow)} - {formatShortDate(workflow.updatedAt)}</small>
              </span>
              <StatusPill status={workflow.state} />
            </button>
          )) : <EmptyState title="No incoming contact work" body="Active contact requests and escalations will appear here." />}
        </div>
      </aside>

      <ChannelDetailPane
        identityHandle={props.state?.identity?.handle ?? null}
        detail={props.detail}
        pendingAction={props.pendingAction}
        emptyTitle="No attention item selected"
        emptyBody="Choose an incoming contact item to inspect its channel and update workflow."
        highlightWorkflowId={props.selectedWorkflowId}
        onSendMessage={props.onSendMessage}
        onUpdateWorkflow={props.onUpdateWorkflow}
      />
    </section>
  );
}
