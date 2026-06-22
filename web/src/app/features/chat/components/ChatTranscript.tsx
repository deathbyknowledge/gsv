import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

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

type CopyState = {
  id: string;
  status: "copied" | "failed";
};

function copyWithFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body) {
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

function normalizedRole(role: ChatDockMessageRole | undefined): ChatDockMessageRole {
  if (
    role === "assistant"
    || role === "system"
    || role === "tool"
    || role === "toolResult"
    || role === "user"
  ) {
    return role;
  }
  return "assistant";
}

function roleLabel(role: ChatDockMessageRole): string {
  switch (role) {
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    case "tool":
      return "TOOL";
    case "toolResult":
      return "TOOL RESULT";
    case "user":
      return "USER";
  }
}

function roleClass(role: ChatDockMessageRole): string {
  return role === "toolResult" ? "tool-result" : role;
}

function AssistantGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="7" y="1" width="2" height="2" />
        <rect x="6" y="3" width="4" height="6" />
        <rect x="4" y="6" width="2" height="3" />
        <rect x="10" y="6" width="2" height="3" />
        <rect x="7" y="11" width="2" height="3" class="gsv-chat-message-glyph-accent" />
      </g>
    </svg>
  );
}

function roleGlyph(role: ChatDockMessageRole): ComponentChildren {
  switch (role) {
    case "assistant":
      return <AssistantGlyph />;
    case "system":
      return "!";
    case "tool":
      return "$";
    case "toolResult":
      return "=";
    case "user":
      return ">";
  }
}

function copyButtonLabel(copied: boolean, failed: boolean): string {
  if (copied) {
    return "COPIED";
  }
  if (failed) {
    return "FAILED";
  }
  return "COPY";
}

function CopyButton({
  copied,
  failed,
  role,
  text,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  role: ChatDockMessageRole;
  text: string;
  onCopy: () => void;
}) {
  const label = copyButtonLabel(copied, failed);

  return (
    <button
      type="button"
      class={`gsv-chat-copy${failed ? " is-failed" : ""}`}
      disabled={!text.trim()}
      onClick={onCopy}
      aria-label={copied ? `Copied ${roleLabel(role).toLowerCase()} message` : `Copy ${roleLabel(role).toLowerCase()} message`}
      title={copied ? "Copied" : "Copy message"}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="6" y="6" width="7" height="7" />
        </g>
      </svg>
      {label}
    </button>
  );
}

function UserMessage({
  copied,
  failed,
  message,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  return (
    <div class="gsv-chat-user-message">
      <div class="gsv-chat-user-message-inner">
        <div class="gsv-chat-user-message-text">{message.text}</div>
        <div class="gsv-chat-user-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          <CopyButton
            copied={copied}
            failed={failed}
            role="user"
            text={message.text}
            onCopy={onCopy}
          />
        </div>
      </div>
    </div>
  );
}

function ProcessMessage({
  copied,
  failed,
  message,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  const messageRole = normalizedRole(message.role);
  const role = roleClass(messageRole);
  const label = roleLabel(messageRole);
  const showHead = messageRole !== "assistant" || Boolean(message.meta);

  return (
    <article class={`gsv-chat-message gsv-chat-message-${role}`}>
      <div class="gsv-chat-message-glyph" aria-hidden="true">
        {roleGlyph(messageRole)}
      </div>
      <div class="gsv-chat-message-body">
        {showHead ? (
          <div class="gsv-chat-message-head">
            <span>{label}</span>
            {message.meta ? <small>{message.meta}</small> : null}
          </div>
        ) : null}
        <div class="gsv-chat-message-text">{message.text}</div>
        <div class="gsv-chat-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          <CopyButton
            copied={copied}
            failed={failed}
            role={messageRole}
            text={message.text}
            onCopy={onCopy}
          />
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
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      globalThis.clearTimeout(copyResetTimer.current);
    }
  }, []);

  const resetCopyState = (messageId: string) => {
    if (copyResetTimer.current !== null) {
      globalThis.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = globalThis.setTimeout(() => {
      setCopyState((current) => current?.id === messageId ? null : current);
      copyResetTimer.current = null;
    }, 1600);
  };

  const copyMessage = (message: ChatDockMessage, messageId: string) => {
    void copyText(message.text).then((copied) => {
      setCopyState({ id: messageId, status: copied ? "copied" : "failed" });
      resetCopyState(messageId);
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
      ) : messages.map((message, index) => {
        const messageRole = normalizedRole(message.role);
        const messageId = `${messageRole}:${message.id}:${index}`;
        const copied = copyState?.id === messageId && copyState.status === "copied";
        const failed = copyState?.id === messageId && copyState.status === "failed";

        return messageRole === "user" ? (
          <UserMessage
            key={messageId}
            copied={copied}
            failed={failed}
            message={message}
            onCopy={() => copyMessage(message, messageId)}
          />
        ) : (
          <ProcessMessage
            key={messageId}
            copied={copied}
            failed={failed}
            message={message}
            onCopy={() => copyMessage(message, messageId)}
          />
        );
      })}
    </div>
  );
}
