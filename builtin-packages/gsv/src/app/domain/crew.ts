import { relationLabel, relationTone } from "../features/agents/agents-domain";
import { summarizePermissions, type PermissionSummary } from "../features/agents/permissions-domain";
import type { AgentDetail, AgentModelProfile } from "../features/agents/types";
import { processState, processStateTone, processTitle } from "../features/runtime/runtime-domain";
import type { ProcessEntry } from "../features/runtime/types";
import {
  modelProfileMatches,
  profileValuesFromDrafts,
} from "../features/settings/model-profiles-domain";

const CHAT_PROVIDER_KEY = "config/ai/provider";
const CHAT_MODEL_KEY = "config/ai/model";
const CHAT_REASONING_KEY = "config/ai/reasoning";
const MAX_TOKENS_KEY = "config/ai/max_tokens";
const MAX_CONTEXT_KEY = "config/ai/max_context_bytes";

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
  permissions: PermissionSummary;
  tone: "accent" | "good" | "neutral";
  tasks: CrewTask[];
  activeTasks: CrewTask[];
  agent: AgentDetail;
};

export type CrewStackCard = {
  id: string;
  label: string;
  provider: string;
  model: string;
  reasoning: string;
  maxTokens: string;
  maxContext: string;
  detail: string;
  default: boolean;
  profile?: AgentModelProfile;
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
  profiles: AgentModelProfile[],
  systemAiValues: Record<string, string> = {},
): CrewAgent[] {
  const tasks = buildCrewTasks(processes);

  return agents.map((agent) => {
    const agentTasks = tasks.filter((task) => taskBelongsToAgent(task, agent));
    const stack = agentStackSummary(agent, profiles, systemAiValues);
    return {
      uid: agent.uid,
      username: agent.username,
      displayName: agent.displayName,
      roleLabel: relationLabel(agent.relation),
      description: agentDescription(agent),
      modelLabel: stack.label,
      modelDetail: stack.detail,
      permissions: summarizePermissions(agent.approval, agent.configEditable),
      tone: relationTone(agent.relation),
      tasks: agentTasks,
      activeTasks: agentTasks.filter((task) => task.state !== "idle"),
      agent,
    };
  });
}

export function buildCrewStackCards(
  systemAiValues: Record<string, string>,
  profiles: AgentModelProfile[],
): CrewStackCard[] {
  const systemValues = profileValuesFromDrafts(systemAiValues);
  return [
    {
      id: "system-default",
      label: `${modelDisplayLabel(aiValue(systemValues, CHAT_MODEL_KEY, "System model"))} (Default)`,
      provider: aiValue(systemValues, CHAT_PROVIDER_KEY, "provider"),
      model: aiValue(systemValues, CHAT_MODEL_KEY, "System default"),
      reasoning: aiValue(systemValues, CHAT_REASONING_KEY, "medium"),
      maxTokens: aiValue(systemValues, MAX_TOKENS_KEY, "default"),
      maxContext: aiValue(systemValues, MAX_CONTEXT_KEY, "default"),
      detail: stackDetail(systemValues),
      default: true,
    },
    ...profiles.map((profile) => {
      const values = profileValuesFromDrafts(profile.values);
      return {
        id: profile.id,
        label: profile.name,
        provider: aiValue(values, CHAT_PROVIDER_KEY, "provider"),
        model: aiValue(values, CHAT_MODEL_KEY, "model"),
        reasoning: aiValue(values, CHAT_REASONING_KEY, "default"),
        maxTokens: aiValue(values, MAX_TOKENS_KEY, "default"),
        maxContext: aiValue(values, MAX_CONTEXT_KEY, "default"),
        detail: stackDetail(values),
        default: false,
        profile,
      };
    }),
  ];
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

export function findMatchingStackProfile(
  profiles: AgentModelProfile[],
  values: Record<string, string>,
): AgentModelProfile | null {
  const normalized = profileValuesFromDrafts(values);
  return profiles.find((profile) => modelProfileMatches(profile, normalized)) ?? null;
}

export function stackDetail(values: Record<string, string>): string {
  const provider = aiValue(values, CHAT_PROVIDER_KEY, "provider");
  const model = aiValue(values, CHAT_MODEL_KEY, "model");
  const reasoning = aiValue(values, CHAT_REASONING_KEY, "default");
  return `${provider} / ${shortModelName(model)} / reasoning ${reasoning}`;
}

export function shortModelName(value: string): string {
  const normalized = normalizedString(value);
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("@cf/")) {
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  return normalized;
}

function agentStackSummary(
  agent: AgentDetail,
  profiles: AgentModelProfile[],
  systemAiValues: Record<string, string>,
): { label: string; detail: string } {
  if (Object.keys(agent.aiValues).length === 0) {
    return {
      label: "At default",
      detail: stackDetail(profileValuesFromDrafts(systemAiValues)),
    };
  }

  const matched = findMatchingStackProfile(profiles, agent.aiValues);
  if (matched) {
    return {
      label: matched.name,
      detail: stackDetail(matched.values),
    };
  }

  return {
    label: "Custom preset",
    detail: stackDetail(profileValuesFromDrafts(agent.effectiveAiValues)),
  };
}

function aiValue(values: Record<string, string>, key: string, fallback: string): string {
  const value = normalizedString(values[key]);
  return value || fallback;
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
