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
    </div>
  ),
};

export default story;
