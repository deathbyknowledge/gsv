import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

export type ChatDockMessageRole = "assistant" | "system" | "tool" | "toolResult" | "user";

export type ChatDockMessage = {
  id: string;
  text: string;
  time: string;
  role?: ChatDockMessageRole;
  meta?: string;
};

type ChatTranscriptProps = {
  messages: readonly ChatDockMessage[];
  state?: "empty" | "error" | "loading" | "ready";
  emptyTitle?: string;
  emptyDescription?: string;
  errorMessage?: string;
  action?: ComponentChildren;
};

function copyWithFallback(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyWithFallback(text);
    }
  }

  return copyWithFallback(text);
}

function roleLabel(role: ChatDockMessageRole | undefined): string {
  if (role === "tool" || role === "toolResult") {
    return "TOOL RESULT";
  }
  return (role ?? "assistant").toUpperCase();
}

function roleClass(role: ChatDockMessageRole | undefined): string {
  return role === "toolResult" ? "tool" : role ?? "assistant";
}

function CopyButton({
  copied,
  text,
  onCopy,
}: {
  copied: boolean;
  text: string;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      class="gsv-chat-copy"
      disabled={!text.trim()}
      onClick={onCopy}
      aria-label={copied ? "Copied message" : "Copy message"}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="6" y="6" width="7" height="7" />
        </g>
      </svg>
      {copied ? "COPIED" : "COPY"}
    </button>
  );
}

function UserMessage({
  copied,
  message,
  onCopy,
}: {
  copied: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  return (
    <div class="gsv-chat-user-message">
      <div class="gsv-chat-user-message-inner">
        <div class="gsv-chat-user-message-text">{message.text}</div>
        <div class="gsv-chat-user-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          <CopyButton copied={copied} text={message.text} onCopy={onCopy} />
        </div>
      </div>
    </div>
  );
}

function ProcessMessage({
  copied,
  message,
  onCopy,
}: {
  copied: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  const role = roleClass(message.role);
  const label = roleLabel(message.role);

  return (
    <article class={`gsv-chat-message gsv-chat-message-${role}`}>
      <div class="gsv-chat-message-glyph" aria-hidden="true">
        {role === "system" ? "!" : role === "tool" ? "$" : ">"}
      </div>
      <div class="gsv-chat-message-body">
        <div class="gsv-chat-message-head">
          <span>{label}</span>
          {message.meta ? <small>{message.meta}</small> : null}
        </div>
        <div class="gsv-chat-message-text">{message.text}</div>
        <div class="gsv-chat-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          <CopyButton copied={copied} text={message.text} onCopy={onCopy} />
        </div>
      </div>
    </article>
  );
}

function TranscriptState({
  action,
  description,
  title,
  tone,
}: {
  action?: ComponentChildren;
  description: string;
  title: string;
  tone: "empty" | "error" | "loading";
}) {
  return (
    <div class={`gsv-chat-empty gsv-chat-empty-${tone}`}>
      <strong>{title}</strong>
      <span>{description}</span>
      {action ? <div class="gsv-chat-empty-action">{action}</div> : null}
    </div>
  );
}

export function ChatTranscript({
  action,
  emptyDescription = "Process history will appear here when a conversation is available.",
  emptyTitle = "No active conversation",
  errorMessage = "Process history could not be loaded.",
  messages,
  state = "ready",
}: ChatTranscriptProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const copyMessage = (message: ChatDockMessage) => {
    void copyText(message.text).then((copied) => {
      if (!copied) {
        return;
      }
      setCopiedMessageId(message.id);
      globalThis.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
      }, 1600);
    });
  };

  return (
    <div class="gsv-chat-transcript" aria-live="polite">
      {state === "loading" ? (
        <TranscriptState
          title="Loading process history"
          description="Fetching the latest transcript for this process."
          tone="loading"
        />
      ) : state === "error" ? (
        <TranscriptState
          title="History unavailable"
          description={errorMessage}
          tone="error"
        />
      ) : messages.length === 0 ? (
        <TranscriptState
          action={action}
          title={emptyTitle}
          description={emptyDescription}
          tone="empty"
        />
      ) : messages.map((message) => (
        message.role === "user" ? (
          <UserMessage
            key={message.id}
            copied={copiedMessageId === message.id}
            message={message}
            onCopy={() => copyMessage(message)}
          />
        ) : (
          <ProcessMessage
            key={message.id}
            copied={copiedMessageId === message.id}
            message={message}
            onCopy={() => copyMessage(message)}
          />
        )
      ))}
    </div>
  );
}
