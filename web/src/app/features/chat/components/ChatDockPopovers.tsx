import { ArchiveFolderGlyph, FreeContextGlyph } from "../../../components/ui/lineGlyphs";
import { ListRow } from "../../../components/ui/ListRow";
import { PopoverMenu, type PopoverActionProps } from "../../../components/ui/PopoverMenu";
import { Progress } from "../../../components/ui/Progress";
import { TwoLevelSelect } from "../../../components/ui/TwoLevelSelect";
import type { ListRowStatus } from "../../../components/ui/ListRow";
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

function taskStatusRowStatus(status: ChatAgentTaskStatus): ListRowStatus {
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

  const contextActions: PopoverActionProps[] = hasActiveProcess
    ? [
        {
          label: compactPending ? "FREEING CONTEXT" : `FREE CONTEXT · KEEP ${compactKeepLast}`,
          onClick: onFreeContext,
          glyph: <FreeContextGlyph size={13} />,
          disabled: !canFreeContext,
        },
        {
          label: archiveOpen ? "HIDE ARCHIVED" : "ARCHIVED",
          onClick: onToggleArchive,
          glyph: <ArchiveFolderGlyph size={13} />,
          ariaExpanded: archiveOpen,
          disabled: !hasArchivedMessages && !archiveOpen,
        },
      ]
    : [];

  return (
    <>
      {openPopover === "conversations" ? (
        <PopoverMenu
          ariaLabel="Conversation branches"
          header={{ kind: "titled", title: "BRANCHES", count: conversations.length }}
        >
          <div class="gsv-popover-list" role="list" style={{ maxHeight: "min(288px, 44vh)" }}>
            {conversations.map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <ListRow
                  key={conversation.id}
                  density="compact"
                  status="none"
                  label={conversationLabel(conversation)}
                  sub={conversation.messageCount > 0 ? `${formatCount(conversation.messageCount)} messages` : ""}
                  statusLabel={active ? "CURRENT" : ""}
                  active={active}
                  onClick={() => onSelectConversation(conversation.id)}
                />
              );
            })}
          </div>
        </PopoverMenu>
      ) : null}

      {openPopover === "model" ? (
        <PopoverMenu
          ariaLabel="Model and reasoning"
          header={{ kind: "echo", label: modelLabel }}
          actions={[{ label: "MANAGE MODELS", onClick: onOpenModels }]}
        >
          <TwoLevelSelect
            headerLabel={modelLabel}
            header={false}
            roving={false}
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
        </PopoverMenu>
      ) : null}

      {openPopover === "tasks" ? (
        <PopoverMenu
          ariaLabel="Current tasks"
          header={{ kind: "titled", title: "CURRENT TASKS", count: taskCount }}
          actions={[
            {
              label: "NEW TASK",
              onClick: onStartNewTask,
              icon: "plus",
              disabled: !canStartNewTask,
            },
            { label: "OPEN TASKS", onClick: onOpenTasks, icon: "list" },
          ]}
        >
          <div class="gsv-popover-list" style={{ maxHeight: "228px" }}>
            {activeAgent.tasks.length === 0 ? (
              <ListRow
                density="compact"
                status="idle"
                label="No process activity"
                statusLabel="IDLE"
              />
            ) : activeAgent.tasks.map((task) => {
              const canOpen = task.processId.length > 0;
              const current = canOpen && task.processId === activeProcessId;
              return (
                <ListRow
                  key={canOpen ? `${task.processId}-${task.status}` : `${task.name}-${task.status}`}
                  density="compact"
                  status={taskStatusRowStatus(task.status)}
                  label={task.name}
                  statusLabel={current ? "CURRENT" : taskStatusLabel(task.status)}
                  active={current}
                  onClick={canOpen ? () => onOpenTaskProcess(task.processId, task.process) : undefined}
                />
              );
            })}
          </div>
        </PopoverMenu>
      ) : null}

      {openPopover === "context" ? (
        <PopoverMenu
          ariaLabel="Context state"
          width="narrow"
          header={{
            kind: "titled",
            title: "CONTEXT",
            count: contextPercent !== null ? `${contextPercent}% · ${contextLevel}` : contextLevel,
          }}
          actions={contextActions}
        >
          <div class="gsv-popover-meter">
            <Progress
              value={contextPercent ?? 0}
              indeterminate={contextPercent === null && hasActiveProcess}
              label=""
              showValue={false}
              size="medium"
              width={186}
            />
          </div>
          <div class="gsv-popover-statgrid">
            <span>INPUT</span>
            <strong>{formatCount(context?.inputTokens)}</strong>
            <span>AVAILABLE</span>
            <strong>{formatCount(context?.availableInputTokens)}</strong>
            <span>WINDOW</span>
            <strong>{formatCount(context?.contextWindowTokens)}</strong>
            <span>MESSAGES</span>
            <strong>{formatCount(context?.messageCount ?? messageCount)}</strong>
          </div>
        </PopoverMenu>
      ) : null}
    </>
  );
}
