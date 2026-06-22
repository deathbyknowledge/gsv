import { MessageInput } from "../../app/components/ui/MessageInput";
import type { Story } from "../story";

const story: Story = {
  title: "MessageInput",
  group: "Chrome",
  blurb: "chat input bar · attachment / text / voice / send controls",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">User</div>
        <div style={{ width: 460 }}>
          <MessageInput placeholder="Message active process..." user="operator" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Command</div>
        <div style={{ width: 460 }}>
          <MessageInput placeholder="/spawn agent..." user="root@gsv" />
        </div>
      </div>
    </div>
  ),
};

export default story;
