export type ChatAgentStatus = "online" | "idle" | "error" | "live";
export type ChatAgentTaskStatus = "running" | "idle" | "error";
export type ChatProcessStatusTone = "online" | "error" | "idle" | "update" | "live" | "warn";

export type ChatAgentTaskData = {
  name: string;
  status?: ChatAgentTaskStatus;
};

export type ChatModelProfileData = {
  id: string;
  name: string;
  values: Record<string, string>;
};

export type ChatAgentCrewData = {
  id?: string;
  processId?: string;
  runAs?: string;
  name: string;
  role?: string;
  imageSrc?: string;
  status?: ChatAgentStatus;
  statusLabel?: string;
  startable?: boolean;
  active?: boolean;
};

export type ChatAgentData = {
  id?: string;
  processId?: string;
  runAs?: string;
  name?: string;
  role?: string;
  description?: string;
  imageSrc?: string;
  status?: ChatAgentStatus;
  statusLabel?: string;
  activity?: string;
  modelLabel?: string;
  modelOptions?: readonly string[];
  modelProfiles?: readonly ChatModelProfileData[];
  modelValue?: string;
  modelIsDefault?: boolean;
  permission?: string;
  tasksTotal?: number;
  tasks?: readonly ChatAgentTaskData[];
  crew?: readonly ChatAgentCrewData[];
};

export type ChatAgentTaskView = {
  name: string;
  status: ChatAgentTaskStatus;
};

export type ChatAgentCrewView = {
  id: string;
  processId?: string;
  runAs?: string;
  name: string;
  role: string;
  imageSrc: string;
  status: ChatAgentStatus;
  statusLabel: string;
  startable: boolean;
  active: boolean;
};

export type ChatAgentSelection = {
  agentId?: string;
  processId?: string;
  runAs?: string;
};

export type ChatAgentViewModel = {
  id: string;
  processId: string;
  runAs: string;
  name: string;
  role: string;
  description: string;
  imageSrc: string;
  status: ChatAgentStatus;
  statusLabel: string;
  activity: string;
  modelLabel: string;
  modelOptions: string[];
  modelProfiles: ChatModelProfileData[];
  modelValue: string;
  modelIsDefault: boolean;
  permission: string;
  tasksTotal: number;
  tasks: ChatAgentTaskView[];
  crew: ChatAgentCrewView[];
  hasCrewData: boolean;
};

export type BuildChatAgentViewModelInput = {
  agent?: ChatAgentData | null;
  title: string;
  status: ChatProcessStatusTone;
  statusLabel: string;
  contextLabel: string;
};

const DEFAULT_AGENT_IMAGE = "/img/agent-0.png";

function cleanText(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  return text && text.length > 0 ? text : fallback;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function processToneToAgentStatus(status: ChatProcessStatusTone): ChatAgentStatus {
  if (status === "error") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  if (status === "live") {
    return "live";
  }
  return "online";
}

function processToneToTaskStatus(status: ChatProcessStatusTone): ChatAgentTaskStatus {
  if (status === "error") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  return "running";
}

function normalizeTasks(
  tasks: readonly ChatAgentTaskData[] | undefined,
  fallbackStatus: ChatAgentTaskStatus,
): ChatAgentTaskView[] {
  return (tasks ?? [])
    .map((task) => ({
      name: task.name.trim(),
      status: task.status ?? fallbackStatus,
    }))
    .filter((task) => task.name.length > 0);
}

function normalizeModelProfiles(
  profiles: readonly ChatModelProfileData[] | undefined,
): ChatModelProfileData[] {
  return (profiles ?? [])
    .map((profile) => {
      const id = profile.id.trim();
      const name = profile.name.trim();
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        values: { ...profile.values },
      };
    })
    .filter((profile): profile is ChatModelProfileData => profile !== null);
}

function buildDefaultDescription(input: {
  hasProcess: boolean;
  statusLabel: string;
  contextLabel: string;
}): string {
  if (!input.hasProcess) {
    return "No active GSV process is attached to this chat.";
  }

  const context = input.contextLabel.trim();
  const contextSentence = context && context !== "no history" ? ` ${context}.` : "";
  return `Process-backed chat session. Current state: ${input.statusLabel}.${contextSentence}`;
}

function normalizeCrew(
  crew: readonly ChatAgentCrewData[] | undefined,
  fallback: Omit<ChatAgentCrewView, "active">,
): { members: ChatAgentCrewView[]; hasCrewData: boolean } {
  const members = (crew ?? [])
    .map((member, index) => {
      const name = member.name.trim();
      if (!name) {
        return null;
      }
      const status = member.status ?? fallback.status;
      const processId = member.processId?.trim();
      const runAs = member.runAs?.trim();
      return {
        id: cleanText(member.id, `crew-${index}`),
        ...(processId ? { processId } : {}),
        ...(runAs ? { runAs } : {}),
        name,
        role: cleanText(member.role, fallback.role),
        imageSrc: cleanText(member.imageSrc, fallback.imageSrc),
        status,
        statusLabel: cleanText(member.statusLabel, status),
        startable: member.startable === true,
        active: member.active === true,
      };
    })
    .filter((member): member is ChatAgentCrewView => member !== null);

  if (members.length > 0) {
    return { members, hasCrewData: true };
  }

  return {
    members: [{ ...fallback, active: true, startable: false }],
    hasCrewData: false,
  };
}

export function buildChatAgentViewModel({
  agent,
  title,
  status,
  statusLabel,
  contextLabel,
}: BuildChatAgentViewModelInput): ChatAgentViewModel {
  const processTitle = cleanText(title, "Chat");
  const processStatusLabel = cleanText(statusLabel, "idle");
  const hasProcess = processStatusLabel !== "no process";
  const agentStatus = agent?.status ?? processToneToAgentStatus(status);
  const taskStatus = processToneToTaskStatus(status);
  const name = cleanText(agent?.name, processTitle);
  const role = cleanText(agent?.role, hasProcess ? "ACTIVE PROCESS" : "CHAT");
  const imageSrc = cleanText(agent?.imageSrc, DEFAULT_AGENT_IMAGE);
  const activity = cleanText(
    agent?.activity,
    hasProcess ? processStatusLabel : "No active process",
  );
  const tasks = normalizeTasks(
    agent?.tasks,
    taskStatus,
  );
  const tasksTotal = agent?.tasksTotal === undefined
    ? (agent?.tasks?.length ?? 0)
    : normalizeCount(agent.tasksTotal);

  const fallbackCrew = {
    id: agent?.id ?? "active-process",
    name,
    role,
    imageSrc,
    status: agentStatus,
    statusLabel: cleanText(agent?.statusLabel, processStatusLabel),
    startable: false,
  };
  const crew = normalizeCrew(agent?.crew, fallbackCrew);

  return {
    id: cleanText(agent?.id, ""),
    processId: cleanText(agent?.processId, ""),
    runAs: cleanText(agent?.runAs, ""),
    name,
    role,
    description: cleanText(
      agent?.description,
      buildDefaultDescription({
        hasProcess,
        statusLabel: processStatusLabel,
        contextLabel,
      }),
    ),
    imageSrc,
    status: agentStatus,
    statusLabel: cleanText(agent?.statusLabel, processStatusLabel),
    activity,
    modelLabel: cleanText(agent?.modelLabel, "GATEWAY DEFAULT"),
    modelOptions: normalizeModelOptions(agent?.modelOptions, agent?.modelLabel),
    modelProfiles: normalizeModelProfiles(agent?.modelProfiles),
    modelValue: cleanText(agent?.modelValue, ""),
    modelIsDefault: agent?.modelIsDefault ?? false,
    permission: cleanText(agent?.permission, "ask"),
    tasksTotal,
    tasks,
    crew: crew.members,
    hasCrewData: crew.hasCrewData,
  };
}

function normalizeModelOptions(
  options: readonly string[] | undefined,
  fallback: string | undefined,
): string[] {
  const normalized = (options ?? []).map((option) => option.trim()).filter(Boolean);
  if (normalized.length > 0) {
    return normalized;
  }
  const fallbackLabel = fallback?.trim();
  return fallbackLabel ? [fallbackLabel] : ["GATEWAY DEFAULT"];
}
