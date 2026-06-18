import { buildCrewAgents, buildTaskGroups, type CrewTask } from "../../domain/crew";
import { ConsoleCard, ObjectHeader } from "../../components/ui/ConsoleCard";
import { Icon } from "../../components/ui/Icon";
import type { AgentDetail, AgentModelProfile } from "../agents/types";
import type { ProcessEntry } from "./types";

export function TaskBoard({
  agents,
  models,
  processes,
  loading,
  onSelect,
}: {
  agents: AgentDetail[];
  models: AgentModelProfile[];
  processes: ProcessEntry[];
  loading: boolean;
  onSelect: (process: ProcessEntry) => void;
}) {
  const crew = buildCrewAgents(agents, processes, models);
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
              <TaskCard key={task.pid} task={task} onSelect={() => onSelect(task.process)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskCard({ task, onSelect }: { task: CrewTask; onSelect: () => void }) {
  return (
    <ConsoleCard class="gsv-task-card" tone={task.tone} onClick={onSelect}>
      <div class="gsv-task-card-main">
        <span class={`gsv-mark is-${task.tone}`} aria-hidden="true"></span>
        <strong>{task.title}</strong>
        <Icon name="chevron-right" />
      </div>
      <div class="gsv-task-card-meta">
        <span>{task.stateLabel}</span>
        <span>{task.pid}</span>
      </div>
    </ConsoleCard>
  );
}
