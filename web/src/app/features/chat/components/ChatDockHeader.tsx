import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import { SpeakerOnGlyph, SpeakerOffGlyph } from "../../../components/ui/lineGlyphs";
import { Hint } from "../../../components/ui/Tooltip";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentViewModel, ChatModelProfileData } from "../domain/agent";
import type { ChatHistory, ChatProcessAiConfig, ChatProcessSummary } from "../domain/processes";
import { ChatDockPopovers, type ChatPopoverId } from "./ChatDockPopovers";

type ChatDockHeaderProps = {
  activeAgent: ChatAgentViewModel;
  activeProcessId: string;
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
  modelLabel: string;
  openPopover: ChatPopoverId | null;
  processAiConfig: ChatProcessAiConfig;
  processAiConfigBusy: boolean;
  processAiConfigLoading: boolean;
  reasoningLabel: string;
  runStateLabel: string;
  canStartNewTask: boolean;
  spawnPending: boolean;
  speakReplies: boolean;
  speechStatus: string;
  taskCount: number;
  onAbortRun: () => void;
  onApplyModelProfile: (profile: ChatModelProfileData) => void;
  onClearProcessAiConfig: () => void;
  onOpenAgentPanel: () => void;
  onOpenModels: () => void;
  onOpenTasks: () => void;
  onOpenTaskProcess: (processId: string, process: ChatProcessSummary | null) => void;
  onStartNewTask: () => void;
  onSetReasoning: (reasoning: string) => void;
  onStartProcess: () => void;
  onToggleSpeakReplies: () => void;
  onToggleMax: () => void;
  onToggleOpen: () => void;
  onTogglePopover: (popover: ChatPopoverId) => void;
};

export function ChatDockHeader({
  activeAgent,
  activeProcessId,
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
  modelLabel,
  openPopover,
  processAiConfig,
  processAiConfigBusy,
  processAiConfigLoading,
  reasoningLabel,
  runStateLabel,
  canStartNewTask,
  spawnPending,
  speakReplies,
  speechStatus,
  taskCount,
  onAbortRun,
  onApplyModelProfile,
  onClearProcessAiConfig,
  onOpenAgentPanel,
  onOpenModels,
  onOpenTasks,
  onOpenTaskProcess,
  onStartNewTask,
  onSetReasoning,
  onStartProcess,
  onToggleSpeakReplies,
  onToggleMax,
  onToggleOpen,
  onTogglePopover,
}: ChatDockHeaderProps) {
  return (
    <header class="gsv-chat-head">
      <div class="gsv-chat-agent">
        <Hint text="View agent profile & switch agents" position="bottom-start">
          <button
            type="button"
            class="gsv-chat-agent-main"
            onClick={onOpenAgentPanel}
            aria-haspopup="dialog"
            aria-expanded={agentPanelOpen}
          >
            <span class="gsv-chat-avatar">
              <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={42} cover />
            </span>
            <span class="gsv-chat-agent-name-row">
              <strong class="gsv-prose-heading">{activeAgent.name}</strong>
              <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
                <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
              </svg>
            </span>
          </button>
        </Hint>
        <Hint text="Change model & reasoning effort" position="bottom-start">
          <button
            type="button"
            class="gsv-chat-agent-model gsv-sublabel"
            data-chat-popover-trigger="model"
            onClick={() => onTogglePopover("model")}
            aria-haspopup="menu"
            aria-expanded={openPopover === "model"}
          >
            <span>{modelLabel}</span>
            <span>{reasoningLabel}</span>
            <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
              <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
        </Hint>
        <Hint text="View activity & tasks" position="bottom-start">
          <button
            type="button"
            class="gsv-chat-agent-activity gsv-prose-sm"
            data-chat-popover-trigger="tasks"
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
        </Hint>
      </div>
      <div class="gsv-chat-actions">
        <div class="gsv-chat-action-row">
          {!hasActiveProcess ? (
            <Hint text="Start an interactive process" position="bottom-end">
              <button
                type="button"
                class="gsv-chat-command gsv-chat-command-start"
                disabled={spawnPending}
                onClick={onStartProcess}
                aria-label="Start process"
              >
                <Icon name="plus" size={15} />
              </button>
            </Hint>
          ) : null}
          <Hint text={speechStatus} position="bottom-end">
            <button
              type="button"
              class={`gsv-chat-command gsv-chat-command-speech${speakReplies ? " is-active" : ""}`}
              aria-label={speakReplies ? "Disable spoken replies" : "Enable spoken replies"}
              aria-pressed={speakReplies ? "true" : "false"}
              onClick={onToggleSpeakReplies}
            >
              {speakReplies ? <SpeakerOnGlyph size={15} /> : <SpeakerOffGlyph size={15} />}
            </button>
          </Hint>
          {canAbortRun ? (
            <Hint text="Abort the current run" position="bottom-end">
              <button
                type="button"
                class="gsv-chat-command gsv-chat-command-abort"
                onClick={onAbortRun}
                aria-label="Abort current run"
              >
                <span aria-hidden="true" />
              </button>
            </Hint>
          ) : null}
          <Hint text={atMax ? "Restore" : "Full width"} position="bottom-end">
            <IconButton glyph="max" size="medium" ariaLabel={atMax ? "Restore chat" : "Expand chat"} onClick={onToggleMax} />
          </Hint>
          <Hint text="Minimize" position="bottom-end">
            <IconButton glyph="min" size="medium" ariaLabel="Minimize chat" onClick={onToggleOpen} />
          </Hint>
        </div>
        <Hint text={contextTitle} position="left">
          <button
            type="button"
            class="gsv-chat-context-control"
            data-chat-popover-trigger="context"
            onClick={() => onTogglePopover("context")}
            aria-haspopup="menu"
            aria-expanded={openPopover === "context"}
          >
            {contextPercent !== null ? (
              <Progress value={contextPercent} label="" showValue={false} size="medium" width={46} />
            ) : null}
            <span>{contextPercent !== null ? `${contextPercent}%` : contextLabel}</span>
          </button>
        </Hint>
      </div>

      <ChatDockPopovers
        activeAgent={activeAgent}
        activeProcessId={activeProcessId}
        context={context}
        contextLevel={contextLevel}
        contextModel={contextModel}
        contextPercent={contextPercent}
        hasActiveProcess={hasActiveProcess}
        messageCount={messageCount}
        modelLabel={modelLabel}
        openPopover={openPopover}
        processAiConfig={processAiConfig}
        processAiConfigBusy={processAiConfigBusy}
        processAiConfigLoading={processAiConfigLoading}
        runStateLabel={runStateLabel}
        canStartNewTask={canStartNewTask}
        taskCount={taskCount}
        onApplyModelProfile={onApplyModelProfile}
        onClearProcessAiConfig={onClearProcessAiConfig}
        onOpenModels={onOpenModels}
        onOpenTasks={onOpenTasks}
        onOpenTaskProcess={onOpenTaskProcess}
        onStartNewTask={onStartNewTask}
        onSetReasoning={onSetReasoning}
      />
    </header>
  );
}
