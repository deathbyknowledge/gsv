import { Hint } from "../../app/components/ui/Tooltip";
import { MessageMeta } from "../../app/components/ui/MessageMeta";
import type { Story } from "../story";

function BranchAction() {
  return (
    <Hint text="Branch a new conversation from this message">
      <button type="button" class="gsv-mm-btn" aria-label="Branch a new conversation from this message">
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
}

const story: Story = {
  title: "MessageMeta",
  group: "Chrome",
  blurb: "shared message meta row · hover-revealed time + icons · mirrors to the message's aligned edge",
  render: () => (
    <div class="ds-col" style={{ maxWidth: "360px" }}>
      <div class="ds-cell">
        <div class="ds-label">Copy only (hover the row for timestamp + icons)</div>
        <MessageMeta time="14:24" onCopy={() => {}} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">With branch action (user-message variant)</div>
        <MessageMeta time="14:25" actions={<BranchAction />} onCopy={() => {}} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Mirrored (assistant/system variant: icons + time cluster left)</div>
        <MessageMeta mirror time="14:25" actions={<BranchAction />} onCopy={() => {}} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Copy failed</div>
        <MessageMeta time="14:26" copyLabel="Copy failed" copyFailed onCopy={() => {}} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">No copy handler (actions only)</div>
        <MessageMeta time="14:27" actions={<BranchAction />} />
      </div>
    </div>
  ),
};

export default story;
