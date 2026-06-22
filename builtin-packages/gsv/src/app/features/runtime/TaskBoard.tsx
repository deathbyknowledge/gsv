import { openApp } from "@humansandmachines/gsv/sdk/host";
import { buildCrewAgents, buildTaskGroups, type CrewTask } from "../../domain/crew";
import { ActionButton } from "../../components/ui/ActionButton";
import { ConsoleCard, ObjectHeader } from "../../components/ui/ConsoleCard";
import { Icon } from "../../components/ui/Icon";
import { formatTimestampMs } from "../../utils/format";
import type { AgentDetail, AgentModelProfile } from "../agents/types";
import { canOpenChat, processState } from "./runtime-domain";
import type { ProcessEntry } from "./types";

export type TaskSort = "agent" | "status" | "created" | "updated";

export function TaskBoard({
  agents,
  models,
  systemAiValues,
  processes,
  loading,
  selectedPid,
  killingPid = "",
  onToggle,
  onCancelTask,
}: {
  agents: AgentDetail[];
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  processes: ProcessEntry[];
  loading: boolean;
  selectedPid: string;
  killingPid?: string;
  onToggle: (process: ProcessEntry) => void;
  onCancelTask?: (pid: string) => void;
}) {
  const crew = buildCrewAgents(agents, processes, models, systemAiValues);
  const groups = buildTaskGroups(crew, processes);
  const hasTasks = groups.some((group) => group.tasks.length > 0);

  if (!hasTasks) {
    return (
      <section class="gsv-empty-state">
        <h3>{loading ? "Loading tasks" : "No runtime tasks"}</h3>
        <p>{loading ? "Refreshing process state." : "Refresh to check for newly started work."}</p>
      </section>
    );
  }

  return (
    <div class="gsv-task-board" aria-busy={loading ? "true" : "false"}>
      {groups.map((group) => (
        <section class="gsv-task-group" key={group.id} aria-label={`${group.title} tasks`}>
          <ObjectHeader
            title={group.title}
            eyebrow={group.subtitle}
            icon="user"
            tone={group.tone}
            status={group.tasks.some((task) => task.state !== "idle") ? "good" : "neutral"}
            compact
          />
          <div class="gsv-task-list">
            {group.tasks.length === 0 ? (
              <ConsoleCard class="gsv-task-card is-idle">
                <p class="gsv-task-idle">Idle</p>
              </ConsoleCard>
            ) : group.tasks.map((task) => (
              <TaskCard
                key={task.pid}
                task={task}
                expanded={task.pid === selectedPid}
                killingPid={killingPid}
                onToggle={() => onToggle(task.process)}
                onCancelTask={onCancelTask}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  expanded,
  killingPid,
  onToggle,
  onCancelTask,
}: {
  task: CrewTask;
  expanded: boolean;
  killingPid: string;
  onToggle: () => void;
  onCancelTask?: (pid: string) => void;
}) {
  const process = task.process;
  const pid = String(process.pid ?? task.pid).trim();
  const cwd = String(process.cwd ?? "").trim();

  return (
    <ConsoleCard class={`gsv-task-card${expanded ? " is-expanded" : ""}`} tone={task.tone}>
      <button type="button" class="gsv-task-card-main gsv-task-toggle" onClick={onToggle}>
        <span class={`gsv-mark is-${task.tone}`} aria-hidden="true"></span>
        <strong>{task.title}</strong>
        <Icon name="chevron-right" />
      </button>
      {expanded ? (
        <div class="gsv-task-detail">
          <dl class="gsv-metadata-stack">
            <div><dt>Task ID</dt><dd>{pid}</dd></div>
            <div><dt>Created</dt><dd>{formatTimestampMs(process.createdAt)}</dd></div>
            <div><dt>Status</dt><dd>{processState(process)}</dd></div>
            <div><dt>Workspace</dt><dd>{cwd || "none"}</dd></div>
          </dl>
          <div class="gsv-detail-actions">
            <ActionButton
              icon="external"
              label="Open in Chat"
              disabled={!canOpenChat(process)}
              onClick={() => openApp({ target: "chat", payload: { pid, cwd } })}
            />
            {onCancelTask ? (
              <ActionButton
                icon="trash"
                label="Cancel Task"
                busyLabel="Canceling"
                busy={killingPid === pid}
                variant="danger"
                disabled={!pid || Boolean(killingPid)}
                onClick={() => {
                  if (window.confirm(`Cancel task ${task.title}?\n\nThis stops the runtime work immediately.`)) {
                    onCancelTask(pid);
                  }
                }}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div class="gsv-task-card-meta">
          <span>{task.stateLabel}</span>
          <span>{task.pid}</span>
        </div>
      )}
    </ConsoleCard>
  );
}

export function sortTaskProcesses(processes: ProcessEntry[], sort: TaskSort): ProcessEntry[] {
  return [...processes].sort((left, right) => {
    if (sort === "status") {
      return processState(left).localeCompare(processState(right)) || createdTime(right) - createdTime(left);
    }
    if (sort === "created") {
      return createdTime(right) - createdTime(left);
    }
    if (sort === "updated") {
      return updatedTime(right) - updatedTime(left);
    }
    return String(left.username ?? left.profile ?? "").localeCompare(String(right.username ?? right.profile ?? "")) ||
      createdTime(right) - createdTime(left);
  });
}

function createdTime(process: ProcessEntry): number {
  const value = Number(process.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function updatedTime(process: ProcessEntry): number {
  const value = Number(process.lastActiveAt ?? process.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}
