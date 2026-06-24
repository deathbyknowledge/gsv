import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentViewModel, ChatModelProfileData } from "../domain/agent";
import type { ChatHistory, ChatProcessAiConfig } from "../domain/processes";
import { ChatDockPopovers, type ChatPopoverId } from "./ChatDockPopovers";

type ChatDockHeaderProps = {
  activeAgent: ChatAgentViewModel;
  agentPanelOpen: boolean;
  atMax: boolean;
  canAbortRun: boolean;
  context: ChatHistory["context"] | null;
  contextLabel: string;
  contextLevel: string;
  contextModel: string;
  contextPercent: number | null;
  contextTitle: string;
  effectiveStatus: StatusTone;
  hasActiveProcess: boolean;
  messageCount: number | null | undefined;
  openPopover: ChatPopoverId | null;
  processAiConfig: ChatProcessAiConfig;
  processAiConfigBusy: boolean;
  processAiConfigLoading: boolean;
  runStateLabel: string;
  spawnPending: boolean;
  taskCount: number;
  onAbortRun: () => void;
  onApplyModelProfile: (profile: ChatModelProfileData) => void;
  onClearProcessAiConfig: () => void;
  onOpenAgentPanel: () => void;
  onOpenModels: () => void;
  onOpenTasks: () => void;
  onSetReasoning: (reasoning: string) => void;
  onStartProcess: () => void;
  onToggleMax: () => void;
  onToggleOpen: () => void;
  onTogglePopover: (popover: ChatPopoverId) => void;
};

export function ChatDockHeader({
  activeAgent,
  agentPanelOpen,
  atMax,
  canAbortRun,
  context,
  contextLabel,
  contextLevel,
  contextModel,
  contextPercent,
  contextTitle,
  effectiveStatus,
  hasActiveProcess,
  messageCount,
  openPopover,
  processAiConfig,
  processAiConfigBusy,
  processAiConfigLoading,
  runStateLabel,
  spawnPending,
  taskCount,
  onAbortRun,
  onApplyModelProfile,
  onClearProcessAiConfig,
  onOpenAgentPanel,
  onOpenModels,
  onOpenTasks,
  onSetReasoning,
  onStartProcess,
  onToggleMax,
  onToggleOpen,
  onTogglePopover,
}: ChatDockHeaderProps) {
  return (
    <header class="gsv-chat-head">
      <div class="gsv-chat-agent">
        <button
          type="button"
          class="gsv-chat-agent-main"
          onClick={onOpenAgentPanel}
          aria-haspopup="dialog"
          aria-expanded={agentPanelOpen}
        >
          <span class="gsv-chat-avatar">
            <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={42} />
          </span>
          <span class="gsv-chat-agent-name-row">
            <strong>{activeAgent.name}</strong>
            <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
              <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </span>
        </button>
        <button
          type="button"
          class="gsv-chat-agent-model"
          onClick={() => onTogglePopover("model")}
          aria-haspopup="menu"
          aria-expanded={openPopover === "model"}
        >
          <span>{activeAgent.modelLabel}</span>
          <span>{runStateLabel}</span>
          <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
            <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
        <button
          type="button"
          class="gsv-chat-agent-activity"
          onClick={() => onTogglePopover("tasks")}
          aria-haspopup="menu"
          aria-expanded={openPopover === "tasks"}
        >
          <StatusDot tone={effectiveStatus} size={7} />
          <span>{activeAgent.activity}</span>
          <i aria-hidden="true" />
          <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
            <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
      </div>
      <div class="gsv-chat-actions">
        <div class="gsv-chat-action-row">
          {!hasActiveProcess ? (
            <button
              type="button"
              class="gsv-chat-command gsv-chat-command-start"
              disabled={spawnPending}
              onClick={onStartProcess}
              title="Start process"
              aria-label="Start process"
            >
              <Icon name="plus" size={15} />
            </button>
          ) : null}
          {canAbortRun ? (
            <button
              type="button"
              class="gsv-chat-command gsv-chat-command-abort"
              onClick={onAbortRun}
              title="Abort current run"
              aria-label="Abort current run"
            >
              <span aria-hidden="true" />
            </button>
          ) : null}
          <IconButton glyph="max" size="medium" title={atMax ? "Restore chat" : "Expand chat"} onClick={onToggleMax} />
          <IconButton glyph="min" size="medium" title="Minimize chat" onClick={onToggleOpen} />
        </div>
        <button
          type="button"
          class="gsv-chat-context-control"
          title={contextTitle}
          onClick={() => onTogglePopover("context")}
          aria-haspopup="menu"
          aria-expanded={openPopover === "context"}
        >
          <Icon name="stars" size={14} />
          {contextPercent !== null ? (
            <Progress value={contextPercent} label="" showValue={false} size="medium" width={46} />
          ) : null}
          <span>{contextPercent !== null ? `${contextPercent}%` : contextLabel}</span>
        </button>
      </div>

      <ChatDockPopovers
        activeAgent={activeAgent}
        context={context}
        contextLevel={contextLevel}
        contextModel={contextModel}
        contextPercent={contextPercent}
        hasActiveProcess={hasActiveProcess}
        messageCount={messageCount}
        openPopover={openPopover}
        processAiConfig={processAiConfig}
        processAiConfigBusy={processAiConfigBusy}
        processAiConfigLoading={processAiConfigLoading}
        runStateLabel={runStateLabel}
        taskCount={taskCount}
        onApplyModelProfile={onApplyModelProfile}
        onClearProcessAiConfig={onClearProcessAiConfig}
        onOpenModels={onOpenModels}
        onOpenTasks={onOpenTasks}
        onSetReasoning={onSetReasoning}
      />
    </header>
  );
}
