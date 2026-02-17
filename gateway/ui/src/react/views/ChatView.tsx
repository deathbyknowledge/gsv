import DOMPurify from "dompurify";
import { marked } from "marked";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../../ui/types";
import { useReactUiStore } from "../state/store";

const TOOL_RESULT_JSON_COLLAPSE_LINES = 24;
const TOOL_RESULT_JSON_COLLAPSE_CHARS = 1800;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function shouldCollapseJson(jsonText: string): boolean {
  return (
    jsonText.length > TOOL_RESULT_JSON_COLLAPSE_CHARS ||
    countLines(jsonText) > TOOL_RESULT_JSON_COLLAPSE_LINES
  );
}

function formatJsonIfPossible(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== "\"") {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function getImageSource(block: ImageBlock): string | null {
  if (block.data) {
    return `data:${block.mimeType || "image/png"};base64,${block.data}`;
  }
  if (block.url) {
    return block.url;
  }
  if (block.r2Key) {
    const fileName = block.r2Key.split("/").pop();
    if (fileName) {
      return `/media/${fileName}`;
    }
  }
  return null;
}

function MarkdownContent({ text }: { text: string }) {
  const safeHtml = useMemo(() => {
    const rendered = marked.parse(text, {
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(rendered);
  }, [text]);

  return (
    <div
      className="message-content"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

function ThinkingContent({ block }: { block: ThinkingBlock }) {
  return (
    <details className="thinking-block">
      <summary>Thinking</summary>
      <pre>{block.text}</pre>
    </details>
  );
}

function ImageContent({ block }: { block: ImageBlock }) {
  const src = getImageSource(block);
  if (!src) {
    return (
      <div className="message-content">
        <p className="muted">[image unavailable]</p>
      </div>
    );
  }

  return (
    <div className="message-image-wrap">
      <img className="message-image" src={src} alt="message image" loading="lazy" />
    </div>
  );
}

function renderContentBlock(block: ContentBlock, key: string) {
  if (block.type === "text") {
    return <MarkdownContent key={key} text={block.text} />;
  }
  if (block.type === "image") {
    return <ImageContent key={key} block={block} />;
  }
  if (block.type === "thinking") {
    return <ThinkingContent key={key} block={block} />;
  }
  return null;
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallBlock }) {
  return (
    <div className="tool-call">
      <div className="tool-call-header">
        <span className="tool-call-name">
          <span>🔧</span>
          <span>{toolCall.name}</span>
        </span>
        <span className="tool-call-status">
          <span className="pill pill-success">called</span>
        </span>
      </div>
      <div className="tool-call-body">
        <pre>
          <code>{JSON.stringify(toolCall.arguments, null, 2)}</code>
        </pre>
      </div>
    </div>
  );
}

function ToolResultContent({
  block,
  blockKey,
}: {
  block: ContentBlock;
  blockKey: string;
}) {
  if (block.type !== "text") {
    return renderContentBlock(block, blockKey);
  }

  const jsonText = formatJsonIfPossible(block.text);
  if (jsonText) {
    if (shouldCollapseJson(jsonText)) {
      const lineCount = countLines(jsonText);
      return (
        <details className="tool-result-json-details">
          <summary>
            <span className="tool-result-json-toggle-closed">
              Show JSON result ({lineCount} lines)
            </span>
            <span className="tool-result-json-toggle-open">Hide JSON result</span>
          </summary>
          <pre className="tool-result-json">
            <code>{jsonText}</code>
          </pre>
        </details>
      );
    }

    return (
      <pre className="tool-result-json">
        <code>{jsonText}</code>
      </pre>
    );
  }

  return <MarkdownContent text={block.text} />;
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "toolResult") {
    const toolMessage = message as ToolResultMessage;
    return (
      <div className="message assistant">
        <div
          className={`message-bubble tool-result-bubble ${
            toolMessage.isError ? "tool-result-error" : ""
          }`}
        >
          <div className="tool-result-header">
            <span className="tool-call-name">
              <span>🔧</span>
              <span>{toolMessage.toolName}</span>
            </span>
            <span className={`pill ${toolMessage.isError ? "pill-danger" : "pill-success"}`}>
              {toolMessage.isError ? "error" : "result"}
            </span>
          </div>
          <div className="tool-result-body">
            {toolMessage.content.map((block, index) => (
              <ToolResultContent
                key={`tool-result-${index}`}
                block={block}
                blockKey={`tool-result-block-${index}`}
              />
            ))}
          </div>
        </div>
        {toolMessage.timestamp ? (
          <div className="message-meta">
            <span>{formatTime(toolMessage.timestamp)}</span>
          </div>
        ) : null}
      </div>
    );
  }

  const isUser = message.role === "user";
  const blocks =
    typeof message.content === "string"
      ? ([{ type: "text", text: message.content }] as ContentBlock[])
      : message.content;
  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
  const visibleBlocks = blocks.filter((b) => b.type !== "toolCall");

  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="message-bubble">
        {visibleBlocks.map((block, index) => renderContentBlock(block, `content-${index}`))}
        {toolCalls.length > 0
          ? toolCalls.map((toolCall) => (
              <ToolCallCard key={`${toolCall.id}-${toolCall.name}`} toolCall={toolCall} />
            ))
          : null}
      </div>
      {message.timestamp ? (
        <div className="message-meta">
          <span>{formatTime(message.timestamp)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ChatView() {
  const settings = useReactUiStore((s) => s.settings);
  const chatMessages = useReactUiStore((s) => s.chatMessages);
  const chatLoading = useReactUiStore((s) => s.chatLoading);
  const chatSending = useReactUiStore((s) => s.chatSending);
  const chatStream = useReactUiStore((s) => s.chatStream);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const sendMessage = useReactUiStore((s) => s.sendMessage);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!messagesRef.current) {
      return;
    }
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [chatMessages, chatStream, chatLoading, chatSending]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text) {
      return;
    }
    void sendMessage(text);
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  return (
    <div className="chat-container">
      <div className="session-bar">
        <span className="session-key">{settings.sessionKey}</span>
        <div className="session-stats">
          <span>{chatMessages.length} messages</span>
        </div>
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {chatLoading ? (
          <div className="thinking-indicator">
            <div className="thinking-dots">
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
            </div>
            <span>Loading messages...</span>
          </div>
        ) : chatMessages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <h3 className="chat-empty-title">Start a conversation</h3>
            <p className="chat-empty-description">
              Send a message to begin chatting with your GSV agent.
            </p>
          </div>
        ) : (
          <>
            {chatMessages.map((message, index) => (
              <MessageBubble
                key={`msg-${index}-${message.role}-${message.timestamp || index}`}
                message={message}
              />
            ))}
            {chatStream ? <MessageBubble message={chatStream} /> : null}
            {chatSending && !chatStream ? (
              <div className="message assistant">
                <div className="thinking-indicator">
                  <div className="thinking-dots">
                    <span className="thinking-dot"></span>
                    <span className="thinking-dot"></span>
                    <span className="thinking-dot"></span>
                  </div>
                  <span>Thinking...</span>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <form className="chat-input-area" onSubmit={submit}>
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Type a message..."
            rows={1}
            value={input}
            disabled={chatSending || connectionState !== "connected"}
            onChange={(event) => {
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onInput={(event) => {
              const textarea = event.currentTarget;
              textarea.style.height = "auto";
              textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
            }}
          ></textarea>
          <Button
            type="submit"
            variant="primary"
            shape="circle"
            size="base"
            className="chat-send-btn"
            disabled={chatSending || connectionState !== "connected"}
            loading={chatSending}
            aria-label="Send message"
          >
            →
          </Button>
        </div>
      </form>
    </div>
  );
}
