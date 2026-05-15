import type {
  PendingAction,
  SendMessageArgs,
  SocialChannelDetail,
  SocialState,
  UpdateMessageWorkflowArgs,
} from "../../types";
import { channelAttentionCount } from "../../domain/messageWorkflow";
import { formatShortDate } from "../../utils/format";
import { EmptyState, StatusDot, StatusPill } from "../ui/primitives";
import { ChannelDetailPane } from "./ChannelDetailPane";

export function ChannelsSection(props: {
  state: SocialState | null;
  detail: SocialChannelDetail | null;
  selectedChannelId: string | null;
  detailOpen: boolean;
  pendingAction: PendingAction | null;
  onSelectChannel: (channelId: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
  onUpdateWorkflow: (args: UpdateMessageWorkflowArgs) => void;
}) {
  const channels = props.state?.channels ?? [];
  const workflows = props.state?.messageWorkflows ?? [];
  return (
    <section class={`social-section social-channels-section${props.detailOpen ? " is-detail-open" : ""}`}>
      <aside class="social-list-pane">
        <header class="social-list-header">
          <div>
            <p class="social-eyebrow">Channels</p>
            <h1>Conversations</h1>
          </div>
          <span>{channels.length}</span>
        </header>
        <div class="social-scroll-list">
          {props.pendingAction === "load" ? <p class="social-list-note">Loading channels...</p> : null}
          {channels.length ? channels.map((channel) => {
            const attentionCount = channelAttentionCount(channel, workflows);
            return (
              <button
                key={channel.channelId}
                type="button"
                class={`social-row-button${channel.channelId === props.selectedChannelId ? " is-active" : ""}`}
                onClick={() => props.onSelectChannel(channel.channelId)}
              >
                <StatusDot status={attentionCount ? "attention" : channel.status} />
                <span class="social-row-main">
                  <strong>{channel.contactHandle}</strong>
                  <small>{channel.workflowCount} workflow items - {formatShortDate(channel.updatedAt)}</small>
                </span>
                <StatusPill status={channel.status} />
              </button>
            );
          }) : <EmptyState title="No channels" body="Start a message from Contacts after establishing a trusted contact." />}
        </div>
      </aside>

      <ChannelDetailPane
        identityHandle={props.state?.identity?.handle ?? null}
        detail={props.detail}
        pendingAction={props.pendingAction}
        emptyTitle="No channel selected"
        emptyBody="Choose a channel from the list, or start one from Contacts."
        onSendMessage={props.onSendMessage}
        onUpdateWorkflow={props.onUpdateWorkflow}
      />
    </section>
  );
}
