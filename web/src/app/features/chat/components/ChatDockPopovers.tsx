import { Icon } from "../../../components/ui/Icon";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentViewModel } from "../domain/agent";
import type { ChatHistory } from "../domain/processes";
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
  onOpenModels: () => void;
  onOpenTasks: () => void;
  openPopover: ChatPopoverId | null;
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

type ModelOptionView = {
  key: string;
  label: string;
  current: boolean;
  badge: string;
};

function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase();
}

function modelOptionRows(activeAgent: ChatAgentViewModel): ModelOptionView[] {
  const currentLabel = activeAgent.modelValue.trim() || activeAgent.modelLabel;
  const currentKey = normalizeModelKey(currentLabel);
  const seen = new Set<string>();
  const rows = activeAgent.modelOptions
    .map((option, index) => {
      const label = option.trim();
      if (!label) {
        return null;
      }

      const key = normalizeModelKey(label);
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);

      const current = key === currentKey || (activeAgent.modelIsDefault && index === 0);
      return {
        key,
        label,
        current,
        badge: current ? (activeAgent.modelIsDefault ? "DEFAULT" : "ACTIVE") : "",
      };
    })
    .filter((option): option is ModelOptionView => option !== null);

  if (rows.some((option) => option.current)) {
    return rows;
  }

  const label = currentLabel.trim();
  return label
    ? [
        {
          key: normalizeModelKey(label),
          label,
          current: true,
          badge: activeAgent.modelIsDefault ? "DEFAULT" : "ACTIVE",
        },
        ...rows,
      ]
    : rows;
}

export function ChatDockPopovers({
  activeAgent,
  context,
  contextLevel,
  contextModel,
  contextPercent,
  hasActiveProcess,
  messageCount,
  onOpenModels,
  onOpenTasks,
  openPopover,
  runStateLabel,
  taskCount,
}: ChatDockPopoversProps) {
  const modelOptions = modelOptionRows(activeAgent);

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
            <strong>{contextModel || "GATEWAY DEFAULT"}</strong>
          </div>
          <div class="gsv-chat-popover-label">SWITCH MODEL</div>
          <div class="gsv-chat-model-options" role="list">
            {modelOptions.map((option) => (
              <div
                class={`gsv-chat-model-row${option.current ? " is-current" : ""}`}
                role="listitem"
                aria-current={option.current ? "true" : undefined}
                key={option.key}
              >
                <span class="gsv-chat-model-current" aria-hidden="true" />
                <span class="gsv-chat-model-label">{option.label}</span>
                {option.badge ? <small>{option.badge}</small> : null}
              </div>
            ))}
          </div>
          {context?.runId ? (
            <div class="gsv-chat-popover-section">
              <span>RUN</span>
              <strong>{shortId(context.runId)}</strong>
            </div>
          ) : null}
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
