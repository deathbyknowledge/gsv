/**
 * Personal agent accounts.
 *
 * Each human gets a 1:1 personal agent that is a real user account in the
 * Unix-like identity model: its own uid, its own private primary group
 * (gid = uid, User Private Group), and its own /home. The agent is the
 * run-as identity for the human's default conversation (and other processes
 * spawned without an explicit run-as), while the human remains the process
 * owner (routing, visibility, quotas).
 *
 * Bidirectional group membership wires the relationship:
 *   - the agent joins the human's private group (so it can act on the human's
 *     files), plus `users` for standard capabilities
 *   - the human joins the agent's private group (so the human can act on the
 *     agent's files and effectively "become" the agent)
 */

import type {
  AccountCreateArgs,
  AccountCreateResult,
  AccountKind,
  AccountListArgs,
  AccountListResult,
  AccountRelation,
  AccountSummary,
  ProcessIdentity,
} from "@gsv/protocol/syscalls/system";
import type { RequestFrame } from "../protocol/frames";
import { isLocked } from "../auth/shadow";
import { sendFrameToProcess } from "../shared/utils";
import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import type { ConversationRecord } from "./conversations";
import type { AuthStore } from "./auth-store";
import {
  accountIdentity,
  createAccount,
  isUsernameAvailable,
  normalizeAccountName,
} from "./accounts";
import { canOwnerRunAsAccount } from "./account-access";

/**
 * Curated, tasteful default names for the personal agent. The first available
 * (not already a username or group) is chosen when the user does not provide
 * one at setup.
 */
const AGENT_NAME_POOL = [
  "friday",
  "sol",
  "echo",
  "iris",
  "juno",
  "atlas",
  "mira",
  "nova",
  "vera",
  "ada",
];

export type PersonalAgentProvision = {
  identity: ProcessIdentity;
  created: boolean;
};

/**
 * Validate and normalize a user-supplied agent name. Returns null when the
 * name is malformed or already taken (caller may then fall back to a default).
 */
export function normalizeAgentName(auth: AuthStore, value: unknown): string | null {
  return normalizeAccountName(auth, value);
}

function pickAgentName(auth: AuthStore, preferred?: string): string {
  const normalizedPreferred = normalizeAgentName(auth, preferred);
  if (normalizedPreferred) return normalizedPreferred;

  for (const name of AGENT_NAME_POOL) {
    if (isUsernameAvailable(auth, name)) {
      return name;
    }
  }

  let suffix = 1;
  for (;;) {
    const name = `agent${suffix}`;
    if (isUsernameAvailable(auth, name)) {
      return name;
    }
    suffix += 1;
  }
}

/**
 * Ensure the human's 1:1 personal agent account exists, returning its run-as
 * identity. Idempotent: returns the existing account when already provisioned.
 */
export async function ensurePersonalAgent(
  ctx: KernelContext,
  human: ProcessIdentity,
  preferredName?: string,
): Promise<PersonalAgentProvision> {
  const { auth } = ctx;

  // System accounts (root, services; uid < 1000) and agent accounts themselves
  // do not get their own personal agent — their processes run as themselves.
  if (human.uid < 1000 || auth.isPersonalAgentUid(human.uid)) {
    return { identity: human, created: false };
  }

  const existingUid = auth.getPersonalAgentUid(human.uid);
  if (existingUid !== null) {
    const entry = auth.getPasswdByUid(existingUid);
    if (entry) {
      return { identity: accountIdentity(auth, entry), created: false };
    }
    // Stale mapping (account removed) — fall through and recreate.
  }

  const agentName = pickAgentName(auth, preferredName);
  return createAccount(ctx, {
    kind: "agent",
    username: agentName,
    gecos: `${human.username}'s agent`,
    ownerUid: human.uid,
    shared: true,
    crossMemberOwner: true,
    personalAgentOf: human.uid,
    persona: defaultPersonaContext(agentName, human.username),
  });
}

/**
 * Create an account on behalf of an authenticated caller. Humans are an
 * administrative action (root only); agents are owned by the caller's human.
 */
export async function handleAccountCreate(
  args: AccountCreateArgs,
  ctx: KernelContext,
): Promise<AccountCreateResult> {
  const { auth } = ctx;
  const caller = ctx.identity;
  if (!caller) {
    throw new Error("account.create requires an authenticated identity");
  }

  const kind: AccountKind = args.kind === "human" ? "human" : "agent";
  const name = normalizeAccountName(auth, args.username);
  if (!name) {
    throw new Error(`Invalid or unavailable username: ${String(args.username)}`);
  }

  if (kind === "human") {
    // Creating human accounts is an administrative action.
    if (!caller.capabilities.includes("*")) {
      throw new Error("Creating human accounts requires root");
    }
    const { identity } = await createAccount(ctx, {
      kind: "human",
      username: name,
      password: args.password,
      gecos: args.gecos?.trim() || undefined,
      shared: true,
    });
    const agent = await ensurePersonalAgent(ctx, identity);
    return { account: identity, kind, personalAgent: agent.identity };
  }

  const ownerUid = resolveCallerOwnerUid(ctx);
  const ownerName = auth.getPasswdByUid(ownerUid)?.username ?? "user";
  const persona = typeof args.persona === "string" && args.persona.trim()
    ? args.persona
    : defaultPersonaContext(name, ownerName);
  const { identity } = await createAccount(ctx, {
    kind: "agent",
    username: name,
    gecos: args.gecos?.trim() || `${ownerName}'s agent`,
    ownerUid,
    shared: true,
    crossMemberOwner: true,
    persona,
  });
  return { account: identity, kind };
}

/**
 * List the accounts the owning human may run processes as: their own account,
 * their personal agent, and any account whose private group they belong to
 * (custom agents, package agents). Root sees all accounts as runnable.
 */
export function handleAccountList(
  args: AccountListArgs,
  ctx: KernelContext,
): AccountListResult {
  const { auth } = ctx;
  const caller = ctx.identity!;
  const isRoot = caller.process.uid === 0;
  const ownerUid = isRoot && typeof args.uid === "number"
    ? args.uid
    : resolveCallerOwnerUid(ctx);
  const useRootRunAsBypass = isRoot && ownerUid === caller.process.uid;

  const personalAgentUid = auth.getPersonalAgentUid(ownerUid);

  const accounts: AccountSummary[] = [];
  for (const entry of auth.getPasswdEntries()) {
    // System accounts (root, services) are not run-as targets.
    if (entry.uid !== 0 && entry.uid < 1000) continue;

    if (!canOwnerRunAsAccount(auth, ownerUid, entry, useRootRunAsBypass)) continue;

    const shadow = auth.getShadowByUsername(entry.username);
    const isAgent = shadow ? isLocked(shadow) : false;
    const isSelf = entry.uid === ownerUid;
    const isPersonalAgent = personalAgentUid === entry.uid;
    let relation: AccountRelation;
    if (isSelf) relation = "self";
    else if (isPersonalAgent) relation = "personal-agent";
    else if (isAgent) relation = "agent";
    else relation = "human";

    accounts.push({
      uid: entry.uid,
      username: entry.username,
      displayName: entry.gecos?.trim() || entry.username,
      relation,
      runnable: true,
      ...(entry.gecos ? { gecos: entry.gecos } : {}),
    });
  }

  const relationRank: Record<AccountRelation, number> = {
    "self": 0,
    "personal-agent": 1,
    "agent": 2,
    "human": 3,
  };
  accounts.sort((a, b) => {
    const rank = relationRank[a.relation] - relationRank[b.relation];
    return rank !== 0 ? rank : a.username.localeCompare(b.username);
  });

  return { accounts };
}

function defaultPersonaContext(agentName: string, ownerUsername: string): string {
  return [
    "# Persona",
    "",
    `*You are **${agentName}**, the personal agent for ${ownerUsername}.*`,
    "",
    "This home is yours. Your context, knowledge, and memories live here and",
    "persist across sessions. The person you work for owns this process; their",
    "own context is layered in alongside yours.",
    "",
    "Grow into the role. Keep these files current. They are who you are.",
    "",
  ].join("\n");
}

/**
 * Allocate or reuse the executor (Process DO) servicing a conversation.
 *
 * The executor is a fungible, PID-like runtime slot: if a live one is already
 * bound to the conversation it is reused, otherwise a fresh uuid-named process
 * is spawned, bound (`active_pid`), and told which conversation it serves —
 * hydrating from the conversation's last archive when resuming. The durable
 * transcript lives in the agent home, so any executor can serve the same
 * conversation losslessly.
 */
export async function resolveConversationExecutor(
  ctx: KernelContext,
  conversation: ConversationRecord,
  agentIdentity: ProcessIdentity,
  opts?: { interactive?: boolean; label?: string },
): Promise<string> {
  const conversations = ctx.conversations;
  if (!conversations) {
    throw new Error("conversation registry unavailable");
  }

  if (conversation.activePid && ctx.procs.get(conversation.activePid)) {
    return conversation.activePid;
  }

  const interactive = opts?.interactive ?? true;
  const pid = `proc:${crypto.randomUUID()}`;
  ctx.procs.spawn(pid, agentIdentity, {
    ownerUid: conversation.ownerUid,
    interactive,
    label: opts?.label,
  });
  conversations.setActivePid(conversation.conversationId, pid);

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: agentIdentity,
      interactive,
      conversationId: conversation.conversationId,
      ...(conversation.latestArchive ? { hydrateFrom: conversation.latestArchive } : {}),
    },
  } as RequestFrame);

  return pid;
}

/**
 * Resolve the executor for a human's default ("inbox") conversation with their
 * personal agent — the stable surface that replaces the old `init:<owner>`
 * process. Provisions the agent account and the default conversation on first
 * use, then allocates/reuses a fungible executor for it.
 */
export async function ensureDefaultConversationExecutor(
  ctx: KernelContext,
  human: ProcessIdentity,
): Promise<string> {
  const conversations = ctx.conversations;
  if (!conversations) {
    throw new Error("conversation registry unavailable");
  }
  const agent = await ensurePersonalAgent(ctx, human);
  const { record } = conversations.ensureDefault(
    human.uid,
    agent.identity.uid,
    agent.identity.home,
  );
  return resolveConversationExecutor(ctx, record, agent.identity, {
    interactive: true,
    label: `${agent.identity.username} (${human.username})`,
  });
}
