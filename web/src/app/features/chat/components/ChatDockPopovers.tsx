import { Icon } from "../../../components/ui/Icon";
import { ArchiveFolderGlyph, FreeContextGlyph } from "../../../components/ui/lineGlyphs";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import { TwoLevelSelect } from "../../../components/ui/TwoLevelSelect";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentTaskStatus, ChatAgentViewModel, ChatModelProfileData } from "../domain/agent";
import type { ChatConversation, ChatHistory, ChatProcessAiConfig, ChatProcessSummary } from "../domain/processes";
import { formatCount, shortId } from "./chatUiFormat";

export type ChatPopoverId = "model" | "tasks" | "context" | "conversations";

function conversationLabel(conversation: ChatConversation): string {
  return conversation.title
    || (conversation.id === "default" ? "Default" : shortId(conversation.id));
}

type ChatDockPopoversProps = {
  activeAgent: ChatAgentViewModel;
  activeProcessId: string;
  archiveOpen: boolean;
  canFreeContext: boolean;
  compactKeepLast: number;
  compactPending: boolean;
  hasArchivedMessages: boolean;
  onFreeContext: () => void;
  onToggleArchive: () => void;
  conversations: readonly ChatConversation[];
  activeConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  context: ChatHistory["context"] | null;
  contextLevel: string;
  contextPercent: number | null;
  hasActiveProcess: boolean;
  messageCount: number | null | undefined;
  modelLabel: string;
  onApplyModelProfile: (profile: ChatModelProfileData) => void;
  onOpenModels: () => void;
  onOpenTasks: () => void;
  onOpenTaskProcess: (processId: string, process: ChatProcessSummary | null) => void;
  onStartNewTask: () => void;
  onSetReasoning: (reasoning: string) => void;
  openPopover: ChatPopoverId | null;
  processAiConfig: ChatProcessAiConfig;
  processAiConfigBusy: boolean;
  canStartNewTask: boolean;
  taskCount: number;
};

function taskStatusTone(status: ChatAgentTaskStatus): StatusTone {
  if (status === "error") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  return "live";
}

function taskStatusLabel(status: ChatAgentTaskStatus): string {
  if (status === "error") {
    return "ERROR";
  }
  if (status === "idle") {
    return "IDLE";
  }
  return "RUNNING";
}

const REASONING_OPTIONS = ["off", "low", "medium", "high"] as const;

function modelProfileIsActive(
  config: ChatProcessAiConfig,
  profile: ChatModelProfileData,
): boolean {
  if (!config) {
    return false;
  }
  return config.profile?.id === profile.id || config.profile?.name === profile.name;
}

export function ChatDockPopovers({
  activeAgent,
  activeProcessId,
  archiveOpen,
  canFreeContext,
  compactKeepLast,
  compactPending,
  hasArchivedMessages,
  onFreeContext,
  onToggleArchive,
  conversations,
  activeConversationId,
  onSelectConversation,
  context,
  contextLevel,
  contextPercent,
  hasActiveProcess,
  messageCount,
  modelLabel,
  onApplyModelProfile,
  onOpenModels,
  onOpenTasks,
  onOpenTaskProcess,
  onStartNewTask,
  onSetReasoning,
  openPopover,
  processAiConfig,
  processAiConfigBusy,
  canStartNewTask,
  taskCount,
}: ChatDockPopoversProps) {
  const processReasoning = processAiConfig?.values["config/ai/reasoning"]?.trim() ?? "";
  const currentReasoning = (processReasoning || context?.reasoning || "").trim().toLowerCase();

  return (
    <>
      {openPopover === "conversations" ? (
        <div class="gsv-chat-popover gsv-chat-conversations-popover" role="menu" aria-label="Conversation branches">
          <header>
            <span>BRANCHES</span>
            <small>{conversations.length}</small>
          </header>
          <div class="gsv-chat-model-options" role="list">
            {conversations.map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <button
                  type="button"
                  class={`gsv-chat-model-row${active ? " is-current" : ""}`}
                  role="listitem"
                  aria-current={active ? "true" : undefined}
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <span class="gsv-chat-model-current" aria-hidden="true" />
                  <span class="gsv-chat-model-label">
                    <strong>{conversationLabel(conversation)}</strong>
                    {conversation.messageCount > 0 ? <em>{formatCount(conversation.messageCount)} messages</em> : null}
                  </span>
                  {active ? <small>CURRENT</small> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {openPopover === "model" ? (
        <div class="gsv-chat-popover gsv-chat-model-popover" role="menu" aria-label="Model and reasoning">
          <TwoLevelSelect
            headerLabel={modelLabel}
            ariaLabel="Model and reasoning"
            groups={[
              {
                id: "reasoning",
                label: "REASONING",
                options: REASONING_OPTIONS.map((option) => ({
                  id: option,
                  label: option.toUpperCase(),
                  selected: option === currentReasoning,
                  disabled: processAiConfigBusy || !hasActiveProcess,
                })),
              },
              {
                id: "model",
                label: "SWITCH MODEL",
                emptyLabel: "NO SAVED MODELS",
                options: activeAgent.modelProfiles.map((profile) => {
                  const active = modelProfileIsActive(processAiConfig, profile);
                  return {
                    id: profile.id,
                    label: profile.name,
                    selected: active,
                    disabled: processAiConfigBusy || !hasActiveProcess || active,
                  };
                }),
              },
            ]}
            footer={{ label: "MANAGE MODELS", onClick: onOpenModels }}
            onSelect={(groupId, optionId) => {
              if (groupId === "reasoning") {
                onSetReasoning(optionId);
                return;
              }
              const profile = activeAgent.modelProfiles.find((entry) => entry.id === optionId);
              if (profile) {
                onApplyModelProfile(profile);
              }
            }}
          />
        </div>
      ) : null}

      {openPopover === "tasks" ? (
        <div class="gsv-chat-popover gsv-chat-task-popover" role="menu" aria-label="Current tasks">
          <header>
            <span>CURRENT TASKS</span>
            <small>{taskCount}</small>
          </header>
          <div class="gsv-chat-task-list">
            {activeAgent.tasks.length === 0 ? (
              <div class="gsv-chat-task-row is-empty">
                <StatusDot tone="idle" size={8} />
                <span class="gsv-chat-task-name">No process activity</span>
                <small>IDLE</small>
              </div>
            ) : activeAgent.tasks.map((task) => {
              const canOpen = task.processId.length > 0;
              const current = canOpen && task.processId === activeProcessId;
              const content = (
                <>
                  <StatusDot tone={taskStatusTone(task.status)} size={8} />
                  <span class="gsv-chat-task-name">{task.name}</span>
                  <small>{current ? "CURRENT" : taskStatusLabel(task.status)}</small>
                </>
              );

              return canOpen ? (
                <button
                  type="button"
                  class={`gsv-chat-task-row is-clickable${current ? " is-current" : ""}`}
                  key={`${task.processId}-${task.status}`}
                  aria-current={current ? "true" : undefined}
                  onClick={() => onOpenTaskProcess(task.processId, task.process)}
                >
                  {content}
                </button>
              ) : (
                <div class="gsv-chat-task-row" key={`${task.name}-${task.status}`}>
                  {content}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            class="gsv-chat-popover-action"
            disabled={!canStartNewTask}
            onClick={onStartNewTask}
          >
            <Icon name="plus" size={12} />
            <span>NEW TASK</span>
          </button>
          <button type="button" class="gsv-chat-popover-action" onClick={onOpenTasks}>
            <Icon name="list" size={12} />
            <span>OPEN TASKS</span>
          </button>
        </div>
      ) : null}

      {openPopover === "context" ? (
        <div class="gsv-chat-popover gsv-chat-context-popover" role="menu" aria-label="Context state">
          <header>
            <span class="gsv-chat-context-heading">
              <span>CONTEXT</span>
            </span>
            <small>{contextPercent !== null ? `${contextPercent}% · ${contextLevel}` : contextLevel}</small>
          </header>
          <div class="gsv-chat-context-popover-meter">
            <Progress
              value={contextPercent ?? 0}
              indeterminate={contextPercent === null && hasActiveProcess}
              label=""
              showValue={false}
              size="medium"
              width={186}
            />
          </div>
          <div class="gsv-chat-context-grid">
            <span>INPUT</span>
            <strong>{formatCount(context?.inputTokens)}</strong>
            <span>AVAILABLE</span>
            <strong>{formatCount(context?.availableInputTokens)}</strong>
            <span>WINDOW</span>
            <strong>{formatCount(context?.contextWindowTokens)}</strong>
            <span>MESSAGES</span>
            <strong>{formatCount(context?.messageCount ?? messageCount)}</strong>
          </div>
          {hasActiveProcess ? (
            <>
              <button
                type="button"
                class="gsv-chat-popover-action"
                disabled={!canFreeContext}
                onClick={onFreeContext}
              >
                <FreeContextGlyph size={13} />
                <span>{compactPending ? "FREEING CONTEXT" : `FREE CONTEXT · KEEP ${compactKeepLast}`}</span>
              </button>
              <button
                type="button"
                class="gsv-chat-popover-action"
                aria-expanded={archiveOpen}
                disabled={!hasArchivedMessages && !archiveOpen}
                onClick={onToggleArchive}
              >
                <ArchiveFolderGlyph size={13} />
                <span>{archiveOpen ? "HIDE ARCHIVED" : "ARCHIVED"}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
