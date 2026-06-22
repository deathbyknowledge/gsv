import type { ConsoleAccount, ConsoleAccountRelation } from "./consoleModels";

const ACCOUNT_RELATION_LABEL: Record<ConsoleAccountRelation, string> = {
  self: "OPERATOR",
  "personal-agent": "PERSONAL AGENT",
  agent: "AGENT",
  human: "HUMAN",
  unknown: "ACCOUNT",
};

export function labelForConsoleAccountRelation(relation: ConsoleAccountRelation): string {
  return ACCOUNT_RELATION_LABEL[relation];
}

export function isConsoleAgentAccount(account: ConsoleAccount): boolean {
  return account.relation === "personal-agent" || account.relation === "agent";
}

export function rankConsoleAccount(account: ConsoleAccount): number {
  if (account.relation === "personal-agent") return 0;
  if (account.relation === "agent") return 1;
  if (account.relation === "self") return 2;
  if (account.relation === "human") return 3;
  return 4;
}

export function compareConsoleAccounts(left: ConsoleAccount, right: ConsoleAccount): number {
  return rankConsoleAccount(left) - rankConsoleAccount(right)
    || Number(right.runnable) - Number(left.runnable)
    || left.username.localeCompare(right.username);
}

export function sortedConsoleAccounts(accounts: readonly ConsoleAccount[]): ConsoleAccount[] {
  return [...accounts].sort(compareConsoleAccounts);
}

export function agentImageSrcForIndex(index: number): string {
  return `/img/agent-${Math.max(0, index) % 3}.png`;
}

export function agentImageSrcForAccount(
  account: ConsoleAccount,
  accounts: readonly ConsoleAccount[],
): string {
  const index = sortedConsoleAccounts(accounts).findIndex((candidate) => candidate.uid === account.uid);
  return agentImageSrcForIndex(index);
}
