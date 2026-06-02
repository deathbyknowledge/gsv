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
import { ensureHomeStorageLayout } from "./home-knowledge";
import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
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
}

export interface CreatedAccount {
  identity: ProcessIdentity;
  created: boolean;
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

  const ownerUsername = input.ownerUid != null
    ? auth.getPasswdByUid(input.ownerUid)?.username ?? null
    : null;
  const crossMember = (input.crossMemberOwner ?? input.ownerUid != null) && ownerUsername != null;

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

  if (input.kind === "human") {
    if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    auth.setShadow(makeShadowEntry(username, await hashPassword(input.password)));
  } else {
    // Locked account: agents are never logged into directly.
    auth.setShadow(makeShadowEntry(username, "!"));
  }

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

  const entry = auth.getPasswdByUid(uid)!;
  const identity = accountIdentity(auth, entry);

  await ensureHomeStorageLayout(env, identity);
  if (input.persona) {
    await seedPersona(env, identity, input.persona);
  }

  return { identity, created: true };
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
  if (!env.RIPGIT) return;

  const client = new RipgitClient(env.RIPGIT);
  const repo = homeKnowledgeRepoRef(identity.username);
  const existing = await client.readPath(repo, "context.d/05-persona.md");
  if (existing.kind !== "missing") return;

  const ops: RipgitApplyOp[] = [{
    type: "put",
    path: "context.d/05-persona.md",
    contentBytes: Array.from(TEXT_ENCODER.encode(persona)),
  }];

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    "gsv: scaffold persona",
    ops,
  );
}
