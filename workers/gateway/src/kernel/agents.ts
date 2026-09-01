/**
 * Personal agent accounts.
 *
 * Each human gets a 1:1 personal agent that is a real user account in the
 * Unix-like identity model: its own uid, its own private primary group
 * (gid = uid, User Private Group), and its own /home. The agent is the
 * default run-as identity for the user's personal intelligence, while the
 * human remains the process owner (routing, visibility, quotas).
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
import { isLocked } from "../auth/shadow";
import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import type { AuthStore } from "./auth-store";
import {
  accountIdentity,
  createAccount,
  isUsernameAvailable,
  normalizeAccountName,
} from "./accounts";
import { canOwnerRunAsAccount } from "./account-access";
import { ensureAccountHomeLayout } from "./account-home";
import { ensureInitialOnboardingResponsibility } from "./onboarding-responsibility";
import { ensurePersonalMemory } from "./personal-memory";

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
export function normalizeAgentName(auth: AuthStore, value: string | undefined): string | null {
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

function personalAgentDisplayName(username: string): string {
  const words = username
    .split(/[-_]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return username;
  }
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function reconcilePersonalAgentDisplayName(
  auth: AuthStore,
  entry: { username: string; uid: number; gecos: string },
  human: ProcessIdentity,
): { username: string; uid: number; gid: number; gecos: string; home: string; shell: string } | null {
  const displayName = entry.gecos.trim();
  if (displayName !== legacyPersonalAgentDisplayName(human.username)) {
    return auth.getPasswdByUid(entry.uid);
  }
  auth.updateUser(entry.username, { gecos: personalAgentDisplayName(entry.username) });
  return auth.getPasswdByUid(entry.uid);
}

function normalizeContextFileName(value: string): string | null {
  const raw = value.trim();
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

function normalizeAccountContextFiles(
  value: AccountCreateArgs["contextFiles"],
): AccountContextFile[] {
  if (value === undefined) return [];

  const files = new Map<string, AccountContextFile>();
  for (const item of value) {
    const name = normalizeContextFileName(item.name);
    if (!name) {
      throw new Error("contextFiles entries require local markdown file names");
    }
    files.set(name, {
      name,
      text: item.text,
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

  await ensurePersonalMemory(ctx, human);

  const existingUid = auth.getPersonalAgentUid(human.uid);
  if (existingUid !== null) {
    const entry = auth.getPasswdByUid(existingUid);
    if (entry) {
      const reconciled = reconcilePersonalAgentDisplayName(auth, entry, human) ?? entry;
      const identity = accountIdentity(auth, reconciled);
      await ensureAccountHomeLayout(ctx.env, identity, {
        seedPromptContext: true,
        personalAgent: true,
        beforeRetiringGeneratedBootContext: () => {
          ensureInitialOnboardingResponsibility(human.uid, ctx.responsibilities);
        },
      });
      return { identity, created: false };
    }
    // Stale mapping (account removed) — fall through and recreate.
  }

  const agentName = pickAgentName(auth, preferredName);
  ensureInitialOnboardingResponsibility(human.uid, ctx.responsibilities);
  return createAccount(ctx, {
    kind: "agent",
    username: agentName,
    gecos: personalAgentDisplayName(agentName),
    ownerUid: human.uid,
    shared: true,
    crossMemberOwner: true,
    personalAgentOf: human.uid,
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
  const explicitPersona = args.persona?.trim()
    ? args.persona
    : undefined;
  const persona = explicitPersona ?? (personaFile?.text.trim() ? personaFile.text : undefined);
  const extraContextFiles = contextFiles.filter((file) => file.name !== "05-persona.md");
  const accountInput: Parameters<typeof createAccount>[1] = {
    kind: "agent",
    username: name,
    gecos: args.gecos?.trim() || `${ownerName}'s agent`,
    ownerUid,
    shared: true,
    crossMemberOwner: true,
    contextFiles: extraContextFiles,
  };
  if (persona) accountInput.persona = persona;
  const { identity } = await createAccount(ctx, accountInput);
  return { account: identity, kind };
}

/**
 * List the accounts the owning human may run processes as: their own account,
 * their personal agent, and any account whose private group they belong to
 * (custom agents). Root sees all accounts as runnable.
 */
export function handleAccountList(
  args: AccountListArgs,
  ctx: KernelContext,
): AccountListResult {
  const { auth } = ctx;
  const caller = ctx.identity!;
  const isRoot = caller.process.uid === 0;
  const ownerUid = isRoot && args.uid !== undefined
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

    const accountSummary: AccountSummary = {
      uid: entry.uid,
      username: entry.username,
      displayName: entry.gecos?.trim() || entry.username,
      relation,
      runnable: true,
      capabilities: resolveAccountCapabilities(ctx, entry.username, entry.gid),
    };
    if (entry.gecos) accountSummary.gecos = entry.gecos;
    accounts.push(accountSummary);
  }

  const relationRank = {
    "self": 0,
    "personal-agent": 1,
    "agent": 2,
    "human": 3,
  } satisfies Record<AccountRelation, number>;
  accounts.sort((a, b) => {
    const rank = relationRank[a.relation] - relationRank[b.relation];
    return rank !== 0 ? rank : a.username.localeCompare(b.username);
  });

  return { accounts };
}

function resolveAccountCapabilities(ctx: KernelContext, username: string, primaryGid: number): string[] {
  return ctx.caps.resolve(ctx.auth.resolveGids(username, primaryGid)).sort();
}
