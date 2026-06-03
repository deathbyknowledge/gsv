/**
 * Shared authorization for "may this owning human act as / manage this account?"
 */

import type { AuthStore } from "./auth-store";
import { packageAgentAccessGroup } from "./package-agents";

export type AccountPasswdRef = {
  uid: number;
  gid: number;
  username: string;
};

/**
 * Whether `ownerUid` may run processes as `target` (personal agent, primary-group
 * agent, or package-agent access group). Does not include "run as the human
 * owner themself" — use caller run-as identity for that in proc.spawn.
 */
export function canOwnerDelegateRunAs(
  auth: AuthStore,
  ownerUid: number,
  target: AccountPasswdRef,
): boolean {
  const ownerName = auth.getPasswdByUid(ownerUid)?.username;
  if (!ownerName) return false;
  if (auth.getPersonalAgentUid(ownerUid) === target.uid) return true;

  const group = auth.getGroupByGid(target.gid);
  if (group?.members.includes(ownerName)) return true;

  const accessGroup = auth.getGroupByName(packageAgentAccessGroup(target.username));
  if (accessGroup?.members.includes(ownerName)) return true;

  return false;
}

/**
 * Whether `ownerUid` may list/run as `target` (includes the human's own account).
 */
export function canOwnerRunAsAccount(
  auth: AuthStore,
  ownerUid: number,
  target: AccountPasswdRef,
  isRoot: boolean,
): boolean {
  if (isRoot) return true;
  if (target.uid === ownerUid) return true;
  return canOwnerDelegateRunAs(auth, ownerUid, target);
}

/**
 * Whether `ownerUid` may use the home-knowledge (ripgit) overlay for `targetUsername`'s
 * home tree. Used when a human edits another account's `~/context.d` via fs.*.
 */
export function canOwnerAccessHomeKnowledge(
  auth: AuthStore,
  ownerUid: number,
  viewerUsername: string,
  targetUsername: string,
  isRoot: boolean,
): boolean {
  if (targetUsername === viewerUsername) return true;
  if (isRoot) return true;
  const entry = auth.getPasswdByUsername(targetUsername);
  if (!entry) return false;
  return canOwnerRunAsAccount(auth, ownerUid, entry, false);
}

/** Parse `/home/<username>/...` when present. */
export function homeUsernameFromPath(path: string): string | null {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  const match = /^\/home\/([^/]+)(?:\/|$)/.exec(normalized);
  return match?.[1] ?? null;
}
