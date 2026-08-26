import type { ChatProcessSummary } from "../../chat/domain/processes";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";

export function selectPersonalChatProcess(
  processes: readonly ChatProcessSummary[],
  ownerUid: number | null,
  preferredPid?: string | null,
): ChatProcessSummary | null {
  if (ownerUid === null) {
    return null;
  }
  const personalProcesses = processes.filter(
    (process) => process.personal && process.uid === ownerUid,
  );
  if (personalProcesses.length !== 1) {
    return null;
  }

  return personalProcesses.find(
    (process) => !preferredPid || process.pid === preferredPid,
  ) ?? personalProcesses[0];
}

export function resolveChatViewerUid(
  accounts: readonly ConsoleAccount[],
  sessionUsername: string,
): number | null {
  const username = sessionUsername.trim();
  const self = accounts.find((account) => account.relation === "self") ?? null;
  if (self) {
    return !username || self.username === username ? self.uid : null;
  }
  return accounts.find((account) => username && account.username === username)?.uid ?? null;
}

export function selectWorkSessionProcess(
  processes: readonly ChatProcessSummary[],
  processId: string | null,
  ownerUid: number | null,
  pendingProcess?: ChatProcessSummary | null,
): ChatProcessSummary | null {
  if (!processId || ownerUid === null) {
    return null;
  }

  const listed = processes.find((process) => process.pid === processId) ?? null;
  if (listed && (listed.personal || listed.uid !== ownerUid)) {
    return null;
  }
  if (listed) {
    return listed;
  }
  return pendingProcess?.pid === processId
    && pendingProcess.uid === ownerUid
    && !pendingProcess.personal
    ? pendingProcess
    : null;
}

export function resolveChatProcessTargets(input: {
  ownerUid: number | null;
  pendingProcess?: ChatProcessSummary | null;
  personalPid?: string | null;
  processes: readonly ChatProcessSummary[];
  workSessionPid?: string | null;
}) {
  const personalProcess = selectPersonalChatProcess(
    input.processes,
    input.ownerUid,
    input.personalPid,
  );
  const requestedProcess = input.workSessionPid
    ? input.processes.find((process) => process.pid === input.workSessionPid) ?? null
    : null;
  const workSessionProcess = selectWorkSessionProcess(
    input.processes,
    input.workSessionPid ?? null,
    input.ownerUid,
    input.pendingProcess,
  );
  const targetedProcess = requestedProcess === workSessionProcess
    ? requestedProcess
    : null;
  const workSessionActive = workSessionProcess !== null;
  return {
    activeProcess: workSessionActive ? workSessionProcess : personalProcess,
    personalProcess,
    targetedProcess,
    workSessionActive,
    workSessionProcess,
  };
}
