import type {
  ChatAgentCrewData,
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
  ConsoleProcess,
} from "../../gsv-console/domain/consoleModels";
import {
  defaultModelLabelForConfig,
  modelLabelsForConfig,
  modelProfilesForConfig,
} from "../../gsv-console/domain/consoleAi";
import {
  behaviorForAccount,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  modelLabelsForAccount,
} from "../../gsv-console/domain/consoleAgentBehavior";
import {
  agentImageSrcForIndex,
  isConsoleAgentAccount,
  labelForConsoleAccountRelation,
  sortedConsoleAccounts,
} from "../../gsv-console/domain/agentPresentation";

type BuildShellChatAgentArgs = {
  activeProcess: ChatProcessSummary | null;
  accounts: readonly ConsoleAccount[];
  chatProcesses: readonly ChatProcessSummary[];
  config: readonly ConsoleConfigEntry[];
  consoleProcesses: readonly ConsoleProcess[];
  selectedAgentId?: string | null;
  sessionUsername?: string;
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

function ownsChatProcess(account: ConsoleAccount, process: ChatProcessSummary): boolean {
  return process.uid === account.uid || process.username === account.username;
}

function ownsConsoleProcess(account: ConsoleAccount, process: ConsoleProcess): boolean {
  return process.uid === account.uid || process.username === account.username;
}

function isRunningChatProcess(process: ChatProcessSummary): boolean {
  return process.runState === "running";
}

function isQueuedChatProcess(process: ChatProcessSummary): boolean {
  return process.runState === "queued" || process.runState === "awaiting_hil";
}

function isRunningConsoleProcess(process: ConsoleProcess): boolean {
  return process.state === "running" || process.activeRunId !== null;
}

function isQueuedConsoleProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function agentStatusForRunState(runState?: string): ChatAgentStatus {
  if (runState === "running" || runState === "queued" || runState === "awaiting_hil") {
    return "live";
  }
  if (runState === "idle") {
    return "idle";
  }
  return "online";
}

function taskStatusForRunState(runState?: string): ChatAgentTaskStatus {
  return runState === "idle" ? "idle" : "running";
}

function processActivityTime(process: ChatProcessSummary): number {
  return process.lastActiveAt ?? process.createdAt;
}

function consoleProcessActivityTime(process: ConsoleProcess): number {
  return process.lastActiveAt ?? process.createdAt ?? 0;
}

function representativeProcess(
  processes: readonly ChatProcessSummary[],
  activeProcess: ChatProcessSummary | null,
): ChatProcessSummary | null {
  if (activeProcess && processes.some((process) => process.pid === activeProcess.pid)) {
    return activeProcess;
  }

  return [...processes].sort((left, right) => {
    const leftRank = isRunningChatProcess(left) ? 0 : isQueuedChatProcess(left) ? 1 : 2;
    const rightRank = isRunningChatProcess(right) ? 0 : isQueuedChatProcess(right) ? 1 : 2;
    return leftRank - rightRank || processActivityTime(right) - processActivityTime(left);
  })[0] ?? null;
}

function accountProcessStatus(input: {
  account: ConsoleAccount;
  chatProcesses: readonly ChatProcessSummary[];
  consoleProcesses: readonly ConsoleProcess[];
}): Pick<ChatAgentCrewData, "status" | "statusLabel"> {
  if (input.consoleProcesses.some((process) => process.state === "unknown")) {
    return { status: "error", statusLabel: "ERROR" };
  }
  if (input.chatProcesses.some(isQueuedChatProcess) || input.consoleProcesses.some(isQueuedConsoleProcess)) {
    return { status: "live", statusLabel: "QUEUED" };
  }
  if (input.chatProcesses.some(isRunningChatProcess) || input.consoleProcesses.some(isRunningConsoleProcess)) {
    return { status: "live", statusLabel: "RUNNING" };
  }
  if (input.account.runnable) {
    return { status: "idle", statusLabel: "IDLE" };
  }
  return { status: "idle", statusLabel: "ACCOUNT" };
}

function chatProcessTask(process: ChatProcessSummary): ChatAgentTaskData {
  const status = taskStatusForRunState(process.runState);
  const name = process.title;

  return { name, process, processId: process.pid, status };
}

function consoleRunState(process: ConsoleProcess): ChatProcessSummary["runState"] {
  if (process.activeRunId !== null || process.state === "running") {
    return "running";
  }
  if (process.queuedCount > 0 || process.state === "queued") {
    return "queued";
  }
  return "idle";
}

function chatProcessFromConsoleProcess(process: ConsoleProcess): ChatProcessSummary {
  return {
    pid: process.pid,
    uid: process.uid ?? 0,
    username: process.username,
    interactive: process.interactive,
    parentPid: process.parentPid,
    state: process.rawState || process.state,
    runState: consoleRunState(process),
    activeRunId: process.activeRunId,
    activeConversationId: process.activeConversationId,
    queuedCount: process.queuedCount,
    lastActiveAt: process.lastActiveAt,
    label: process.label,
    title: process.label || process.pid,
    createdAt: process.createdAt ?? 0,
    cwd: process.cwd,
    isDefaultConversation: false,
  };
}

function consoleTaskStatus(process: ConsoleProcess): ChatAgentTaskStatus {
  if (process.state === "unknown") {
    return "error";
  }
  if (isRunningConsoleProcess(process) || isQueuedConsoleProcess(process)) {
    return "running";
  }
  return "idle";
}

function consoleProcessTask(process: ConsoleProcess): ChatAgentTaskData {
  return {
    name: process.label || process.pid,
    process: chatProcessFromConsoleProcess(process),
    processId: process.pid,
    status: consoleTaskStatus(process),
  };
}

function consoleProcessRank(process: ConsoleProcess, activePid?: string): number {
  if (activePid && process.pid === activePid) return 0;
  if (process.state === "unknown") return 1;
  if (isRunningConsoleProcess(process)) return 2;
  if (isQueuedConsoleProcess(process)) return 3;
  return 4;
}

function sortConsoleProcesses(
  processes: readonly ConsoleProcess[],
  activePid?: string,
): ConsoleProcess[] {
  return [...processes].sort((left, right) => {
    const leftRank = consoleProcessRank(left, activePid);
    const rightRank = consoleProcessRank(right, activePid);
    return leftRank - rightRank
      || consoleProcessActivityTime(right) - consoleProcessActivityTime(left)
      || left.label.localeCompare(right.label);
  });
}

function processMatchesActiveIdentity(process: ConsoleProcess, activeProcess: ChatProcessSummary): boolean {
  return process.pid === activeProcess.pid
    || (process.username.length > 0 && process.username === activeProcess.username);
}

function tasksForActiveAgent(
  activeProcess: ChatProcessSummary,
  activeAccount: ConsoleAccount | null,
  chatProcesses: readonly ChatProcessSummary[],
  consoleProcesses: readonly ConsoleProcess[],
): ChatAgentTaskData[] {
  const ownedConsoleProcesses = activeAccount
    ? consoleProcesses.filter((process) => ownsConsoleProcess(activeAccount, process))
    : consoleProcesses.filter((process) => processMatchesActiveIdentity(process, activeProcess));
  const tasks = sortConsoleProcesses(ownedConsoleProcesses, activeProcess.pid).map(consoleProcessTask);
  const activeTaskPresent = tasks.some((task) => task.processId === activeProcess.pid);

  if (tasks.length > 0) {
    return activeTaskPresent ? tasks : [chatProcessTask(activeProcess), ...tasks];
  }

  const ownedChatProcesses = activeAccount
    ? chatProcesses.filter((process) => ownsChatProcess(activeAccount, process))
    : chatProcesses.filter((process) => process.pid === activeProcess.pid || ownsActiveChatIdentity(activeProcess, process));
  const chatTasks = [...ownedChatProcesses]
    .sort((left, right) => {
      const leftRank = left.pid === activeProcess.pid ? 0 : isRunningChatProcess(left) ? 1 : isQueuedChatProcess(left) ? 2 : 3;
      const rightRank = right.pid === activeProcess.pid ? 0 : isRunningChatProcess(right) ? 1 : isQueuedChatProcess(right) ? 2 : 3;
      return leftRank - rightRank || processActivityTime(right) - processActivityTime(left);
    })
    .map(chatProcessTask);

  return chatTasks.length > 0 ? chatTasks : [chatProcessTask(activeProcess)];
}

function ownsActiveChatIdentity(activeProcess: ChatProcessSummary, process: ChatProcessSummary): boolean {
  return process.username.length > 0 && process.username === activeProcess.username;
}

function tasksForAccount(processes: readonly ConsoleProcess[]): ChatAgentTaskData[] {
  return sortConsoleProcesses(processes).map(consoleProcessTask);
}

function accountAgentId(account: ConsoleAccount): string {
  return `account:${account.uid}`;
}

function accountRunAs(account: ConsoleAccount): string | undefined {
  return account.relation === "personal-agent" ? undefined : account.username;
}

function processCrewMember(
  process: ChatProcessSummary,
  index: number,
  activeProcess: ChatProcessSummary | null,
): ChatAgentCrewData {
  return {
    id: process.pid,
    processId: process.pid,
    name: process.title,
    role: process.username ? `PROCESS · ${process.username}` : "PROCESS",
    imageSrc: agentImageSrcForIndex(index),
    status: agentStatusForRunState(process.runState),
    statusLabel: process.runState.replaceAll("_", " ").toUpperCase(),
    active: process.pid === activeProcess?.pid,
  };
}

function accountCrewMembers(input: {
  accounts: readonly ConsoleAccount[];
  activeProcess: ChatProcessSummary | null;
  chatProcesses: readonly ChatProcessSummary[];
  consoleProcesses: readonly ConsoleProcess[];
  selectedAgentId?: string | null;
}): ChatAgentCrewData[] {
  const accounts = sortedConsoleAccounts(input.accounts).filter(isConsoleAgentAccount);
  const members = accounts.map((account, index) => {
    const id = accountAgentId(account);
    const ownedChatProcesses = input.chatProcesses.filter((process) => ownsChatProcess(account, process));
    const ownedConsoleProcesses = input.consoleProcesses.filter((process) => ownsConsoleProcess(account, process));
    const representative = representativeProcess(ownedChatProcesses, input.activeProcess);
    const status = accountProcessStatus({
      account,
      chatProcesses: ownedChatProcesses,
      consoleProcesses: ownedConsoleProcesses,
    });

    return {
      id,
      processId: representative?.pid,
      runAs: accountRunAs(account),
      name: account.displayName,
      role: labelForConsoleAccountRelation(account.relation),
      imageSrc: agentImageSrcForIndex(index),
      status: status.status,
      statusLabel: status.statusLabel,
      startable: account.runnable,
      active: input.activeProcess
        ? ownsChatProcess(account, input.activeProcess)
        : input.selectedAgentId === id,
    };
  });

  if (!input.activeProcess || members.some((member) => member.active)) {
    return members;
  }

  return [
    processCrewMember(input.activeProcess, members.length, input.activeProcess),
    ...members,
  ];
}

function accountForProcess(
  process: ChatProcessSummary,
  accounts: readonly ConsoleAccount[],
): ConsoleAccount | null {
  return accounts.find((account) => isConsoleAgentAccount(account) && ownsChatProcess(account, process)) ?? null;
}

function activeAgentDescription(
  activeProcess: ChatProcessSummary,
  activeAccount: ConsoleAccount | null,
): string {
  const accountDescription = activeAccount?.gecos.trim() || "";
  return [
    accountDescription,
    activeProcess.cwd,
    activeProcess.activeConversationId ? `conversation ${activeProcess.activeConversationId}` : "",
  ].filter(Boolean).join(" · ");
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
  const reasoning = behavior.reasoning.trim() || inheritedReasoningForAccount(config, account.uid, ownerUid);
  return {
    modelLabel: behavior.modelLabel || inheritedModelLabel,
    modelOptions: modelLabelsForAccount(modelLabels, behavior.modelLabel || modelValue, inheritedModelLabel),
    modelValue,
    modelIsDefault: modelValue.length === 0,
    reasoningLabel: formatChatReasoningLabel(reasoning),
    permission: behavior.permission,
  };
}

function defaultBehaviorView(config: readonly ConsoleConfigEntry[], modelLabels: readonly string[]): AgentBehaviorView {
  const modelLabel = defaultModelLabelForConfig(config);
  return {
    modelLabel,
    modelOptions: modelLabels.length > 0 ? [...modelLabels] : [modelLabel],
    modelValue: "",
    modelIsDefault: true,
    reasoningLabel: formatChatReasoningLabel(inheritedReasoningForAccount(config, -1, null)),
    permission: "ask",
  };
}

function viewerAccount(
  accounts: readonly ConsoleAccount[],
  sessionUsername?: string,
): ConsoleAccount | null {
  return accounts.find((account) => account.relation === "self")
    ?? accounts.find((account) => sessionUsername && account.username === sessionUsername)
    ?? accounts.find((account) => account.relation === "human")
    ?? accounts[0]
    ?? null;
}

function accountBackedAgent(input: {
  accounts: readonly ConsoleAccount[];
  chatProcesses: readonly ChatProcessSummary[];
  config: readonly ConsoleConfigEntry[];
  consoleProcesses: readonly ConsoleProcess[];
  modelLabels: readonly string[];
  modelProfiles: ReturnType<typeof modelProfilesForConfig>;
  ownerUid?: number | null;
  selectedAgentId?: string | null;
}): ChatAgentData | null {
  const accountList = sortedConsoleAccounts(input.accounts).filter(isConsoleAgentAccount);
  const selectedAccount = input.selectedAgentId
    ? accountList.find((account) => accountAgentId(account) === input.selectedAgentId) ?? null
    : null;
  const primaryAccount = selectedAccount
    ?? accountList.find((account) => account.runnable)
    ?? accountList[0]
    ?? null;
  if (!primaryAccount) {
    return null;
  }

  const primaryIndex = Math.max(0, accountList.findIndex((account) => account.uid === primaryAccount.uid));
  const ownedChatProcesses = input.chatProcesses.filter((process) => ownsChatProcess(primaryAccount, process));
  const ownedConsoleProcesses = input.consoleProcesses.filter((process) => ownsConsoleProcess(primaryAccount, process));
  const tasks = tasksForAccount(ownedConsoleProcesses);
  const status = accountProcessStatus({
    account: primaryAccount,
    chatProcesses: ownedChatProcesses,
    consoleProcesses: ownedConsoleProcesses,
  });
  const crew = accountCrewMembers({
    accounts: accountList,
    activeProcess: null,
    chatProcesses: input.chatProcesses,
    consoleProcesses: input.consoleProcesses,
    selectedAgentId: accountAgentId(primaryAccount),
  });
  const description = primaryAccount.gecos.trim()
    || "No active GSV process is attached to this chat.";
  const behavior = behaviorViewForAccount(primaryAccount, input.config, input.modelLabels, input.ownerUid);

  return {
    id: accountAgentId(primaryAccount),
    runAs: accountRunAs(primaryAccount),
    name: primaryAccount.displayName,
    role: labelForConsoleAccountRelation(primaryAccount.relation),
    description,
    imageSrc: agentImageSrcForIndex(primaryIndex),
    status: status.status,
    statusLabel: status.statusLabel,
    activity: status.statusLabel,
    modelLabel: behavior.modelLabel,
    modelOptions: behavior.modelOptions,
    modelProfiles: input.modelProfiles,
    modelValue: behavior.modelValue,
    modelIsDefault: behavior.modelIsDefault,
    reasoningLabel: behavior.reasoningLabel,
    permission: behavior.permission,
    tasksTotal: tasks.length,
    tasks,
    crew,
  };
}

export function buildShellChatAgent({
  activeProcess,
  accounts,
  chatProcesses,
  config,
  consoleProcesses,
  selectedAgentId,
  sessionUsername,
  statusLabel,
}: BuildShellChatAgentArgs): ChatAgentData | null {
  const modelLabels = modelLabelsForConfig(config);
  const viewer = viewerAccount(accounts, sessionUsername);
  const modelProfiles = modelProfilesForConfig(config, viewer?.uid);

  if (!activeProcess) {
    return accountBackedAgent({
      accounts,
      chatProcesses,
      config,
      consoleProcesses,
      modelLabels,
      modelProfiles,
      ownerUid: viewer?.uid,
      selectedAgentId,
    });
  }

  const accountList = sortedConsoleAccounts(accounts);
  const activeAccount = accountForProcess(activeProcess, accountList);
  const activeAccountIndex = activeAccount
    ? Math.max(0, accountList.findIndex((account) => account.uid === activeAccount.uid))
    : Math.max(0, chatProcesses.findIndex((process) => process.pid === activeProcess.pid));
  const tasks = tasksForActiveAgent(activeProcess, activeAccount, chatProcesses, consoleProcesses);
  const behavior = activeAccount
    ? behaviorViewForAccount(activeAccount, config, modelLabels, viewer?.uid)
    : defaultBehaviorView(config, modelLabels);
  const crew = accountList.length > 0
    ? accountCrewMembers({
        accounts: accountList,
        activeProcess,
        chatProcesses,
        consoleProcesses,
        selectedAgentId,
      })
    : chatProcesses.map((process, index) => processCrewMember(process, index, activeProcess));

  return {
    id: activeProcess.pid,
    processId: activeProcess.pid,
    runAs: activeAccount ? accountRunAs(activeAccount) : undefined,
    name: activeAccount?.displayName ?? activeProcess.title,
    role: activeAccount ? labelForConsoleAccountRelation(activeAccount.relation) : activeProcess.username ? `PROCESS · ${activeProcess.username}` : "PROCESS",
    description: activeAgentDescription(activeProcess, activeAccount),
    imageSrc: agentImageSrcForIndex(activeAccountIndex),
    status: agentStatusForRunState(activeProcess.runState),
    statusLabel,
    activity: statusLabel,
    modelLabel: behavior.modelLabel,
    modelOptions: behavior.modelOptions,
    modelProfiles,
    modelValue: behavior.modelValue,
    modelIsDefault: behavior.modelIsDefault,
    reasoningLabel: behavior.reasoningLabel,
    permission: behavior.permission,
    tasksTotal: tasks.length,
    tasks,
    crew,
  };
}
