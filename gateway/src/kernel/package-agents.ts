/**
 * Package-provisioned agent accounts.
 *
 * When a package is enabled, each profile it declares is provisioned as a shared
 * agent account (one per `package#profile`, idempotent). The agent runs with the
 * package-declared capabilities seeded on its own gid; enabling humans are added
 * to a separate, capability-less access group that authorizes them to run as the
 * agent without inheriting its capabilities. Spawned processes are owned by the
 * enabling human (`owner_uid`), while the agent account supplies the run-as
 * identity (uid/gid/home/caps).
 */

import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import { accountIdentity, createAccount } from "./accounts";
import type { KernelContext } from "./context";
import type { InstalledPackageRecord, PackageProfileManifest } from "./packages";

/**
 * Baseline capabilities every package agent receives. Intentionally empty:
 * conversational loop syscalls (`ai.*`) are internal-only and always allowed, so
 * an agent with no declared capabilities can converse but use no tools. Tools are
 * unlocked only by the profile's declared capabilities.
 */
const PACKAGE_AGENT_BASELINE: readonly string[] = [];

/** Deterministic, unique account name for a package profile's agent. */
export function packageAgentUsername(packageName: string, profileName: string): string {
  const slug = `${packageName}-${profileName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
  const safe = /^[a-z_]/.test(slug) ? slug : `p-${slug}`.slice(0, 32);
  return safe.replace(/-+$/, "") || "p-agent";
}

/** Capability-less group whose members may run as the package agent. */
export function packageAgentAccessGroup(username: string): string {
  return `${username}-run`;
}

/** Config key recording which package owns a package-agent account. */
function packageAgentOwnerKey(uid: number): string {
  return `users/${uid}/pkg/owner`;
}

/** Config key recording which package profile owns a package-agent account. */
function packageAgentProfileKey(uid: number): string {
  return `users/${uid}/pkg/profile`;
}

/**
 * Provision (idempotently) the agent account for a package profile and grant the
 * enabling human run-as rights via the access group. Returns the agent identity.
 */
export async function ensurePackageAgent(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  enablingHumanUid: number,
): Promise<ProcessIdentity> {
  const auth = ctx.auth;
  const username = packageAgentUsername(record.manifest.name, profile.name);
  const accessGroupName = packageAgentAccessGroup(username);

  let entry = auth.getPasswdByUsername(username);
  if (!entry) {
    const created = await createAccount(ctx, {
      kind: "agent",
      username,
      gecos: profile.displayName || username,
      shared: false, // never join users(100): capabilities come only from the manifest
      capabilities: [...PACKAGE_AGENT_BASELINE, ...(profile.capabilities ?? [])],
      accessGroupName,
      contextFiles: profile.contextFiles.map((file) => ({ name: file.name, text: file.text })),
    });
    entry = auth.getPasswdByUid(created.identity.uid)!;
    // Stamp the owning package so a later, different package that sanitizes to
    // the same username cannot silently reuse (and hijack) this account.
    ctx.config.set(packageAgentOwnerKey(entry.uid), record.packageId);
    ctx.config.set(packageAgentProfileKey(entry.uid), profile.name);
    if (profile.approvalPolicy) {
      ctx.config.set(`users/${entry.uid}/ai/tools/approval`, profile.approvalPolicy);
    }
  } else {
    // Guard against cross-package collisions: the username derives from
    // (sanitized, truncated) package + profile name, which is not globally
    // unique. Reusing an account owned by a different package would skip its
    // caps/policy/context and let it run as the wrong agent.
    const ownerKey = packageAgentOwnerKey(entry.uid);
    const stampedPackageId = ctx.config.get(ownerKey);
    if (stampedPackageId && stampedPackageId !== record.packageId) {
      throw new Error(
        `Package agent name collision: "${username}" is owned by ${stampedPackageId}, cannot provision it for ${record.packageId}`,
      );
    }
    if (!stampedPackageId) {
      throw new Error(
        `Package agent name collision: "${username}" already exists and is not owned by package ${record.packageId}`,
      );
    }
    const profileKey = packageAgentProfileKey(entry.uid);
    const stampedProfileName = ctx.config.get(profileKey);
    if (stampedProfileName && stampedProfileName !== profile.name) {
      throw new Error(
        `Package agent name collision: "${username}" is owned by ${record.packageId} profile ${stampedProfileName}, cannot provision it for profile ${profile.name}`,
      );
    }
    if (!stampedProfileName) {
      ctx.config.set(profileKey, profile.name);
    }
    if (!auth.getGroupByName(accessGroupName)) {
      // Older provisioning without an access group: backfill it.
      auth.addGroup({ name: accessGroupName, gid: auth.nextGid(), members: [] });
    }
  }

  joinAccessGroup(ctx, accessGroupName, enablingHumanUid);
  return accountIdentity(auth, entry);
}

/** Provision every profile of a package on enable for the enabling human. */
export async function provisionPackageAgents(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  enablingHumanUid: number,
): Promise<void> {
  for (const profile of record.manifest.profiles ?? []) {
    await ensurePackageAgent(ctx, record, profile, enablingHumanUid);
  }
}

/** Revoke a human's run-as rights for a package's agents (on disable/remove). */
export function revokePackageAgentAccess(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  humanUid: number,
): void {
  const auth = ctx.auth;
  const human = auth.getPasswdByUid(humanUid);
  if (!human) return;
  for (const profile of record.manifest.profiles ?? []) {
    const username = packageAgentUsername(record.manifest.name, profile.name);
    const groupName = packageAgentAccessGroup(username);
    const group = auth.getGroupByName(groupName);
    if (group && group.members.includes(human.username)) {
      auth.updateGroupMembers(
        groupName,
        group.members.filter((member) => member !== human.username),
      );
    }
  }
}

/**
 * Resolve a `package#profile` run-as reference to a provisioned agent identity,
 * authorizing the owner human via the access group (root bypasses).
 */
export function resolvePackageAgentRunAs(
  ctx: KernelContext,
  reference: string,
  ownerUid: number,
  isRoot: boolean,
): { ok: true; identity: ProcessIdentity } | { ok: false; error: string } {
  const auth = ctx.auth;
  const hash = reference.indexOf("#");
  const packageName = reference.slice(0, hash).trim();
  const profileName = reference.slice(hash + 1).trim();
  if (!packageName || !profileName) {
    return { ok: false, error: `Invalid package agent reference: ${reference}` };
  }

  const username = packageAgentUsername(packageName, profileName);
  const entry = auth.getPasswdByUsername(username);
  if (!entry) {
    return {
      ok: false,
      error: `Package agent not provisioned: ${reference} (enable the package first)`,
    };
  }

  if (!isRoot) {
    const ownerName = auth.getPasswdByUid(ownerUid)?.username;
    const group = auth.getGroupByName(packageAgentAccessGroup(username));
    const authorized = !!ownerName && !!group && group.members.includes(ownerName);
    if (!authorized) {
      return { ok: false, error: `Permission denied: cannot run as ${reference}` };
    }
  }

  return { ok: true, identity: accountIdentity(auth, entry) };
}

function joinAccessGroup(ctx: KernelContext, groupName: string, humanUid: number): void {
  const auth = ctx.auth;
  const human = auth.getPasswdByUid(humanUid);
  if (!human) return;
  const group = auth.getGroupByName(groupName);
  if (group && !group.members.includes(human.username)) {
    auth.updateGroupMembers(groupName, [...group.members, human.username]);
  }
}
