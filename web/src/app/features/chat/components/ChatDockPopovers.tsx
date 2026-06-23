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
            {activeAgent.tasks.map((task) => (
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
            <span>CONTEXT</span>
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
