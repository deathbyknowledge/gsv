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
} from "@humansandmachines/gsv/protocol";
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
import { ensureAccountHomeLayout } from "./account-home";
import { DEFAULT_PERSONA_CONTEXT_TEMPLATE } from "../prompts/persona";

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

type AccountContextFile = { name: string; text: string };

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

function legacyPersonalAgentDisplayName(ownerUsername: string): string {
  return `${ownerUsername}'s agent`;
}

function reconcilePersonalAgentDisplayName(
  auth: AuthStore,
  entry: { username: string; uid: number; gecos: string },
  human: ProcessIdentity,
): { username: string; uid: number; gid: number; gecos: string; home: string; shell: string } | null {
  const displayName = typeof entry.gecos === "string" ? entry.gecos.trim() : "";
  if (displayName !== legacyPersonalAgentDisplayName(human.username)) {
    return auth.getPasswdByUid(entry.uid);
  }
  auth.updateUser(entry.username, { gecos: entry.username });
  return auth.getPasswdByUid(entry.uid);
}

function normalizeContextFileName(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const name = raw.endsWith(".md") ? raw : `${raw}.md`;
  const base = name.slice(0, -3);
  if (!base || base === "." || base === "..") {
    return null;
  }
  return name;
}

function normalizeAccountContextFiles(value: unknown): AccountContextFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("contextFiles must be an array");
  }

  const files = new Map<string, AccountContextFile>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error("contextFiles entries must be objects");
    }
    const record = item as { name?: unknown; text?: unknown };
    const name = normalizeContextFileName(record.name);
    if (!name) {
      throw new Error("contextFiles entries require local markdown file names");
    }
    files.set(name, {
      name,
      text: typeof record.text === "string" ? record.text : String(record.text ?? ""),
    });
  }
  return [...files.values()];
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
      const reconciled = reconcilePersonalAgentDisplayName(auth, entry, human) ?? entry;
      const identity = accountIdentity(auth, reconciled);
      await ensureAccountHomeLayout(ctx.env, identity, {
        userContextUsername: human.username,
        seedPromptContext: true,
      });
      return { identity, created: false };
    }
    // Stale mapping (account removed) — fall through and recreate.
  }

  const agentName = pickAgentName(auth, preferredName);
  return createAccount(ctx, {
    kind: "agent",
    username: agentName,
    gecos: agentName,
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
  const contextFiles = normalizeAccountContextFiles(args.contextFiles);
  const personaFile = contextFiles.find((file) => file.name === "05-persona.md");
  const explicitPersona = typeof args.persona === "string" && args.persona.trim()
    ? args.persona
    : undefined;
  const persona = explicitPersona ?? (personaFile?.text.trim()
    ? personaFile.text
    : defaultPersonaContext(name, ownerName));
  const extraContextFiles = contextFiles.filter((file) => file.name !== "05-persona.md");
  const { identity } = await createAccount(ctx, {
    kind: "agent",
    username: name,
    gecos: args.gecos?.trim() || `${ownerName}'s agent`,
    ownerUid,
    shared: true,
    crossMemberOwner: true,
    persona,
    contextFiles: extraContextFiles,
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
  const home = `/home/${agentName}`;
  return DEFAULT_PERSONA_CONTEXT_TEMPLATE
    .replaceAll("{{program.username}}", agentName)
    .replaceAll("{{program.home}}", home)
    .replaceAll("{{user.username}}", ownerUsername);
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
