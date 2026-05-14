import type { ConversationRecord, ThreadContext } from "../../types";
import { ArchiveIcon, BranchIcon, RefreshIcon } from "../../icons";
import { shortId } from "../../view-helpers";

export function ConversationBar(props: {
  active: ThreadContext | null;
  activeConversationId: string;
  conversations: ConversationRecord[];
  loading: boolean;
  error: string;
  archiveCount: number;
  archiveActive: boolean;
  onSelect(conversation: ConversationRecord): void;
  onRefresh(): void;
  onArchiveToggle(): void;
}) {
  if (!props.active) {
    return null;
  }
  const activeConversation = props.conversations.find((conversation) => conversation.id === props.activeConversationId) ?? null;
  const activeDisplay: ConversationRecord = activeConversation ?? {
    id: props.activeConversationId,
    generation: 0,
    status: "open",
    title: props.active.conversationTitle || (props.activeConversationId === "default" ? "Default" : null),
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const visible: ConversationRecord[] = [];
  const seen = new Set<string>();
  function pushVisible(conversation: ConversationRecord | null | undefined): void {
    if (!conversation || seen.has(conversation.id) || visible.length >= 4) {
      return;
    }
    visible.push(conversation);
    seen.add(conversation.id);
  }
  pushVisible(props.conversations.find((conversation) => conversation.id === "default"));
  pushVisible(activeDisplay);
  for (const conversation of props.conversations) {
    pushVisible(conversation);
  }
  const overflow = props.conversations.filter((conversation) => !seen.has(conversation.id));
  const selectOverflow = (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const conversation = props.conversations.find((candidate) => candidate.id === select.value);
    select.value = "";
    if (conversation) {
      props.onSelect(conversation);
    }
  };

  return (
    <div class="conversation-bar">
      <div class="conversation-bar-list" aria-label="Conversations">
        {visible.map((conversation) => (
          <span
            key={conversation.id}
            class={"conversation-chip-group" + (conversation.id === props.activeConversationId ? " is-active" : "")}
          >
            <button
              type="button"
              class={"conversation-chip" + (conversation.id === props.activeConversationId ? " is-active" : "")}
              title={conversation.title || conversation.id}
              onClick={() => props.onSelect(conversation)}
            >
              <BranchIcon />
              <span>{conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}</span>
              {conversation.messageCount > 0 ? <small>{conversation.messageCount}</small> : null}
            </button>
            {conversation.id === props.activeConversationId ? (
              <button
                class={"archive-toggle" + (props.archiveActive ? " is-active" : "")}
                type="button"
                title={props.archiveActive ? "Return to live conversation" : "Open conversation archive"}
                aria-label={props.archiveActive ? "Return to live conversation" : "Open conversation archive"}
                onClick={props.onArchiveToggle}
              >
                <ArchiveIcon />
                {props.archiveCount > 0 ? <span>{props.archiveCount}</span> : null}
              </button>
            ) : null}
          </span>
        ))}
        {overflow.length > 0 ? (
          <label class="conversation-overflow" title="More branches">
            <BranchIcon />
            <select value="" aria-label="More branches" onChange={selectOverflow}>
              <option value="">+{overflow.length}</option>
              {overflow.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {props.conversations.length === 0 && visible.length === 0 ? (
          <span class="conversation-bar-empty">{props.loading ? "Loading branches..." : props.error || "No branches"}</span>
        ) : null}
      </div>
      <div class="conversation-bar-actions">
        <button class="icon-button small" type="button" title="Refresh branches" aria-label="Refresh branches" onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}
