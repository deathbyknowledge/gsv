import { approvalSummary, relationLabel, relationTone } from "../features/agents/agents-domain";
import type { AgentDetail, AgentModelProfile } from "../features/agents/types";
import { processState, processStateTone, processTitle } from "../features/runtime/runtime-domain";
import type { ProcessEntry } from "../features/runtime/types";

export type CrewTaskState = "idle" | "queued" | "running" | "waiting_tool" | "waiting_hil" | "unknown";

export type CrewTask = {
  pid: string;
  title: string;
  state: CrewTaskState;
  stateLabel: string;
  tone: "good" | "warning" | "neutral";
  agentUsername: string | null;
  agentUid: number | null;
  cwd: string;
  process: ProcessEntry;
};

export type CrewAgent = {
  uid: number;
  username: string;
  displayName: string;
  roleLabel: string;
  description: string;
  modelLabel: string;
  modelDetail: string;
  permissionLabel: string;
  tone: "accent" | "good" | "neutral";
  tasks: CrewTask[];
  activeTasks: CrewTask[];
  agent: AgentDetail;
};

export type CrewTaskGroup = {
  id: string;
  title: string;
  subtitle: string;
  tone: "accent" | "good" | "neutral";
  tasks: CrewTask[];
  agent?: CrewAgent;
};

export function buildCrewTasks(processes: ProcessEntry[]): CrewTask[] {
  return processes.map((process) => {
    const state = normalizeTaskState(processState(process));
    const queue = Number(process.queuedCount ?? 0);
    const queueLabel = Number.isFinite(queue) && queue > 0 ? ` +${queue}` : "";
    return {
      pid: String(process.pid ?? ""),
      title: processTitle(process),
      state,
      stateLabel: state.replace(/_/g, " ") + queueLabel,
      tone: processStateTone(process),
      agentUsername: normalizedString(process.username),
      agentUid: normalizedNumber(process.uid),
      cwd: normalizedString(process.cwd) || "No cwd",
      process,
    };
  }).sort(compareTasks);
}

export function buildCrewAgents(
  agents: AgentDetail[],
  processes: ProcessEntry[],
  models: AgentModelProfile[],
): CrewAgent[] {
  const tasks = buildCrewTasks(processes);
  const defaultModel = models.find((model) => model.default);

  return agents.map((agent) => {
    const agentTasks = tasks.filter((task) => taskBelongsToAgent(task, agent));
    const model = agent.model.trim();
    return {
      uid: agent.uid,
      username: agent.username,
      displayName: agent.displayName,
      roleLabel: relationLabel(agent.relation),
      description: agentDescription(agent),
      modelLabel: model ? modelDisplayLabel(model) : "At default",
      modelDetail: model || defaultModel?.model || "System default",
      permissionLabel: approvalSummary(agent.approval),
      tone: relationTone(agent.relation),
      tasks: agentTasks,
      activeTasks: agentTasks.filter((task) => task.state !== "idle"),
      agent,
    };
  });
}

export function buildTaskGroups(agents: CrewAgent[], processes: ProcessEntry[]): CrewTaskGroup[] {
  const tasks = buildCrewTasks(processes);
  const assigned = new Set<string>();
  const groups: CrewTaskGroup[] = agents.map((agent) => {
    const agentTasks = tasks.filter((task) => {
      const matches = taskBelongsToAgent(task, agent.agent);
      if (matches) assigned.add(task.pid);
      return matches;
    });
    return {
      id: agent.username,
      title: agent.displayName,
      subtitle: agent.roleLabel,
      tone: agent.tone,
      tasks: agentTasks,
      agent,
    };
  });

  const unassigned = tasks.filter((task) => !assigned.has(task.pid));
  if (unassigned.length > 0) {
    groups.push({
      id: "unassigned",
      title: "Other processes",
      subtitle: "Unassigned runtime",
      tone: "neutral",
      tasks: unassigned,
    });
  }

  return groups;
}

export function modelDisplayLabel(model: string): string {
  const cleaned = model
    .replace(/^@cf\//, "")
    .split("/")
    .pop()
    ?.replace(/[-_]+/g, " ")
    .trim() || model;
  return cleaned
    .split(/\s+/)
    .map((part) => part.length > 3 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part.toUpperCase())
    .join(" ");
}

function normalizeTaskState(value: string): CrewTaskState {
  if (
    value === "idle"
    || value === "queued"
    || value === "running"
    || value === "waiting_tool"
    || value === "waiting_hil"
  ) {
    return value;
  }
  return "unknown";
}

function taskBelongsToAgent(task: CrewTask, agent: AgentDetail): boolean {
  if (task.agentUid === agent.uid) {
    return true;
  }
  if (task.agentUsername && task.agentUsername === agent.username) {
    return true;
  }
  const profile = normalizedString(task.process.profile);
  return profile === agent.username || profile === agent.displayName;
}

function agentDescription(agent: AgentDetail): string {
  const gecos = normalizedString(agent.gecos);
  if (gecos && gecos !== agent.displayName) {
    return gecos;
  }
  if (agent.relation === "personal-agent") {
    return "Default agent for personal work and system operations.";
  }
  return "Custom agent account with its own prompt context and behavior policy.";
}

function compareTasks(left: CrewTask, right: CrewTask): number {
  const stateDelta = taskStateWeight(left.state) - taskStateWeight(right.state);
  if (stateDelta !== 0) return stateDelta;
  return Number(right.process.createdAt ?? 0) - Number(left.process.createdAt ?? 0);
}

function taskStateWeight(state: CrewTaskState): number {
  switch (state) {
    case "waiting_hil": return 0;
    case "running": return 1;
    case "waiting_tool": return 2;
    case "queued": return 3;
    case "idle": return 4;
    default: return 5;
  }
}

function normalizedString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizedNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
