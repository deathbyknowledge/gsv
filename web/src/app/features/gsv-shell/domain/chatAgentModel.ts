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
  ConsoleAccountRelation,
  ConsoleProcess,
} from "../../gsv-console/domain/consoleModels";

type BuildShellChatAgentArgs = {
  activeProcess: ChatProcessSummary | null;
  accounts: readonly ConsoleAccount[];
  chatProcesses: readonly ChatProcessSummary[];
  consoleProcesses: readonly ConsoleProcess[];
  modelLabel: string;
  statusLabel: string;
};

const RELATION_LABEL: Record<ConsoleAccountRelation, string> = {
  self: "OPERATOR",
  "personal-agent": "PERSONAL AGENT",
  agent: "AGENT",
  human: "HUMAN",
  unknown: "ACCOUNT",
};

function processImageSrc(index: number): string {
  return `/img/agent-${index % 3}.png`;
}

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

function accountRank(account: ConsoleAccount): number {
  if (account.relation === "personal-agent") return 0;
  if (account.relation === "agent") return 1;
  if (account.relation === "self") return 2;
  if (account.relation === "human") return 3;
  return 4;
}

function sortedAccounts(accounts: readonly ConsoleAccount[]): ConsoleAccount[] {
  return [...accounts].sort((left, right) => (
    accountRank(left) - accountRank(right)
    || Number(right.runnable) - Number(left.runnable)
    || left.username.localeCompare(right.username)
  ));
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
    imageSrc: processImageSrc(index),
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
}): ChatAgentCrewData[] {
  const accounts = sortedAccounts(input.accounts);
  const members = accounts.map((account, index) => {
    const ownedChatProcesses = input.chatProcesses.filter((process) => ownsChatProcess(account, process));
    const ownedConsoleProcesses = input.consoleProcesses.filter((process) => ownsConsoleProcess(account, process));
    const representative = representativeProcess(ownedChatProcesses, input.activeProcess);
    const status = accountProcessStatus({
      account,
      chatProcesses: ownedChatProcesses,
      consoleProcesses: ownedConsoleProcesses,
    });

    return {
      id: `account:${account.uid}`,
      processId: representative?.pid,
      name: account.displayName,
      role: RELATION_LABEL[account.relation],
      imageSrc: processImageSrc(index),
      status: status.status,
      statusLabel: status.statusLabel,
      active: input.activeProcess ? ownsChatProcess(account, input.activeProcess) : false,
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

function accountBackedAgent(input: {
  accounts: readonly ConsoleAccount[];
  chatProcesses: readonly ChatProcessSummary[];
  consoleProcesses: readonly ConsoleProcess[];
  modelLabel: string;
}): ChatAgentData | null {
  const accountList = sortedAccounts(input.accounts);
  const primaryAccount = accountList.find((account) => account.runnable) ?? accountList[0] ?? null;
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
  });
  const description = primaryAccount.gecos.trim()
    || "No active GSV process is attached to this chat.";

  return {
    name: primaryAccount.displayName,
    role: RELATION_LABEL[primaryAccount.relation],
    description,
    imageSrc: processImageSrc(primaryIndex),
    status: status.status,
    statusLabel: status.statusLabel,
    activity: status.statusLabel,
    modelLabel: input.modelLabel,
    modelIsDefault: true,
    tasksTotal: 0,
    tasks: [],
    crew,
  };
}

export function buildShellChatAgent({
  activeProcess,
  accounts,
  chatProcesses,
  consoleProcesses,
  modelLabel,
  statusLabel,
}: BuildShellChatAgentArgs): ChatAgentData | null {
  if (!activeProcess) {
    return accountBackedAgent({
      accounts,
      chatProcesses,
      consoleProcesses,
      modelLabel,
    });
  }

  const accountList = sortedAccounts(accounts);
  const activeAccount = accountForProcess(activeProcess, accountList);
  const activeAccountIndex = activeAccount
    ? Math.max(0, accountList.findIndex((account) => account.uid === activeAccount.uid))
    : Math.max(0, chatProcesses.findIndex((process) => process.pid === activeProcess.pid));
  const tasks = tasksForActiveAgent(activeProcess, activeAccount, chatProcesses);
  const crew = accountList.length > 0
    ? accountCrewMembers({
        accounts: accountList,
        activeProcess,
        chatProcesses,
        consoleProcesses,
      })
    : chatProcesses.map((process, index) => processCrewMember(process, index, activeProcess));

  return {
    id: activeProcess.pid,
    name: activeAccount?.displayName ?? activeProcess.title,
    role: activeAccount ? RELATION_LABEL[activeAccount.relation] : activeProcess.username ? `PROCESS · ${activeProcess.username}` : "PROCESS",
    description: activeAgentDescription(activeProcess, activeAccount),
    imageSrc: processImageSrc(activeAccountIndex),
    status: agentStatusForRunState(activeProcess.runState),
    statusLabel,
    activity: statusLabel,
    modelLabel,
    tasksTotal: tasks.length,
    tasks,
    crew,
  };
}
