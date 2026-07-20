import type { ConsoleAccount, ConsoleAccountRelation, ConsoleConfigEntry } from "./consoleModels";

const ACCOUNT_RELATION_LABEL: Record<ConsoleAccountRelation, string> = {
  self: "HUMAN (YOU)",
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

/** The human (the user) keeps the orb portrait; agents use the agent images. */
export const CREW_HUMAN_IMAGE = "/img/orb.png";

export function isHumanCrewAccount(account: ConsoleAccount): boolean {
  return account.relation === "self" || account.relation === "human";
}

/** Crew display order: humans first, then agents in their existing rank order. */
export function orderedCrewAccounts(accounts: readonly ConsoleAccount[]): ConsoleAccount[] {
  const sorted = sortedConsoleAccounts(accounts);
  return [
    ...sorted.filter(isHumanCrewAccount),
    ...sorted.filter((account) => !isHumanCrewAccount(account)),
  ];
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

/** Every agent portrait on disk. New agents draw from the full pool; the
 *  legacy position fallback (agentImageSrcForIndex) stays on the first 3 so
 *  pre-existing agents keep the portrait they've always shown. */
export const AGENT_IMAGE_POOL: readonly string[] = [
  "/img/agent-0.png",
  "/img/agent-1.png",
  "/img/agent-2.png",
  "/img/agent-3.png",
  "/img/agent-4.png",
];

/** config_kv key persisting an agent's fixed portrait (set at creation). */
export function avatarConfigKey(uid: number): string {
  return `users/${uid}/ui/avatar`;
}

/** Random portrait for a NEW agent: prefer images no current agent shows;
 *  once the pool is exhausted, any pool image may repeat. `random` is
 *  injectable for tests. */
export function pickAgentImage(
  usedSrcs: readonly string[],
  random: () => number = Math.random,
): string {
  const used = new Set(usedSrcs.filter((src) => AGENT_IMAGE_POOL.includes(src)));
  const candidates = AGENT_IMAGE_POOL.filter((src) => !used.has(src));
  const pool = candidates.length > 0 ? candidates : AGENT_IMAGE_POOL;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[Math.max(0, index)];
}

/** The portrait an account actually shows: orb for humans, the persisted
 *  `users/<uid>/ui/avatar` config value when set, else the legacy
 *  position-derived fallback (index among agent accounts, mod 3) so agents
 *  created before persistence keep their familiar face. */
export function avatarForAccount(
  account: ConsoleAccount,
  config: readonly ConsoleConfigEntry[],
  accounts: readonly ConsoleAccount[],
): string {
  if (isHumanCrewAccount(account)) return CREW_HUMAN_IMAGE;
  const stored = config.find((entry) => entry.key === avatarConfigKey(account.uid))?.value.trim();
  if (stored && AGENT_IMAGE_POOL.includes(stored)) return stored;
  const agentsOnly = sortedConsoleAccounts(accounts).filter(isConsoleAgentAccount);
  const index = agentsOnly.findIndex((candidate) => candidate.uid === account.uid);
  return agentImageSrcForIndex(Math.max(0, index));
}

/** Portraits currently in use by agent accounts (persisted or fallback) —
 *  the "used" set a new agent's random pick should avoid. */
export function usedAgentImages(
  accounts: readonly ConsoleAccount[],
  config: readonly ConsoleConfigEntry[],
): string[] {
  return sortedConsoleAccounts(accounts)
    .filter(isConsoleAgentAccount)
    .map((account) => avatarForAccount(account, config, accounts));
}
