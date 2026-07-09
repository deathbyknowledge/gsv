import { Icon } from "../../../components/ui/Icon";
import { Hint } from "../../../components/ui/Tooltip";
import type { ChatConversation } from "../domain/processes";
import { shortId } from "./chatUiFormat";

type ChatConversationBarProps = {
  activeConversationId: string;
  conversations: readonly ChatConversation[];
  onSelect: (conversationId: string) => void;
};

export function ChatConversationBar({
  activeConversationId,
  conversations,
  onSelect,
}: ChatConversationBarProps) {
  if (conversations.length === 0) {
    return null;
  }
  const visible = conversations.slice(0, 4);
  const overflow = conversations.slice(4);
  // A single conversation means only the default thread exists (no branches yet);
  // surface a hint tooltip inviting the user to branch. Once branches exist the
  // pills act as a branch selector.
  const hasBranches = conversations.length > 1;
  const branchTip = hasBranches
    ? "Select conversation branch"
    : "Conversation branches will show up here";

  const selectOverflow = (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const conversationId = select.value;
    select.value = "";
    if (conversationId) {
      onSelect(conversationId);
    }
  };

  return (
    <div class="gsv-chat-conversations" aria-label="Conversations">
      {visible.map((conversation) => (
        <Hint key={conversation.id} position="bottom-start" text={branchTip}>
          <button
            type="button"
            class={conversation.id === activeConversationId ? "is-active" : ""}
            onClick={() => onSelect(conversation.id)}
          >
            <Icon name="arrowRight" family="doticons" size={11} />
            <span>{conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}</span>
            {conversation.messageCount > 0 ? <small>{conversation.messageCount}</small> : null}
          </button>
        </Hint>
      ))}
      {overflow.length > 0 ? (
        <Hint position="bottom-start" text="Select conversation branch">
        <label>
          <Icon name="circleDots" family="doticons" size={12} />
          <select value="" aria-label="More conversations" onChange={selectOverflow}>
            <option value="">+{overflow.length}</option>
            {overflow.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title || shortId(conversation.id)}
              </option>
            ))}
          </select>
        </label>
        </Hint>
      ) : null}
    </div>
  );
}
