import { useMemo, useState } from "preact/hooks";
import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { MessageInput } from "../../../components/ui/MessageInput";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { JSX } from "preact";
import { buildChatAgentViewModel, type ChatAgentData } from "../domain/agent";
import { ActiveAgentPanel } from "./ActiveAgentPanel";
import { ChatTranscript, type ChatDockMessage } from "./ChatTranscript";
import "./ChatDock.css";

export type { ChatDockMessage } from "./ChatTranscript";

type ChatDockProps = {
  open: boolean;
  width: number;
  dragging?: boolean;
  atMax?: boolean;
  messages: readonly ChatDockMessage[];
  title?: string;
  status?: StatusTone;
  statusLabel?: string;
  contextLabel?: string;
  agent?: ChatAgentData | null;
  userLabel?: string;
  sending?: boolean;
  onResizeStart: (event: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
  onToggleOpen: () => void;
  onToggleMax: () => void;
  onOpenCrew: () => void;
  onSendMessage?: (message: string) => void;
  onSelectAgent?: (agentId: string) => void;
};

export function ChatDock({
  open,
  width,
  dragging = false,
  atMax = false,
  messages,
  title = "Chat",
  status = "idle",
  statusLabel = "no process",
  contextLabel = "no history",
  agent,
  userLabel,
  sending = false,
  onResizeStart,
  onToggleOpen,
  onToggleMax,
  onOpenCrew,
  onSendMessage,
  onSelectAgent,
}: ChatDockProps) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const activeAgent = useMemo(() => buildChatAgentViewModel({
    agent,
    title,
    status,
    statusLabel,
    contextLabel,
  }), [agent, title, status, statusLabel, contextLabel]);

  const openAgentPanel = () => {
    setAgentPanelOpen(true);
  };

  const closeAgentPanel = () => {
    setAgentPanelOpen(false);
  };

  if (!open) {
    return (
      <button type="button" class="gsv-chat-min" onClick={onToggleOpen}>
        <span class="gsv-chat-avatar">
          <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={40} />
        </span>
        <span>
          <strong>{activeAgent.name}</strong>
          <small>
            {activeAgent.activity}
            <i />
          </small>
        </span>
        <Icon name="chat" size={18} />
      </button>
    );
  }

  return (
    <aside
      class={`gsv-chat${dragging ? " is-dragging" : ""}`}
      aria-label="Chat"
      style={{ width: `${width}px` }}
    >
      <div class="gsv-chat-resize" onMouseDown={onResizeStart} title="Resize chat" />
      {agentPanelOpen ? (
        <ActiveAgentPanel
          agent={activeAgent}
          onClose={closeAgentPanel}
          onOpenCrew={onOpenCrew}
          onSelectAgent={onSelectAgent}
        />
      ) : null}
      <header class="gsv-chat-head">
        <button
          type="button"
          class="gsv-chat-agent"
          onClick={openAgentPanel}
          aria-haspopup="dialog"
          aria-expanded={agentPanelOpen}
        >
          <span class="gsv-chat-avatar">
            <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={42} />
          </span>
          <span>
            <strong>{activeAgent.name}</strong>
            <small>
              <StatusDot tone={status} size={7} />
              {activeAgent.activity}
            </small>
          </span>
          <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
            <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
        <div class="gsv-chat-actions">
          <button type="button" onClick={onOpenCrew} aria-label="Open crew">
            <Icon name="chat" size={16} />
          </button>
          <IconButton glyph="max" size="medium" title={atMax ? "Restore chat" : "Expand chat"} onClick={onToggleMax} />
          <IconButton glyph="min" size="medium" title="Minimize chat" onClick={onToggleOpen} />
        </div>
      </header>

      <ChatTranscript messages={messages} />

      <div class="gsv-chat-context">
        <span>{contextLabel}</span>
      </div>

      <MessageInput
        disabled={sending}
        placeholder={`Message ${activeAgent.name}...`}
        user={userLabel}
        onSend={onSendMessage}
      />
    </aside>
  );
}
