import type { SocialState } from "../../types";
import { compactId, formatJson, formatShortDate } from "../../utils/format";
import { EmptyState, FieldList, FieldRow, PaneHeader, StatusPill } from "../ui/primitives";

export function AdvancedSection(props: { state: SocialState | null }) {
  if (!props.state?.identity) {
    return (
      <section class="social-single-pane">
        <EmptyState title="Advanced data unavailable" body="Social identity is not configured." />
      </section>
    );
  }

  return (
    <section class="social-single-pane social-advanced-section">
      <PaneHeader
        eyebrow="Advanced"
        title="Raw social state"
        meta={<span>Debug and recovery data</span>}
      />
      <div class="social-detail-scroll">
        <section class="social-work-section">
          <h3>Current selection</h3>
          <FieldList>
            <FieldRow label="Identity" value={props.state.identity.handle} />
            <FieldRow label="Selected channel" value={compactId(props.state.selectedChannel?.channel?.channelId)} />
            <FieldRow label="Directory contact" value={props.state.contactDirectory?.contactHandle ?? "None"} />
            <FieldRow label="Message workflow items" value={props.state.messageWorkflows.length} />
          </FieldList>
        </section>

        <section class="social-work-section">
          <h3>Channels</h3>
          {props.state.channels.length ? (
            <div class="social-record-table">
              {props.state.channels.map((channel) => (
                <div key={channel.channelId}>
                  <strong>{channel.contactHandle}</strong>
                  <span>{compactId(channel.channelId)}</span>
                  <small>{formatShortDate(channel.updatedAt)}</small>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No channels.</p>}
        </section>

        <section class="social-work-section">
          <h3>Internal message workflow</h3>
          {props.state.messageWorkflows.length ? (
            <div class="social-record-table">
              {props.state.messageWorkflows.map((workflow) => (
                <div key={workflow.messageId}>
                  <strong>{workflow.summary || compactId(workflow.messageId)}</strong>
                  <span>{workflow.direction} - {workflow.fromHandle} to {workflow.toHandle}</span>
                  <small><StatusPill status={workflow.state} /></small>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No internal message workflow items.</p>}
        </section>

        <details class="social-work-section social-raw-details">
          <summary>Full normalized payload</summary>
          <pre>{formatJson(props.state)}</pre>
        </details>
      </div>
    </section>
  );
}
