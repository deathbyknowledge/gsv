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

import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { RequestFrame } from "../protocol/frames";
import { makeShadowEntry } from "../auth/shadow";
import { sendFrameToProcess } from "../shared/utils";
import { ensureHomeStorageLayout } from "./home-knowledge";
import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
import type { KernelContext } from "./context";
import type { AuthStore } from "./auth-store";
import type { PasswdEntry } from "../auth/passwd";

const TEXT_ENCODER = new TextEncoder();

const AGENT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

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
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!AGENT_USERNAME_RE.test(name)) return null;
  if (auth.getPasswdByUsername(name) || auth.getGroupByName(name)) return null;
  return name;
}

function pickAgentName(auth: AuthStore, preferred?: string): string {
  const normalizedPreferred = normalizeAgentName(auth, preferred);
  if (normalizedPreferred) return normalizedPreferred;

  for (const name of AGENT_NAME_POOL) {
    if (!auth.getPasswdByUsername(name) && !auth.getGroupByName(name)) {
      return name;
    }
  }

  let suffix = 1;
  for (;;) {
    const name = `agent${suffix}`;
    if (!auth.getPasswdByUsername(name) && !auth.getGroupByName(name)) {
      return name;
    }
    suffix += 1;
  }
}

function agentIdentity(auth: AuthStore, entry: PasswdEntry): ProcessIdentity {
  return {
    uid: entry.uid,
    gid: entry.gid,
    gids: auth.resolveGids(entry.username, entry.gid),
    username: entry.username,
    home: entry.home,
    cwd: entry.home,
  };
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
  const { auth, env } = ctx;

  // System accounts (root, services; uid < 1000) and agent accounts themselves
  // do not get their own personal agent — their processes run as themselves.
  if (human.uid < 1000 || auth.isPersonalAgentUid(human.uid)) {
    return { identity: human, created: false };
  }

  const existingUid = auth.getPersonalAgentUid(human.uid);
  if (existingUid !== null) {
    const entry = auth.getPasswdByUid(existingUid);
    if (entry) {
      return { identity: agentIdentity(auth, entry), created: false };
    }
    // Stale mapping (account removed) — fall through and recreate.
  }

  const agentName = pickAgentName(auth, preferredName);
  const agentUid = auth.nextUid();
  const agentGid = agentUid; // User Private Group
  const home = `/home/${agentName}`;

  auth.addUser({
    username: agentName,
    uid: agentUid,
    gid: agentGid,
    gecos: `${human.username}'s agent`,
    home,
    shell: "/bin/init",
  });
  // Locked account: the agent is never logged into directly.
  auth.setShadow(makeShadowEntry(agentName, "!"));

  // Private primary group; the human is a member so they can act as the agent.
  if (!auth.getGroupByName(agentName) && !auth.getGroupByGid(agentGid)) {
    auth.addGroup({ name: agentName, gid: agentGid, members: [human.username] });
  }

  // Standard user capabilities.
  const usersGroup = auth.getGroupByName("users");
  if (usersGroup && !usersGroup.members.includes(agentName)) {
    auth.updateGroupMembers("users", [...usersGroup.members, agentName]);
  }

  // Cross-membership: agent joins the human's private group.
  const humanGroup = auth.getGroupByName(human.username);
  if (humanGroup && !humanGroup.members.includes(agentName)) {
    auth.updateGroupMembers(human.username, [...humanGroup.members, agentName]);
  }

  auth.setPersonalAgent(human.uid, agentUid);

  const entry = auth.getPasswdByUid(agentUid)!;
  const identity = agentIdentity(auth, entry);

  await ensureHomeStorageLayout(env, identity);
  await seedAgentPersona(env, identity, human.username);

  return { identity, created: true };
}

async function seedAgentPersona(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  ownerUsername: string,
): Promise<void> {
  if (!env.RIPGIT) return;

  const client = new RipgitClient(env.RIPGIT);
  const repo = homeKnowledgeRepoRef(identity.username);
  const existing = await client.readPath(repo, "context.d/05-persona.md");
  if (existing.kind !== "missing") return;

  const ops: RipgitApplyOp[] = [{
    type: "put",
    path: "context.d/05-persona.md",
    contentBytes: Array.from(TEXT_ENCODER.encode(defaultPersonaContext(identity.username, ownerUsername))),
  }];

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    "gsv: scaffold agent persona",
    ops,
  );
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
