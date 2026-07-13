import { SystemMessage } from "../../app/components/ui/SystemMessage";
import type { Story } from "../story";

const story: Story = {
  title: "SystemMessage",
  group: "Chrome",
  blurb: "message bubble · avatar + text + time / copy",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">System</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Process is ready. Send an instruction to start the next run."
            time="14:22"
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Assistant</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Done. The process history has been updated and is ready for the next instruction."
            time="14:23"
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Copy affordance (onCopy)</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Hover the meta row to reveal the copy button."
            time="14:24"
            copyAriaLabel="Copy message"
            onCopy={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Copy failed / disabled</div>
        <div class="ds-col" style={{ width: 440 }}>
          <SystemMessage
            text="Copy just failed — the button flashes its failed state."
            time="14:25"
            copyLabel="FAILED"
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
        <div class="ds-label">Custom meta node</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Meta slot can carry a model tag or token count next to the time."
            time="14:27"
            meta={<span>· GATEWAY DEFAULT · 412 TOK</span>}
            onCopy={() => {}}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
