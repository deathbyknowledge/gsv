import type {
  ChatAgentData,
  ChatAgentStatus,
  ChatAgentTaskData,
  ChatAgentTaskStatus,
} from "../../chat/domain";
import { formatChatReasoningLabel } from "../../chat/domain";
import type { ChatProcessSummary } from "../../chat/domain/processes";
import type {
  ConsoleAccount,
  ConsoleConfigEntry,
} from "../../gsv-console/domain/consoleModels";
import {
  aiProviderDisplayLabel,
  fixedAiProviderModel,
} from "../../../domain/aiProviders";
import {
  defaultModelLabelForConfig,
  modelLabelsForConfig,
  modelProfilesForConfig,
} from "../../gsv-console/domain/consoleAi";
import { effectiveAiValuesForViewer } from "../../gsv-console/domain/consoleSettings";
import {
  behaviorForAccount,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  modelLabelsForAccount,
} from "../../gsv-console/domain/consoleAgentBehavior";
import {
  agentImageSrcForIndex,
  avatarForAccount,
  labelForConsoleAccountRelation,
} from "../../gsv-console/domain/agentPresentation";

type BuildShellChatAgentArgs = {
  activeProcess: ChatProcessSummary | null;
  accounts: readonly ConsoleAccount[];
  chatProcesses: readonly ChatProcessSummary[];
  config: readonly ConsoleConfigEntry[];
  ownerUid: number | null;
  statusLabel: string;
};

type AgentBehaviorView = {
  modelLabel: string;
  modelOptions: string[];
  modelValue: string;
  modelIsDefault: boolean;
  reasoningLabel: string;
  permission: string;
};

function agentStatusForProcess(process: ChatProcessSummary | null): ChatAgentStatus {
  if (process?.state === "unknown") {
    return "error";
  }
  const runState = process?.runState;
  if (runState === "running" || runState === "queued" || runState === "awaiting_hil") {
    return "live";
  }
  return "idle";
}

function taskStatusForProcess(process: ChatProcessSummary): ChatAgentTaskStatus {
  if (process.state === "unknown") {
    return "error";
  }
  return process.runState === "idle" ? "idle" : "running";
}

function processActivityTime(process: ChatProcessSummary): number {
  return process.lastActiveAt ?? process.createdAt;
}

function chatProcessTask(process: ChatProcessSummary): ChatAgentTaskData {
  return {
    name: process.title,
    process,
    processId: process.pid,
    status: taskStatusForProcess(process),
  };
}

function taskRank(process: ChatProcessSummary, activePid?: string): number {
  if (activePid && process.pid === activePid) return 0;
  if (process.runState === "running") return 1;
  if (process.runState === "queued" || process.runState === "awaiting_hil") return 2;
  return 3;
}

function visibleProcesses(
  chatProcesses: readonly ChatProcessSummary[],
  activeProcess: ChatProcessSummary | null,
  ownerUid: number | null,
): ChatProcessSummary[] {
  const byPid = new Map(chatProcesses.map((process) => [process.pid, process]));
  if (activeProcess && activeProcess.uid === ownerUid && !byPid.has(activeProcess.pid)) {
    byPid.set(activeProcess.pid, activeProcess);
  }
  return [...byPid.values()].filter(
    (process) => process.uid === ownerUid && !process.personal,
  ).sort((left, right) => {
    return taskRank(left, activeProcess?.pid) - taskRank(right, activeProcess?.pid)
      || processActivityTime(right) - processActivityTime(left)
      || left.title.localeCompare(right.title);
  });
}

function behaviorViewForAccount(
  account: ConsoleAccount,
  config: readonly ConsoleConfigEntry[],
  modelLabels: readonly string[],
  ownerUid?: number | null,
): AgentBehaviorView {
  const behavior = behaviorForAccount(config, account.uid, ownerUid);
  const modelValue = behavior.model.trim();
  const inheritedModelLabel = inheritedModelLabelForAccount(config, account.uid, ownerUid);
  const effectiveValues = effectiveAiValuesForViewer(config, account.uid);
  const fixedModel = fixedAiProviderModel(effectiveValues["config/ai/provider"] ?? "");
  const includedLabel = !modelValue && fixedModel === effectiveValues["config/ai/model"]
    ? aiProviderDisplayLabel(effectiveValues["config/ai/provider"] ?? "")
    : "";
  const visibleModelLabels = includedLabel
    ? modelLabels.map((label) => label === fixedModel ? includedLabel : label)
    : modelLabels;
  const reasoning = behavior.reasoning.trim() || inheritedReasoningForAccount(config, account.uid, ownerUid);
  return {
    modelLabel: includedLabel || behavior.modelLabel || inheritedModelLabel,
    modelOptions: modelLabelsForAccount(
      visibleModelLabels,
      behavior.modelLabel || modelValue,
      includedLabel || inheritedModelLabel,
    ),
    modelValue,
    modelIsDefault: modelValue.length === 0,
    reasoningLabel: formatChatReasoningLabel(reasoning),
    permission: behavior.permission,
  };
}

function defaultBehaviorView(
  config: readonly ConsoleConfigEntry[],
  modelLabels: readonly string[],
): AgentBehaviorView {
  const values = effectiveAiValuesForViewer(config, null);
  const fixedModel = fixedAiProviderModel(values["config/ai/provider"] ?? "");
  const modelLabel = fixedModel === values["config/ai/model"]
    ? aiProviderDisplayLabel(values["config/ai/provider"] ?? "")
    : defaultModelLabelForConfig(config);
  const visibleModelLabels = fixedModel
    ? modelLabels.map((label) => label === fixedModel ? modelLabel : label)
    : modelLabels;
  return {
    modelLabel,
    modelOptions: visibleModelLabels.length > 0 ? [...visibleModelLabels] : [modelLabel],
    modelValue: "",
    modelIsDefault: true,
    reasoningLabel: formatChatReasoningLabel(inheritedReasoningForAccount(config, -1, null)),
    permission: "ask",
  };
}

function viewerAccount(
  accounts: readonly ConsoleAccount[],
  ownerUid: number | null,
): ConsoleAccount | null {
  if (ownerUid === null) {
    return null;
  }
  return accounts.find((account) => account.uid === ownerUid) ?? null;
}

export function buildShellChatAgent({
  activeProcess,
  accounts,
  chatProcesses,
  config,
  ownerUid,
  statusLabel,
}: BuildShellChatAgentArgs): ChatAgentData {
  const ownedActiveProcess = activeProcess?.uid === ownerUid ? activeProcess : null;
  const personalAccount = ownerUid === null
    ? null
    : accounts.find((account) => account.relation === "personal-agent") ?? null;
  const viewer = viewerAccount(accounts, ownerUid);
  const modelLabels = modelLabelsForConfig(config);
  if (!personalAccount) {
    const behavior = defaultBehaviorView(config, modelLabels);
    return {
      id: "administration",
      ...(ownedActiveProcess ? { processId: ownedActiveProcess.pid } : {}),
      name: "Administration",
      role: "NO PERSONAL INTELLIGENCE",
      description: "This account does not have a personal intelligence.",
      imageSrc: agentImageSrcForIndex(0),
      status: agentStatusForProcess(ownedActiveProcess),
      statusLabel: ownedActiveProcess ? statusLabel : "unavailable",
      activity: ownedActiveProcess ? statusLabel : "Personal intelligence unavailable",
      modelLabel: behavior.modelLabel,
      modelOptions: behavior.modelOptions,
      modelProfiles: modelProfilesForConfig(config, viewer?.uid),
      modelValue: behavior.modelValue,
      modelIsDefault: behavior.modelIsDefault,
      reasoningLabel: behavior.reasoningLabel,
      permission: behavior.permission,
      tasksTotal: 0,
      tasks: [],
      crew: [],
      canStartWork: false,
    };
  }
  const activeRunAsAccount = ownedActiveProcess && !ownedActiveProcess.personal
    ? accounts.find((account) => account.username === ownedActiveProcess.username) ?? null
    : null;
  const behaviorAccount = activeRunAsAccount ?? personalAccount;
  const behavior = behaviorAccount
    ? behaviorViewForAccount(behaviorAccount, config, modelLabels, viewer?.uid)
    : defaultBehaviorView(config, modelLabels);
  const processes = visibleProcesses(
    chatProcesses,
    ownedActiveProcess,
    ownerUid,
  );
  const tasks = processes.map(chatProcessTask);

  return {
    id: personalAccount ? `account:${personalAccount.uid}` : "personal-intelligence",
    ...(ownedActiveProcess ? { processId: ownedActiveProcess.pid } : {}),
    name: personalAccount?.displayName ?? "Personal intelligence",
    role: personalAccount
      ? labelForConsoleAccountRelation(personalAccount.relation)
      : "PERSONAL INTELLIGENCE",
    description: personalAccount?.gecos.trim()
      || "Your personal intelligence and its active work.",
    imageSrc: personalAccount
      ? avatarForAccount(personalAccount, config, accounts)
      : agentImageSrcForIndex(0),
    status: agentStatusForProcess(ownedActiveProcess),
    statusLabel,
    activity: statusLabel,
    modelLabel: behavior.modelLabel,
    modelOptions: behavior.modelOptions,
    modelProfiles: modelProfilesForConfig(config, viewer?.uid),
    modelValue: behavior.modelValue,
    modelIsDefault: behavior.modelIsDefault,
    reasoningLabel: behavior.reasoningLabel,
    permission: behavior.permission,
    tasksTotal: tasks.length,
    tasks,
    crew: [],
    canStartWork: true,
  };
}
