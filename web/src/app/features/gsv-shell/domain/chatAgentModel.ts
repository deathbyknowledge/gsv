import type {
  ChatAgentCrewData,
  ChatAgentData,
  ChatAgentStatus,
  ChatAgentTaskData,
  ChatAgentTaskStatus,
} from "../../chat/domain";
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
  modelLabelsForAccount,
} from "../../gsv-console/domain/consoleAgentBehavior";
import {
  agentImageSrcForIndex,
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
  const name = process.activeRunId
    ? `Run ${process.activeRunId.slice(0, 8)}`
    : process.queuedCount > 0
      ? `${process.queuedCount} queued`
      : process.title;

  return { name, status };
}

function tasksForActiveAgent(
  activeProcess: ChatProcessSummary,
  activeAccount: ConsoleAccount | null,
  chatProcesses: readonly ChatProcessSummary[],
): ChatAgentTaskData[] {
  const ownedProcesses = activeAccount
    ? chatProcesses.filter((process) => ownsChatProcess(activeAccount, process))
    : [activeProcess];
  const tasks = ownedProcesses
    .filter((process) => process.activeRunId || process.queuedCount > 0 || process.pid === activeProcess.pid)
    .slice(0, 5)
    .map(chatProcessTask);

  return tasks.length > 0 ? tasks : [chatProcessTask(activeProcess)];
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
  const accounts = sortedConsoleAccounts(input.accounts);
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
  return accounts.find((account) => ownsChatProcess(account, process)) ?? null;
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
): AgentBehaviorView {
  const behavior = behaviorForAccount(config, account.uid);
  const modelValue = behavior.model.trim();
  return {
    modelLabel: modelValue || defaultModelLabelForConfig(config),
    modelOptions: modelLabelsForAccount(modelLabels, modelValue),
    modelValue,
    modelIsDefault: modelValue.length === 0,
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
  selectedAgentId?: string | null;
}): ChatAgentData | null {
  const accountList = sortedConsoleAccounts(input.accounts);
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
  const behavior = behaviorViewForAccount(primaryAccount, input.config, input.modelLabels);

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
    permission: behavior.permission,
    tasksTotal: 0,
    tasks: [],
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
      selectedAgentId,
    });
  }

  const accountList = sortedConsoleAccounts(accounts);
  const activeAccount = accountForProcess(activeProcess, accountList);
  const activeAccountIndex = activeAccount
    ? Math.max(0, accountList.findIndex((account) => account.uid === activeAccount.uid))
    : Math.max(0, chatProcesses.findIndex((process) => process.pid === activeProcess.pid));
  const tasks = tasksForActiveAgent(activeProcess, activeAccount, chatProcesses);
  const behavior = activeAccount
    ? behaviorViewForAccount(activeAccount, config, modelLabels)
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
    permission: behavior.permission,
    tasksTotal: tasks.length,
    tasks,
    crew,
  };
}
