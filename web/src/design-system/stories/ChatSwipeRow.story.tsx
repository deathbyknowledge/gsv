import type { ComponentChildren } from "preact";
import { CopyIconButton, MessageMeta } from "../../app/components/ui/MessageMeta";
import { ReasoningGlyph } from "../../app/components/ui/ReasoningGlyph";
import { SystemMessage } from "../../app/components/ui/SystemMessage";
import { Hint } from "../../app/components/ui/Tooltip";
import { ActionRail, SwipeRow, TranscriptMobileContext } from "../../app/features/chat/components/SwipeRow";
import type { Story } from "../story";

/** Mobile swipe-to-reveal message actions: each row is a horizontal
 *  scroll-snap scroller — drag the message left (or shift-scroll / focus a
 *  rail button) to reveal the stacked action rail. Timestamps stay inline;
 *  desktop keeps the hover-revealed meta icons instead. */

const noop = () => {};

function Frame({ children }: { children: ComponentChildren }) {
  return (
    <TranscriptMobileContext.Provider value={true}>
      <div style={{ width: "360px", background: "#070612", border: "1px solid var(--border)", padding: "14px", overflow: "hidden" }}>
        {children}
      </div>
    </TranscriptMobileContext.Provider>
  );
}

const branchButton = (
  <Hint text="Branch a new conversation from this message">
    <button type="button" class="gsv-mm-btn" aria-label="Branch a new conversation from this message" onClick={noop}>
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="4.5" cy="4" r="2" />
          <circle cx="4.5" cy="12" r="2" />
          <circle cx="11.5" cy="8" r="2" />
          <path d="M4.5 6 L4.5 10 M6.5 12 C10 12 11.5 10.5 11.5 10" />
        </g>
      </svg>
    </button>
  </Hint>
);

const reasoningButton = (
  <Hint position="top" text="Expand reasoning">
    <button type="button" class="gsv-chat-reasoning-icon" aria-label="Expand reasoning" onClick={noop}>
      <ReasoningGlyph size={13} />
    </button>
  </Hint>
);

const story: Story = {
  title: "Chat swipe actions (mobile)",
  group: "Chrome",
  blurb: "swipe a message left to reveal its rail · user [branch copy] · assistant [reasoning copy] · system [copy] · 44px targets",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">User row — rail: branch + copy (drag left)</div>
        <Frame>
          <div class="gsv-chat-user-message">
            <SwipeRow
              align="end"
              rail={(
                <ActionRail>
                  {branchButton}
                  <CopyIconButton copyLabel="Copy message" onCopy={noop} />
                </ActionRail>
              )}
            >
              <div class="gsv-chat-user-message-inner">
                <div class="gsv-chat-user-message-text gsv-prose">Can you check the deploy logs from last night?</div>
                <MessageMeta time="09:42 AM" />
              </div>
            </SwipeRow>
          </div>
        </Frame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Assistant row — rail: reasoning + copy</div>
        <Frame>
          <SwipeRow
            rail={(
              <ActionRail>
                {reasoningButton}
                <CopyIconButton copyLabel="Copy message" onCopy={noop} />
              </ActionRail>
            )}
          >
            <SystemMessage
              text="The deploy at 02:14 completed cleanly; one warning about a deprecated flag."
              time="09:43 AM"
            />
          </SwipeRow>
        </Frame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">System row — rail: copy only (body tap still expands)</div>
        <Frame>
          <SwipeRow
            rail={(
              <ActionRail>
                <CopyIconButton copyLabel="Copy message" onCopy={noop} />
              </ActionRail>
            )}
          >
            <article class="gsv-chat-system-surface">
              <div class="gsv-chat-system-label gsv-message-label">SYSTEM</div>
              <div class="gsv-chat-system-line">
                <small class="gsv-prose">Context compressed — 42 older messages archived.</small>
              </div>
              <MessageMeta mirror time="09:44 AM" />
            </article>
          </SwipeRow>
        </Frame>
      </div>
    </div>
  ),
};

export default story;
