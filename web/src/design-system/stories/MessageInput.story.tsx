import { MessageInput } from "../../app/components/ui/MessageInput";
import type { Story } from "../story";

const ATTACHMENTS = [
  { id: "a", label: "diagram.png", meta: "184 KB" },
  { id: "b", label: "notes.md", meta: "2 KB" },
];

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
      <div class="ds-cell">
        <div class="ds-label">Attachments (onRemoveAttachment)</div>
        <div style={{ width: 460 }}>
          <MessageInput
            user="operator"
            attachments={ATTACHMENTS}
            onFiles={() => {}}
            onRemoveAttachment={() => {}}
            onSend={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">File attach enabled (onFiles)</div>
        <div style={{ width: 460 }}>
          <MessageInput placeholder="Paste or attach an image..." onFiles={() => {}} onSend={() => {}} user="operator" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Busy (send + controls locked)</div>
        <div style={{ width: 460 }}>
          <MessageInput busy value="thinking..." onFiles={() => {}} onSend={() => {}} onVoiceClick={() => {}} user="operator" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Running (send → stop swap, onStop)</div>
        <div style={{ width: 460 }}>
          <MessageInput running onStop={() => {}} onSend={() => {}} onFiles={() => {}} user="operator" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Voice — idle / active / disabled / available-when-busy</div>
        <div class="ds-col" style={{ width: 460 }}>
          <MessageInput onVoiceClick={() => {}} voiceTitle="Record voice" onSend={() => {}} user="operator" />
          <MessageInput onVoiceClick={() => {}} voiceActive voiceTitle="Stop recording" onSend={() => {}} user="operator" />
          <MessageInput onVoiceClick={() => {}} voiceDisabled voiceTitle="Voice unavailable" onSend={() => {}} user="operator" />
          <MessageInput busy onVoiceClick={() => {}} voiceAvailableWhenBusy voiceTitle="Record while busy" onSend={() => {}} user="operator" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Cost tooltip (hover the $)</div>
        <div style={{ width: 460 }}>
          <MessageInput user="operator" cost="$0.0142 this turn · $0.31 session" onSend={() => {}} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled</div>
        <div style={{ width: 460 }}>
          <MessageInput disabled value="Composer locked" user="operator" onFiles={() => {}} onVoiceClick={() => {}} onSend={() => {}} />
        </div>
      </div>
    </div>
  ),
};

export default story;
