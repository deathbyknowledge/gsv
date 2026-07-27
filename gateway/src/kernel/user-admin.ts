import type {
  UserAdminArgs,
  UserAdminPermissionsResult,
  UserAdminResult,
} from "@humansandmachines/gsv/protocol";
import { isLocked } from "../auth/shadow";
import { normalizeAccountUsername } from "../auth/username";
import type { GroupEntry } from "../auth/group";
import type { PasswdEntry } from "../auth/passwd";
import { isValidCapability } from "./capabilities";
import type { KernelContext } from "./context";
import { createHumanAccount } from "./agents";
import { requireUserAdmin } from "./user-authority";

export async function handleUserAdmin(
  args: UserAdminArgs,
  ctx: KernelContext,
): Promise<UserAdminResult> {
  // Repeat the capability gate inside the owning boundary so internal callers
  // cannot bypass the WebSocket dispatch check. This must precede all writes.
  requireUserAdmin(ctx);

  const raw = args as unknown as Record<string, unknown>;
  if (raw.action === "create") {
    if (typeof raw.username !== "string") {
      throw new Error("username is required");
    }
    const created = await createHumanAccount({
      username: raw.username,
      password: typeof raw.password === "string" ? raw.password : undefined,
      gecos: typeof raw.gecos === "string" ? raw.gecos : undefined,
    }, ctx);
    return {
      action: "create",
      account: created.account,
      personalAgent: created.personalAgent,
    };
  }

  if (raw.action !== "permissions") {
    throw new Error("action must be one of: create, permissions");
  }

  return updateUserPermissions(raw, ctx);
}

function updateUserPermissions(
  raw: Record<string, unknown>,
  ctx: KernelContext,
): UserAdminPermissionsResult {
  const target = requireHumanAccount(raw.username, ctx);
  const grants = readStringSet(raw.grant, "grant");
  const revocations = readStringSet(raw.revoke, "revoke");
  const additions = readStringSet(raw.addGroups, "addGroups");
  const removals = readStringSet(raw.removeGroups, "removeGroups");

  for (const capability of [...grants, ...revocations]) {
    if (!isValidCapability(capability)) {
      throw new Error(`Invalid capability format: ${capability}`);
    }
  }
  if (target.uid !== 0 && grants.has("*")) {
    throw new Error("The unrestricted capability is reserved for root");
  }
  assertDisjoint(grants, revocations, "capability");
  assertDisjoint(additions, removals, "group");

  const groupEntries = ctx.auth.getGroupEntries();
  const groupsByName = new Map(groupEntries.map((group) => [group.name, group]));
  const changedGroups = new Map<string, GroupEntry>();
  for (const name of [...additions, ...removals]) {
    const group = groupsByName.get(name);
    if (!group) {
      throw new Error(`Unknown group: ${name}`);
    }
    if (group.gid === 0) {
      throw new Error("Permission denied: root group membership is immutable");
    }
    if (group.gid === target.gid) {
      throw new Error("A user's primary group membership is immutable");
    }

    const members = new Set(group.members);
    if (additions.has(name)) members.add(target.username);
    if (removals.has(name)) members.delete(target.username);
    changedGroups.set(name, { ...group, members: [...members] });
  }

  const hasRequestedChanges = grants.size > 0 || revocations.size > 0 || changedGroups.size > 0;
  if (target.uid === 0 && hasRequestedChanges) {
    throw new Error("Permission denied: root permissions are immutable");
  }

  // Every failure above occurs before this first mutation. Capability writes
  // and group membership writes share one Kernel SQLite transaction.
  return ctx.transactionSync(() => {
    let changed = false;
    const directCapabilities = new Set(
      ctx.caps.list(target.gid).map((entry) => entry.capability),
    );
    for (const capability of grants) {
      if (directCapabilities.has(capability)) continue;
      const result = ctx.caps.grant(target.gid, capability);
      if (!result.ok) {
        throw new Error(result.error ?? `Could not grant ${capability}`);
      }
      directCapabilities.add(capability);
      changed = true;
    }
    for (const capability of revocations) {
      if (!directCapabilities.delete(capability)) continue;
      const result = ctx.caps.revoke(target.gid, capability);
      if (!result.ok) {
        throw new Error(result.error ?? `Could not revoke ${capability}`);
      }
      changed = true;
    }
    for (const [name, group] of changedGroups) {
      const existing = groupsByName.get(name)!;
      if (sameMembers(existing.members, group.members)) continue;
      if (!ctx.auth.updateGroupMembers(name, group.members)) {
        throw new Error(`Unknown group: ${name}`);
      }
      changed = true;
    }

    return permissionResult(target, ctx, changed);
  });
}

function requireHumanAccount(value: unknown, ctx: KernelContext): PasswdEntry {
  const username = normalizeAccountUsername(value);
  if (!username) {
    throw new Error("username is required");
  }
  const account = ctx.auth.getPasswdByUsername(username);
  const shadow = account ? ctx.auth.getShadowByUsername(account.username) : null;
  if (!account || !shadow || (account.uid !== 0 && isLocked(shadow))) {
    throw new Error(`Unknown human user: ${username}`);
  }
  return account;
}

function readStringSet(value: unknown, field: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }

  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} must contain only non-empty strings`);
    }
    result.add(item.trim());
  }
  return result;
}

function assertDisjoint(left: Set<string>, right: Set<string>, label: string): void {
  for (const value of left) {
    if (right.has(value)) {
      throw new Error(`Cannot both add and remove ${label}: ${value}`);
    }
  }
}

function permissionResult(
  target: PasswdEntry,
  ctx: KernelContext,
  changed: boolean,
): UserAdminPermissionsResult {
  const groups = ctx.auth.getGroupEntries()
    .filter((group) => group.gid === target.gid || group.members.includes(target.username))
    .map((group) => ({
      name: group.name,
      gid: group.gid,
      primary: group.gid === target.gid,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.gid - b.gid);
  const gids = groups.map((group) => group.gid);

  return {
    action: "permissions",
    user: { username: target.username, uid: target.uid, gid: target.gid },
    groups,
    directCapabilities: ctx.caps
      .list(target.gid)
      .map((entry) => entry.capability)
      .sort(),
    effectiveCapabilities: ctx.caps.resolve(gids).sort(),
    changed,
  };
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}
