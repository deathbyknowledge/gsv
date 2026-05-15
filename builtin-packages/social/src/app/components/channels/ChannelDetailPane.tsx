import { useState } from "preact/hooks";
import type {
  PendingAction,
  SendMessageArgs,
  SocialChannelDetail,
  SocialMessageItem,
  SocialMessageWorkflowItem,
  UpdateMessageWorkflowArgs,
} from "../../types";
import { MESSAGE_WORKFLOW_OPTIONS, workflowContactHandle } from "../../domain/messageWorkflow";
import { formatShortDate } from "../../utils/format";
import { EmptyState, PaneHeader, StatusPill, StructuredDetails } from "../ui/primitives";

export function ChannelDetailPane(props: {
  identityHandle: string | null;
  detail: SocialChannelDetail | null;
  pendingAction: PendingAction | null;
  emptyTitle: string;
  emptyBody: string;
  highlightWorkflowId?: string | null;
  onSendMessage: (args: SendMessageArgs) => void;
  onUpdateWorkflow: (args: UpdateMessageWorkflowArgs) => void;
}) {
  const channel = props.detail?.channel ?? null;
  if (!channel) {
    return (
      <div class="social-detail-pane">
        <EmptyState title={props.emptyTitle} body={props.emptyBody} />
      </div>
    );
  }

  const workflows = props.detail?.workflows ?? [];
  const workflowByMessage = new Map(workflows.map((workflow) => [workflow.messageId, workflow]));
  const activeWorkflows = workflows.filter((workflow) =>
    workflow.direction === "inbound" &&
    ["received", "triaged", "in_progress", "needs_human"].includes(workflow.state)
  );

  return (
    <section class="social-detail-pane social-channel-detail">
      <PaneHeader
        eyebrow="Channel"
        title={channel.contactHandle}
        meta={(
          <>
            <span>{channel.workflowCount} workflow items</span>
            <span>Updated {formatShortDate(channel.updatedAt)}</span>
          </>
        )}
        actions={(
          <>
            <StatusPill status={channel.status} />
            {activeWorkflows.length ? <StatusPill status="attention">{activeWorkflows.length} active</StatusPill> : null}
          </>
        )}
      />

      <div class="social-channel-body">
        <section class="social-message-stream" aria-label="Messages">
          {(props.detail?.messages ?? []).length ? props.detail!.messages.map((message) => (
            <MessageBubble
              key={message.messageId}
              message={message}
              identityHandle={props.identityHandle}
              workflow={workflowByMessage.get(message.messageId)}
            />
          )) : <EmptyState title="No messages" body="This conversation has not received or sent messages yet." />}
        </section>

        <aside class="social-workflow-rail" aria-label="Message workflow">
          <header class="social-rail-head">
            <h3>Workflow</h3>
            <span>{workflows.length}</span>
          </header>
          {workflows.length ? workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.messageId}
              identityHandle={props.identityHandle}
              workflow={workflow}
              highlighted={workflow.messageId === props.highlightWorkflowId}
              pending={props.pendingAction === "update-message-workflow"}
              onUpdateWorkflow={props.onUpdateWorkflow}
            />
          )) : <p class="social-list-note">No internal message workflow items.</p>}
        </aside>
      </div>

      <MessageForm
        contactHandle={channel.contactHandle}
        channelId={channel.channelId}
        pending={props.pendingAction === "send-message"}
        onSendMessage={props.onSendMessage}
      />
    </section>
  );
}

function MessageBubble(props: {
  message: SocialMessageItem;
  identityHandle: string | null;
  workflow?: SocialMessageWorkflowItem;
}) {
  const fromMe = props.identityHandle ? props.message.fromHandle === props.identityHandle : props.message.direction === "outbound";
  return (
    <article class={`social-message is-${fromMe ? "mine" : "theirs"}`}>
      <header>
        <strong>{fromMe ? "You" : props.message.fromHandle}</strong>
        <span>{props.message.deliveryStatus} - {formatShortDate(props.message.createdAt)}</span>
      </header>
      {props.message.text ? <p>{props.message.text}</p> : null}
      <StructuredDetails value={props.message.body} />
      {props.workflow ? (
        <footer class="social-message-workflow">
          <StatusPill status={props.workflow.state} />
          {props.workflow.summary ? <span>{props.workflow.summary}</span> : null}
        </footer>
      ) : null}
    </article>
  );
}

function WorkflowCard(props: {
  identityHandle: string | null;
  workflow: SocialMessageWorkflowItem;
  highlighted: boolean;
  pending: boolean;
  onUpdateWorkflow: (args: UpdateMessageWorkflowArgs) => void;
}) {
  const canUpdate = props.workflow.direction === "inbound" && props.workflow.toHandle === props.identityHandle;
  return (
    <article class={`social-workflow-card is-${props.workflow.direction}${props.highlighted ? " is-highlighted" : ""}`}>
      <header>
        <div>
          <p class="social-eyebrow">{props.workflow.direction === "inbound" ? "Incoming Contact" : "Remote Workflow"}</p>
          <h3>{props.workflow.summary || "Tracked message"}</h3>
        </div>
        <StatusPill status={props.workflow.state} />
      </header>
      <div class="social-workflow-meta">
        <span>{workflowContactHandle(props.workflow)}</span>
        <span>{formatShortDate(props.workflow.updatedAt)}</span>
      </div>
      {props.workflow.needsHumanReason ? <p class="social-structured-text">{props.workflow.needsHumanReason}</p> : null}
      <StructuredDetails value={props.workflow.body} />
      {canUpdate ? (
        <WorkflowUpdateForm
          workflow={props.workflow}
          pending={props.pending}
          onUpdateWorkflow={props.onUpdateWorkflow}
        />
      ) : null}
    </article>
  );
}

function MessageForm(props: {
  contactHandle: string;
  channelId?: string;
  pending: boolean;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      class="social-compose"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSendMessage({
          toHandle: props.contactHandle,
          text,
          ...(props.channelId ? { channelId: props.channelId } : {}),
        });
        setText("");
      }}
    >
      <label>
        <span>Message</span>
        <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} rows={3} />
      </label>
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !text.trim()}>
        Send
      </button>
    </form>
  );
}

function WorkflowUpdateForm(props: {
  workflow: SocialMessageWorkflowItem;
  pending: boolean;
  onUpdateWorkflow: (args: UpdateMessageWorkflowArgs) => void;
}) {
  const [state, setState] = useState<UpdateMessageWorkflowArgs["state"]>("completed");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      class="social-response-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onUpdateWorkflow({
          messageId: props.workflow.messageId,
          channelId: props.workflow.channelId,
          state,
          summary,
          needsHumanReason: state === "needs_human" ? reason : undefined,
        });
        setSummary("");
        setReason("");
      }}
    >
      <select value={state} onChange={(event) => setState(event.currentTarget.value as typeof state)}>
        {MESSAGE_WORKFLOW_OPTIONS.map((option) => (
          <option key={option.state} value={option.state}>{option.label}</option>
        ))}
      </select>
      <textarea
        value={summary}
        onInput={(event) => setSummary(event.currentTarget.value)}
        rows={2}
        placeholder="Summary"
      />
      {state === "needs_human" ? (
        <input
          value={reason}
          onInput={(event) => setReason(event.currentTarget.value)}
          placeholder="Reason"
        />
      ) : null}
      <button class="social-button social-button--primary" type="submit" disabled={props.pending}>
        Update
      </button>
    </form>
  );
}
