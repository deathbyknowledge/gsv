/**
 * Personal agent accounts.
 *
 * Each human gets a 1:1 personal agent that is a real user account in the
 * Unix-like identity model: its own uid, its own private primary group
 * (gid = uid, User Private Group), and its own /home. The agent is the
 * run-as identity for the human's persistent `init` process, while the human
 * remains the process owner (routing, visibility, quotas).
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
import type { AuthStore } from "./auth-store";
import {
  accountIdentity,
  createAccount,
  isUsernameAvailable,
  normalizeAccountName,
} from "./accounts";

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
    gecos: `${ownerName}'s agent`,
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

  const ownerName = auth.getPasswdByUid(ownerUid)?.username ?? null;
  const personalAgentUid = auth.getPersonalAgentUid(ownerUid);

  const accounts: AccountSummary[] = [];
  for (const entry of auth.getPasswdEntries()) {
    // System accounts (root, services) are not run-as targets.
    if (entry.uid !== 0 && entry.uid < 1000) continue;

    const isSelf = entry.uid === ownerUid;
    const isPersonalAgent = personalAgentUid === entry.uid;
    const group = auth.getGroupByGid(entry.gid);
    const isGroupMember = !!ownerName && !!group && group.members.includes(ownerName);
    const runnable = isRoot || isSelf || isPersonalAgent || isGroupMember;
    if (!runnable) continue;

    const shadow = auth.getShadowByUsername(entry.username);
    const isAgent = shadow ? isLocked(shadow) : false;
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
      runnable,
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

/**
 * The human that owns the caller's processes: the process owner_uid when called
 * from inside a process, otherwise the connecting identity's uid.
 */
function resolveCallerOwnerUid(ctx: KernelContext): number {
  if (ctx.processId) {
    const ownerUid = ctx.procs.getOwnerUid(ctx.processId);
    if (ownerUid != null) return ownerUid;
  }
  return ctx.identity!.process.uid;
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
 * Ensure the human's persistent `init` process exists, running as their
 * personal agent. Provisions the agent account on first use. Returns the pid
 * (always `init:{ownerUid}`).
 */
export async function ensurePersonalInitProcess(
  ctx: KernelContext,
  human: ProcessIdentity,
): Promise<string> {
  const agent = await ensurePersonalAgent(ctx, human);
  const { pid, created } = ctx.procs.ensureInit(human.uid, agent.identity);

  if (created) {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { pid, identity: agent.identity, profile: "init" },
    } as RequestFrame);
  }

  return pid;
}
