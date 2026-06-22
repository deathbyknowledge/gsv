import { MessageInput } from "../../app/components/ui/MessageInput";
import type { Story } from "../story";

const story: Story = {
  title: "MessageInput",
  group: "Chrome",
  blurb: "chat input bar · attachment / text / voice / send + cost meta",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">User</div>
        <div style={{ width: 460 }}>
          <MessageInput placeholder="Message Xanadu…" user="jessicat" cost="0.04$" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Command</div>
        <div style={{ width: 460 }}>
          <MessageInput placeholder="/spawn agent…" user="root@gsv" cost="1.27$" />
        </div>
      </div>
    </div>
  ),
};

export default story;
