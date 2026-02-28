import DOMPurify from "dompurify";
import { marked } from "marked";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  if (!text) return 0;
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
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== "\"") return null;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function getImageSource(block: ImageBlock): string | null {
  if (block.data) return `data:${block.mimeType || "image/png"};base64,${block.data}`;
  if (block.url) return block.url;
  if (block.r2Key) {
    const fileName = block.r2Key.split("/").pop();
    if (fileName) return `/media/${fileName}`;
  }
  return null;
}

function MarkdownContent({ text }: { text: string }) {
  const safeHtml = useMemo(() => {
    const rendered = marked.parse(text, { gfm: true, breaks: true }) as string;
    return DOMPurify.sanitize(rendered);
  }, [text]);

  return (
    <div
      className="chat-md"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

function ThinkingContent({ block }: { block: ThinkingBlock }) {
  const text = block.text || (block as ThinkingBlock & { thinking?: string }).thinking || "";
  return (
    <details className="chat-thinking">
      <summary>Thinking</summary>
      <pre>{text}</pre>
    </details>
  );
}

function ImageContent({ block }: { block: ImageBlock }) {
  const src = getImageSource(block);
  if (!src) {
    return <p className="muted">[image unavailable]</p>;
  }
  return (
    <div className="chat-img-wrap">
      <img className="chat-img" src={src} alt="message image" loading="lazy" />
    </div>
  );
}

function renderContentBlock(block: ContentBlock, key: string) {
  if (block.type === "text") return <MarkdownContent key={key} text={block.text} />;
  if (block.type === "image") return <ImageContent key={key} block={block} />;
  if (block.type === "thinking") return <ThinkingContent key={key} block={block} />;
  return null;
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-tool">
      <button type="button" className="chat-tool-header" onClick={() => setOpen(!open)}>
        <span className="chat-tool-name">{toolCall.name}</span>
        <span className="chat-tool-badge">called</span>
        <svg className={`chat-tool-chevron ${open ? "open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open ? (
        <pre className="chat-tool-body">
          <code>{JSON.stringify(toolCall.arguments, null, 2)}</code>
        </pre>
      ) : null}
    </div>
  );
}

function ToolResultContent({ block, blockKey }: { block: ContentBlock; blockKey: string }) {
  if (block.type !== "text") return renderContentBlock(block, blockKey);

  const jsonText = formatJsonIfPossible(block.text);
  if (jsonText) {
    if (shouldCollapseJson(jsonText)) {
      const lineCount = countLines(jsonText);
      return (
        <details className="chat-tool-json-details">
          <summary>
            <span className="chat-tool-json-toggle-closed">Show result ({lineCount} lines)</span>
            <span className="chat-tool-json-toggle-open">Hide result</span>
          </summary>
          <pre className="chat-tool-json"><code>{jsonText}</code></pre>
        </details>
      );
    }
    return <pre className="chat-tool-json"><code>{jsonText}</code></pre>;
  }

  return <MarkdownContent text={block.text} />;
}

function ToolResultBubble({ message }: { message: ToolResultMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-msg chat-msg-assistant">
      <span className="chat-msg-label">tool</span>
      <div className="chat-tool chat-tool-result">
        <button type="button" className="chat-tool-header" onClick={() => setOpen(!open)}>
          <span className="chat-tool-name">{message.toolName}</span>
          <span className={`chat-tool-badge ${message.isError ? "error" : ""}`}>
            {message.isError ? "error" : "result"}
          </span>
          <svg className={`chat-tool-chevron ${open ? "open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        {open ? (
          <div className="chat-tool-result-body">
            {message.content.map((block, index) => (
              <ToolResultContent
                key={`tool-result-${index}`}
                block={block}
                blockKey={`tool-result-block-${index}`}
              />
            ))}
          </div>
        ) : null}
      </div>
      {message.timestamp ? (
        <span className="chat-meta">{formatTime(message.timestamp)}</span>
      ) : null}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "toolResult") {
    return <ToolResultBubble message={message as ToolResultMessage} />;
  }

  const isUser = message.role === "user";
  const blocks =
    typeof message.content === "string"
      ? ([{ type: "text", text: message.content }] as ContentBlock[])
      : message.content;
  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
  const visibleBlocks = blocks.filter((b) => b.type !== "toolCall");

  return (
    <div className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"}`}>
      <span className="chat-msg-label">{isUser ? "you" : "assistant"}</span>
      {visibleBlocks.length > 0 ? (
        <div className={`chat-bubble ${isUser ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
          {visibleBlocks.map((block, index) => renderContentBlock(block, `content-${index}`))}
        </div>
      ) : null}
      {toolCalls.map((toolCall) => (
        <ToolCallCard key={`${toolCall.id}-${toolCall.name}`} toolCall={toolCall} />
      ))}
      {message.timestamp ? (
        <span className="chat-meta">{formatTime(message.timestamp)}</span>
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

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [chatMessages, chatStream, chatLoading, chatSending]);

  const sessionLabel = settings.sessionKey.split(":").slice(-1)[0] || settings.sessionKey;
  const connectionLabel =
    connectionState === "connected"
      ? "online"
      : connectionState === "connecting"
        ? "linking"
        : "offline";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    void sendMessage(text);
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  const disabled = chatSending || connectionState !== "connected";

  return (
    <div className="chat-shell">
      <header className="chat-topbar">
        <div className="chat-topbar-main">
          <span className="chat-topbar-title">Conversation</span>
          <span className="chat-topbar-session mono">{sessionLabel}</span>
        </div>
        <div className="chat-topbar-meta">
          <span className="chat-session-count">{chatMessages.length} msgs</span>
          <span className={`chat-conn ${connectionState}`}>{connectionLabel}</span>
        </div>
      </header>

      <div className="chat-scroll" ref={messagesRef}>
        {chatLoading ? (
          <div className="chat-status">
            <div className="chat-dots"><span /><span /><span /></div>
            <span>Loading...</span>
          </div>
        ) : chatMessages.length === 0 ? (
          <div className="chat-empty">
            <p>Send a message to start.</p>
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
              <div className="chat-msg chat-msg-assistant">
                <div className="chat-status">
                  <div className="chat-dots"><span /><span /><span /></div>
                  <span>Thinking...</span>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Input */}
      <form className="chat-compose" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="chat-compose-input"
          placeholder="Message..."
          rows={1}
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          onInput={(e) => {
            const ta = e.currentTarget;
            ta.style.height = "auto";
            ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
          }}
        />
        <button
          type="submit"
          className="chat-compose-send"
          disabled={disabled}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}
