import { useMemo, useState } from "preact/hooks";
import { Avatar } from "../../../components/ui/Avatar";
import { Button } from "../../../components/ui/Button";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { Search } from "../../../components/ui/Search";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type {
  ChatAgentCrewView,
  ChatAgentSelection,
  ChatAgentTaskView,
  ChatAgentViewModel,
} from "../domain/agent";
import type { ChatProcessSummary } from "../domain/processes";

type ChatAgentPanelProps = {
  agent: ChatAgentViewModel;
  activeProcessId: string;
  canStartNewTask: boolean;
  onOpenTaskProcess: (processId: string, process: ChatProcessSummary | null) => void;
  onStartNewTask: () => void;
  onSelectAgent?: (selection: ChatAgentSelection) => void;
  onOpenCrew: () => void;
  /** Return to the chat body (header stays put). */
  onClose: () => void;
};

function taskRowStatus(status: ChatAgentTaskView["status"]): ListRowStatus {
  if (status === "error") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  return "live";
}

function taskStatusLabel(status: ChatAgentTaskView["status"]): string {
  if (status === "error") {
    return "ERROR";
  }
  if (status === "idle") {
    return "IDLE";
  }
  return "RUNNING";
}

function taskSub(task: ChatAgentTaskView): string {
  const process = task.process;
  if (!process) {
    return "";
  }
  return [process.username, process.cwd].filter(Boolean).join(" / ");
}

function crewRowStatus(status: ChatAgentCrewView["status"]): ListRowStatus {
  if (status === "error" || status === "idle" || status === "live" || status === "online") {
    return status;
  }
  return "idle";
}

/** ChatAgentPanel — the agent body state (HAM-310): the current agent's tasks
 *  as list rows (search + NEW TASK, same component as the tasks page) with the
 *  crew pinned at the bottom as rows (HAM-488). Replaces transcript+composer;
 *  the chat header stays. */
export function ChatAgentPanel({
  agent,
  activeProcessId,
  canStartNewTask,
  onOpenTaskProcess,
  onStartNewTask,
  onSelectAgent,
  onOpenCrew,
  onClose,
}: ChatAgentPanelProps) {
  const [query, setQuery] = useState("");

  const tasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agent.tasks.filter((task) => !q || task.name.toLowerCase().includes(q));
  }, [agent.tasks, query]);
  const activeCount = agent.tasks.filter((task) => task.status !== "idle").length;

  const openTask = (task: ChatAgentTaskView) => {
    if (task.processId) {
      onOpenTaskProcess(task.processId, task.process);
    }
    onClose();
  };

  const selectAgent = (member: ChatAgentCrewView) => {
    if (member.active) {
      return;
    }
    if (member.processId && onSelectAgent) {
      onSelectAgent({ agentId: member.id, processId: member.processId });
      onClose();
      return;
    }
    if (member.startable && onSelectAgent) {
      onSelectAgent({
        agentId: member.id,
        ...(member.runAs ? { runAs: member.runAs } : {}),
      });
      onClose();
      return;
    }
    onClose();
    onOpenCrew();
  };

  return (
    <div class="gsv-chat-agent-panel" role="region" aria-label={`${agent.name} tasks`}>
      <div class="gsv-chat-agent-tasks">
        <SectionHeader
          title="TASKS"
          meta={`${activeCount}/${agent.tasks.length} ACTIVE`}
          divider
        />
        <div class="gsv-chat-agent-tasks-bar">
          <Search
            value={query}
            placeholder="Search tasks…"
            size="small"
            block
            onChange={setQuery}
          />
          <Button
            label="+ NEW TASK"
            disabled={!canStartNewTask}
            onClick={() => {
              onStartNewTask();
              onClose();
            }}
          />
        </div>
        <div class="gsv-chat-agent-tasks-list">
          {tasks.length === 0 ? (
            <ListRow
              label={query.trim() ? "No matching tasks" : "No tasks yet"}
              sub={query.trim() ? "" : "Start a new task to begin."}
              status="none"
            />
          ) : tasks.map((task) => {
            const current = Boolean(task.processId) && task.processId === activeProcessId;
            return (
              <ListRow
                key={task.processId || task.name}
                icon={task.process && !task.process.interactive ? "list" : "chat"}
                label={task.name}
                sub={taskSub(task)}
                status={taskRowStatus(task.status)}
                statusLabel={current ? "CURRENT" : taskStatusLabel(task.status)}
                statusDotPlacement="trailing"
                active={current}
                chevron
                onClick={() => openTask(task)}
              />
            );
          })}
        </div>
      </div>

      <div class="gsv-chat-agent-crew">
        <SectionHeader
          title="CREW"
          meta={agent.hasCrewData ? `${agent.crew.length} AGENTS` : "PROCESS"}
          divider
          onClick={onOpenCrew}
          ariaLabel="Open crew page"
        />
        <div class="gsv-chat-agent-crew-rows">
          {agent.crew.map((member) => (
            <ListRow
              key={member.id}
              leading={<Avatar src={member.imageSrc} status={member.status} size={30} cover />}
              label={member.name}
              status={crewRowStatus(member.status)}
              statusLabel={member.statusLabel}
              statusDotPlacement="trailing"
              active={member.active}
              chevron={!member.active}
              chevronLabel="SWITCH AGENT"
              onClick={member.active ? undefined : () => selectAgent(member)}
            />
          ))}
          <ListRow
            icon="plus"
            label="NEW AGENT"
            status="none"
            chevron
            onClick={() => {
              onClose();
              onOpenCrew();
            }}
          />
        </div>
      </div>
    </div>
  );
}
