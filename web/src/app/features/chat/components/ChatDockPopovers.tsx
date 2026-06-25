import { Icon } from "../../../components/ui/Icon";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentViewModel, ChatModelProfileData } from "../domain/agent";
import type { ChatHistory, ChatProcessAiConfig } from "../domain/processes";
import { formatCount, shortId } from "./chatUiFormat";

export type ChatPopoverId = "model" | "tasks" | "context";

type ChatDockPopoversProps = {
  activeAgent: ChatAgentViewModel;
  context: ChatHistory["context"] | null;
  contextLevel: string;
  contextModel: string;
  contextPercent: number | null;
  hasActiveProcess: boolean;
  messageCount: number | null | undefined;
  onApplyModelProfile: (profile: ChatModelProfileData) => void;
  onOpenModels: () => void;
  onOpenTasks: () => void;
  onClearProcessAiConfig: () => void;
  onSetReasoning: (reasoning: string) => void;
  openPopover: ChatPopoverId | null;
  processAiConfig: ChatProcessAiConfig;
  processAiConfigBusy: boolean;
  processAiConfigLoading: boolean;
  runStateLabel: string;
  taskCount: number;
};

function taskStatusTone(status: string): StatusTone {
  if (status === "error") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  return "live";
}

function taskStatusLabel(status: string): string {
  if (status === "error") {
    return "ERROR";
  }
  if (status === "idle") {
    return "IDLE";
  }
  return "RUNNING";
}

const REASONING_OPTIONS = ["off", "low", "medium", "high"] as const;

function modelProfileSummary(profile: ChatModelProfileData): string {
  return [
    profile.values["config/ai/provider"],
    profile.values["config/ai/model"],
  ].map((value) => value?.trim()).filter(Boolean).join(" · ") || "Saved AI config";
}

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
  context,
  contextLevel,
  contextModel,
  contextPercent,
  hasActiveProcess,
  messageCount,
  onApplyModelProfile,
  onClearProcessAiConfig,
  onOpenModels,
  onOpenTasks,
  onSetReasoning,
  openPopover,
  processAiConfig,
  processAiConfigBusy,
  processAiConfigLoading,
  runStateLabel,
  taskCount,
}: ChatDockPopoversProps) {
  const processModel = processAiConfig?.values["config/ai/model"]?.trim() ?? "";
  const processReasoning = processAiConfig?.values["config/ai/reasoning"]?.trim() ?? "";
  const hasProcessOverrides = Boolean(processAiConfig && Object.keys(processAiConfig.values).length > 0);

  return (
    <>
      {openPopover === "model" ? (
        <div class="gsv-chat-popover gsv-chat-model-popover" role="menu" aria-label="Model state">
          <header>
            <span>{activeAgent.modelLabel}</span>
            <small>{activeAgent.modelIsDefault ? "DEFAULT" : "ACTIVE"}</small>
          </header>
          <div class="gsv-chat-popover-section">
            <span>RUN STATE</span>
            <strong>{runStateLabel.toUpperCase()}</strong>
          </div>
          <div class="gsv-chat-popover-section">
            <span>MODEL SOURCE</span>
            <strong>{processModel ? `PROCESS · ${processModel}` : contextModel || "GATEWAY DEFAULT"}</strong>
          </div>
          <div class="gsv-chat-popover-section">
            <span>PROCESS PROFILE</span>
            <strong>{processAiConfigLoading ? "LOADING" : processAiConfig?.profile?.name || processAiConfig?.profile?.id || "NO LOCAL PROFILE"}</strong>
          </div>
          <div class="gsv-chat-popover-label">MODEL PROFILE</div>
          <div class="gsv-chat-model-options" role="list">
            {activeAgent.modelProfiles.length > 0 ? activeAgent.modelProfiles.map((profile) => {
              const active = modelProfileIsActive(processAiConfig, profile);
              return (
              <button
                type="button"
                class={`gsv-chat-model-row${active ? " is-current" : ""}`}
                role="listitem"
                aria-current={active ? "true" : undefined}
                disabled={processAiConfigBusy || !hasActiveProcess || active}
                key={profile.id}
                onClick={() => onApplyModelProfile(profile)}
              >
                <span class="gsv-chat-model-current" aria-hidden="true" />
                <span class="gsv-chat-model-label">
                  <strong>{profile.name}</strong>
                  <em>{modelProfileSummary(profile)}</em>
                </span>
                {active ? <small>PROCESS</small> : null}
              </button>
              );
            }) : (
              <div class="gsv-chat-model-empty">NO SAVED MODEL PROFILES</div>
            )}
          </div>
          <div class="gsv-chat-popover-label">REASONING</div>
          <div class="gsv-chat-reasoning-options">
            {REASONING_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                class={processReasoning === option ? "is-current" : ""}
                disabled={processAiConfigBusy || !hasActiveProcess}
                onClick={() => onSetReasoning(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
          {context?.runId ? (
            <div class="gsv-chat-popover-section">
              <span>RUN</span>
              <strong>{shortId(context.runId)}</strong>
            </div>
          ) : null}
          <button
            type="button"
            class="gsv-chat-popover-action"
            disabled={processAiConfigBusy || !hasProcessOverrides}
            onClick={onClearProcessAiConfig}
          >
            <Icon name="close" size={12} />
            <span>CLEAR PROCESS OVERRIDES</span>
          </button>
          <button type="button" class="gsv-chat-popover-action" onClick={onOpenModels}>
            <Icon name="stars" size={12} />
            <span>MANAGE MODELS</span>
          </button>
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
            ) : activeAgent.tasks.map((task) => (
              <div class="gsv-chat-task-row" key={`${task.status}-${task.name}`}>
                <StatusDot tone={taskStatusTone(task.status)} size={8} />
                <span class="gsv-chat-task-name">{task.name}</span>
                <small>{taskStatusLabel(task.status)}</small>
              </div>
            ))}
          </div>
          <button type="button" class="gsv-chat-popover-action" onClick={onOpenTasks}>
            <Icon name="plus" size={12} />
            <span>OPEN TASKS</span>
          </button>
        </div>
      ) : null}

      {openPopover === "context" ? (
        <div class="gsv-chat-popover gsv-chat-context-popover" role="menu" aria-label="Context state">
          <header>
            <span class="gsv-chat-context-heading">
              <Icon name="stars" size={12} />
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
        </div>
      ) : null}
    </>
  );
}
