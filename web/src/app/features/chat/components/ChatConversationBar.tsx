import { Icon } from "../../../components/ui/Icon";
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
  if (conversations.length <= 1) {
    return null;
  }
  const visible = conversations.slice(0, 4);
  const overflow = conversations.slice(4);

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
        <button
          key={conversation.id}
          type="button"
          class={conversation.id === activeConversationId ? "is-active" : ""}
          title={conversation.title || conversation.id}
          onClick={() => onSelect(conversation.id)}
        >
          <Icon name="arrowRight" family="doticons" size={11} />
          <span>{conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}</span>
          {conversation.messageCount > 0 ? <small>{conversation.messageCount}</small> : null}
        </button>
      ))}
      {overflow.length > 0 ? (
        <label title="More conversations">
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
      ) : null}
    </div>
  );
}
