import { SystemMessage } from "../../app/components/ui/SystemMessage";
import type { Story } from "../story";

const story: Story = {
  title: "SystemMessage",
  group: "Chrome",
  blurb: "message body · icon-only actions with tooltip labels · hover timestamp",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default (hover to reveal the timestamp)</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Process is ready. Send an instruction to start the next run."
            time="14:22"
            onCopy={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Copy states (label lives in the tooltip)</div>
        <div class="ds-col" style={{ width: 440 }}>
          <SystemMessage
            text="Hover the copy icon — its label shows as a tooltip."
            time="14:24"
            copyAriaLabel="Copy message"
            onCopy={() => {}}
          />
          <SystemMessage
            text="Copy just failed — the icon flashes its failed state."
            time="14:25"
            copyLabel="Copy failed"
            copyFailed
            onCopy={() => {}}
          />
          <SystemMessage
            text="Copy is unavailable for this message."
            time="14:26"
            copyDisabled
            copyTitle="Nothing to copy"
            onCopy={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom meta node (actions sit before the timestamp)</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Meta slot can carry extra actions or tags ahead of the copy icon."
            time="14:27"
            meta={<span>412 TOK</span>}
            onCopy={() => {}}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
