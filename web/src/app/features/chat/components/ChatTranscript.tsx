import { SystemMessage } from "../../../components/ui/SystemMessage";

export type ChatDockMessageRole = "assistant" | "system" | "tool" | "user";

export type ChatDockMessage = {
  id: string;
  text: string;
  time: string;
  role?: ChatDockMessageRole;
};

type ChatTranscriptProps = {
  messages: readonly ChatDockMessage[];
};

function copyText(text: string): void {
  if (!navigator.clipboard) {
    return;
  }
  void navigator.clipboard.writeText(text);
}

function UserMessage({ text, time }: Pick<ChatDockMessage, "text" | "time">) {
  return (
    <div class="gsv-chat-user-message">
      <div class="gsv-chat-user-message-inner">
        <div class="gsv-chat-user-message-text">{text}</div>
        <div class="gsv-chat-user-message-meta">
          {time ? <span>{time}</span> : null}
          <button type="button" onClick={() => copyText(text)}>
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
              <g fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="6" y="6" width="7" height="7" />
              </g>
            </svg>
            COPY
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatTranscript({ messages }: ChatTranscriptProps) {
  return (
    <div class="gsv-chat-transcript">
      {messages.length === 0 ? (
        <div class="gsv-chat-empty">
          <strong>No active conversation</strong>
          <span>Process history will appear here when a conversation is available.</span>
        </div>
      ) : messages.map((message) => (
        message.role === "user" ? (
          <UserMessage key={message.id} text={message.text} time={message.time} />
        ) : (
          <SystemMessage
            key={message.id}
            text={message.text}
            time={message.time}
            onCopy={() => copyText(message.text)}
          />
        )
      ))}
    </div>
  );
}
