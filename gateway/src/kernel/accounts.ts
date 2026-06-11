/**
 * Unified account creation.
 *
 * Both humans and agents are real user accounts in the Unix-like identity
 * model: each gets a uid, a User Private Group (gid = uid), and a /home. A
 * single core (`createAccount`) provisions them; a `kind` discriminator drives
 * the differences:
 *
 *   - human: password login, member of `users` for shared capabilities, gets a
 *     1:1 personal agent + init process provisioned separately.
 *   - agent: locked (no login), owned by a human, cross-membered with the owner
 *     so the human can act as the agent and vice versa.
 */

import type { AccountKind, ProcessIdentity } from "@gsv/protocol/syscalls/system";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { ensureAccountHomeLayout } from "./account-home";
import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { accountHomeRepoRef } from "../fs/ripgit/repos";
import type { KernelContext } from "./context";
import type { AuthStore } from "./auth-store";
import type { PasswdEntry } from "../auth/passwd";

const TEXT_ENCODER = new TextEncoder();

export const ACCOUNT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** A username is available when it collides with no existing user or group. */
export function isUsernameAvailable(auth: AuthStore, name: string): boolean {
  return !auth.getPasswdByUsername(name) && !auth.getGroupByName(name);
}

/**
 * Validate and normalize a candidate username. Returns null when the name is
 * malformed or already taken.
 */
export function normalizeAccountName(auth: AuthStore, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!ACCOUNT_USERNAME_RE.test(name)) return null;
  if (!isUsernameAvailable(auth, name)) return null;
  return name;
}

export function accountIdentity(auth: AuthStore, entry: PasswdEntry): ProcessIdentity {
  return {
    uid: entry.uid,
    gid: entry.gid,
    gids: auth.resolveGids(entry.username, entry.gid),
    username: entry.username,
    home: entry.home,
    cwd: entry.home,
  };
}

export interface CreateAccountInput {
  kind: AccountKind;
  /** Pre-validated, normalized username. */
  username: string;
  gecos?: string;
  /** Required for `kind: "human"`. */
  password?: string;
  /** The owning human's uid (for `kind: "agent"`): drives cross-membership. */
  ownerUid?: number;
  /** Join `users` (gid 100) for the shared standard capability set. Default true. */
  shared?: boolean;
  /**
   * Wire bidirectional private-group membership between the owner and the new
   * account (owner can act as the account and vice versa). Defaults to true
   * when `ownerUid` is set.
   */
  crossMemberOwner?: boolean;
  /** Register `ownerUid -> uid` as a personal-agent mapping. */
  personalAgentOf?: number;
  /** Optional persona text seeded to context.d/05-persona.md. */
  persona?: string;
  /**
   * Capabilities granted on the account's own (cap) gid. Only the account is a
   * member of this group, so these never leak to anyone authorized to run as it.
   */
  capabilities?: string[];
  /** Extra context.d files seeded into the home (idempotent per file). */
  contextFiles?: { name: string; text: string }[];
  /**
   * Create a separate, capability-less group used purely to authorize run-as.
   * Humans join this group (not the cap gid), so they may run as the account
   * without inheriting its capabilities. Must be a new group. Returns its gid
   * on the result.
   */
  accessGroupName?: string;
}

export interface CreatedAccount {
  identity: ProcessIdentity;
  created: boolean;
  /** gid of the run-as access group, when `accessGroupName` was requested. */
  accessGroupGid?: number;
}

/**
 * Provision a new account (human or agent). Caller is responsible for
 * authorization and for ensuring the username is valid and available.
 */
export async function createAccount(
  ctx: KernelContext,
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  const { auth, env } = ctx;
  const username = input.username;

  if (!ACCOUNT_USERNAME_RE.test(username)) {
    throw new Error("username must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  if (auth.getPasswdByUsername(username)) {
    throw new Error(`User already exists: ${username}`);
  }
  if (input.accessGroupName && auth.getGroupByName(input.accessGroupName)) {
    throw new Error(`Access group already exists: ${input.accessGroupName}`);
  }

  const ownerUsername = input.ownerUid != null
    ? auth.getPasswdByUid(input.ownerUid)?.username ?? null
    : null;
  const crossMember = (input.crossMemberOwner ?? input.ownerUid != null) && ownerUsername != null;

  // Validate (and hash) before any auth-state mutation: a human account with a
  // bad/missing password must not leave a half-created passwd row behind, which
  // would also make the username unavailable on retry.
  let shadowHash: string;
  if (input.kind === "human") {
    if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    shadowHash = await hashPassword(input.password);
  } else {
    // Locked account: agents are never logged into directly.
    shadowHash = "!";
  }

  const uid = auth.nextUid();
  const gid = uid; // User Private Group
  const home = `/home/${username}`;

  auth.addUser({
    username,
    uid,
    gid,
    gecos: input.gecos ?? username,
    home,
    shell: "/bin/init",
  });

  auth.setShadow(makeShadowEntry(username, shadowHash));

  // Private primary group (gid = uid). The owner joins it so they can act as
  // this account.
  if (!auth.getGroupByName(username) && !auth.getGroupByGid(gid)) {
    auth.addGroup({ name: username, gid, members: crossMember ? [ownerUsername!] : [] });
  }

  if (input.shared ?? true) {
    const usersGroup = auth.getGroupByName("users");
    if (usersGroup && !usersGroup.members.includes(username)) {
      auth.updateGroupMembers("users", [...usersGroup.members, username]);
    }
  }

  // Cross-membership: the new account joins the owner's private group.
  if (crossMember) {
    const ownerGroup = auth.getGroupByName(ownerUsername!);
    if (ownerGroup && !ownerGroup.members.includes(username)) {
      auth.updateGroupMembers(ownerUsername!, [...ownerGroup.members, username]);
    }
  }

  if (input.personalAgentOf != null) {
    auth.setPersonalAgent(input.personalAgentOf, uid);
  }

  // Capabilities live on the account's own gid (only the account is a member),
  // so run-as authorization (granted via the access group below) never confers
  // these capabilities on the authorized human.
  for (const capability of input.capabilities ?? []) {
    ctx.caps.grant(gid, capability);
  }

  let accessGroupGid: number | undefined;
  if (input.accessGroupName) {
    accessGroupGid = auth.nextGid();
    auth.addGroup({ name: input.accessGroupName, gid: accessGroupGid, members: [] });
  }

  const entry = auth.getPasswdByUid(uid)!;
  const identity = accountIdentity(auth, entry);
  const userContextUsername = input.kind === "agent" && ownerUsername
    ? ownerUsername
    : identity.username;

  await ensureAccountHomeLayout(env, identity, {
    userContextUsername,
    seedPromptContext: input.kind === "agent",
    seedBootContext: input.personalAgentOf != null,
    cleanupGeneratedPromptContext: input.kind !== "agent",
  });
  if (input.persona) {
    await seedPersona(env, identity, input.persona);
  }
  for (const file of input.contextFiles ?? []) {
    await seedContextFile(env, identity, file.name, file.text);
  }

  return { identity, created: true, accessGroupGid };
}

/**
 * Seed an account's persona at context.d/05-persona.md, idempotently (no-op if
 * the file already exists).
 */
export async function seedPersona(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  persona: string,
): Promise<void> {
  await seedContextFile(env, identity, "05-persona.md", persona);
}

/**
 * Seed a single context.d/<name> file in an account's home, idempotently (no-op
 * if the file already exists).
 */
export async function seedContextFile(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  name: string,
  text: string,
): Promise<void> {
  if (!env.RIPGIT) return;

  const path = `context.d/${name}`;
  const client = new RipgitClient(env.RIPGIT);
  const repo = accountHomeRepoRef(identity.username);
  const existing = await client.readPath(repo, path);
  if (existing.kind !== "missing") return;

  const ops: RipgitApplyOp[] = [{
    type: "put",
    path,
    contentBytes: Array.from(TEXT_ENCODER.encode(text)),
  }];

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    `gsv: scaffold ${name}`,
    ops,
  );
}

/** Write/overwrite an account context.d/<name> file in account-home storage. */
export async function writeContextFile(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  name: string,
  text: string,
): Promise<void> {
  if (!env.RIPGIT) return;

  const client = new RipgitClient(env.RIPGIT);
  const repo = accountHomeRepoRef(identity.username);
  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    `gsv: update ${name}`,
    [{
      type: "put",
      path: `context.d/${name}`,
      contentBytes: Array.from(TEXT_ENCODER.encode(text)),
    }],
  );
}

/** Remove an account context.d/<name> file when it exists in account-home storage. */
export async function removeContextFile(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  name: string,
): Promise<void> {
  if (!env.RIPGIT) return;

  const path = `context.d/${name}`;
  const client = new RipgitClient(env.RIPGIT);
  const repo = accountHomeRepoRef(identity.username);
  const existing = await client.readPath(repo, path);
  if (existing.kind === "missing") return;

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    `gsv: remove ${name}`,
    [{ type: "delete", path }],
  );
}
