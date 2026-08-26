import { useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { Search } from "../../../components/ui/Search";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type {
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

  return (
    <div class="gsv-chat-agent-panel" role="region" aria-label={`${agent.name} work`}>
      <div class="gsv-chat-agent-tasks">
        <SectionHeader
          title="WORK"
          meta={`${activeCount}/${agent.tasks.length} ACTIVE`}
          divider
        />
        <div class="gsv-chat-agent-tasks-bar">
          <Search
            value={query}
            placeholder="Search work…"
            size="small"
            block
            onChange={setQuery}
          />
          <Button
            label="NEW WORK"
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
              label={query.trim() ? "No matching work" : "No work yet"}
              sub={query.trim() ? "" : "Start new work to begin."}
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

    </div>
  );
}
