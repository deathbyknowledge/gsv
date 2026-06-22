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
            text="Scaffold's live. What should we call them — and how should they behave?"
            time="14:22"
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Assistant</div>
        <div style={{ width: 440 }}>
          <SystemMessage
            text="Done. I've named the agent Xanadu and given it a curious, terse temperament. Ready for the next instruction."
            time="14:23"
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
