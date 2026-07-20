/**
 * Package-provisioned agent accounts.
 *
 * A package agent is an immutable, owner- and scope-specific security principal
 * keyed by `(scope, packageId, profile, humanUid)`. Its random reserved username is only an
 * internal Unix identity; `package#profile` and the profile display name are
 * the human-facing labels. This prevents two package scopes from sharing a
 * home, capability gid, approval policy, context, or process identity.
 */

import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { PasswdEntry } from "../auth/passwd";
import {
  accountIdentity,
  createAccount,
  isUsernameAvailable,
  removeContextFile,
  writeContextFile,
} from "./accounts";
import { ensureAccountHomeLayout } from "./account-home";
import { canOwnerRunAsAccount } from "./account-access";
import { hasCapability } from "./capabilities";
import type { KernelContext } from "./context";
import type { UserKernelProvisioningSnapshot } from "./user-kernels";
import {
  packageScopeKey,
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
  type InstalledPackageRecord,
  type PackageProfileManifest,
} from "./packages";

const PACKAGE_AGENT_BASELINE: readonly string[] = [];
const PACKAGE_AGENT_USERNAME_PREFIX = "pkg-";
const PACKAGE_AGENT_RANDOM_CHARACTERS = 28;
const PACKAGE_AGENT_ALLOCATION_ATTEMPTS = 32;

/** Capability-less group whose members may run as the package agent. */
export function packageAgentAccessGroup(username: string): string {
  return `${username}-run`;
}

function packageAgentOwnerKey(uid: number): string {
  return `users/${uid}/pkg/owner`;
}

function packageAgentScopeKey(uid: number): string {
  return `users/${uid}/pkg/scope`;
}

function packageAgentProfileKey(uid: number): string {
  return `users/${uid}/pkg/profile`;
}

function packageAgentHumanUidKey(uid: number): string {
  return `users/${uid}/pkg/human_uid`;
}

function packageAgentContextFilesKey(uid: number): string {
  return `users/${uid}/pkg/context_files`;
}

function packageAgentAccessGroupKey(uid: number): string {
  return `users/${uid}/pkg/access_group`;
}

export function packageAgentSecurityRevisionKey(uid: number): string {
  return `users/${uid}/pkg/security_revision`;
}

function packageAgentTupleKey(
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  humanUid: number,
): string {
  return JSON.stringify([packageScopeKey(record.scope), record.packageId, profile.name, humanUid]);
}

function packageAgentReservationKey(
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  humanUid: number,
): string {
  return `internal/package-agent-identities/${encodeURIComponent(packageAgentTupleKey(record, profile, humanUid))}`;
}

function isActivePackageAgentRecord(record: InstalledPackageRecord): boolean {
  return record.enabled && (!record.reviewRequired || record.reviewedAt != null);
}

export type PackageAgentRuntimeIdentity =
  | { kind: "ordinary" }
  | { kind: "invalid" }
  | {
      kind: "package";
      packageId: string;
      scope: string;
      profileName: string;
      humanUid: number;
      securityRevision: string;
    };

/** Read the security tuple stamped on an account; partial stamps fail closed. */
export function packageAgentRuntimeIdentity(
  ctx: Pick<KernelContext, "config">,
  accountUid: number,
): PackageAgentRuntimeIdentity {
  const packageId = ctx.config.get(packageAgentOwnerKey(accountUid)) ?? null;
  const scope = ctx.config.get(packageAgentScopeKey(accountUid)) ?? null;
  const profileName = ctx.config.get(packageAgentProfileKey(accountUid)) ?? null;
  const humanUidStamp = ctx.config.get(packageAgentHumanUidKey(accountUid)) ?? null;
  const accessGroup = ctx.config.get(packageAgentAccessGroupKey(accountUid)) ?? null;
  const contextFiles = ctx.config.get(packageAgentContextFilesKey(accountUid)) ?? null;
  const securityRevision = ctx.config.get(packageAgentSecurityRevisionKey(accountUid)) ?? null;
  if (
    packageId === null
    && scope === null
    && profileName === null
    && humanUidStamp === null
    && accessGroup === null
    && contextFiles === null
    && securityRevision === null
  ) {
    return { kind: "ordinary" };
  }
  const humanUid = parseHumanUid(humanUidStamp);
  if (
    !packageId
    || !scope
    || !profileName
    || humanUid === null
    || !accessGroup
    || contextFiles === null
    || !securityRevision
  ) {
    return { kind: "invalid" };
  }
  return { kind: "package", packageId, scope, profileName, humanUid, securityRevision };
}

/** Security revision persisted into processes and schedules, never the private surface itself. */
export async function packageAgentSecurityRevision(
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
): Promise<string> {
  const canonical = packageAgentSecuritySurface(record, profile);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("")}`;
}

export type PackageAgentRuntimeAuthorization = {
  ownerUid: number;
  runAsUid: number;
  runAsUsername: string;
  packageSecurityRevision: string | null;
  requiredCall?: string;
};

/**
 * The single package-agent runtime authorization algorithm. It deliberately
 * accepts only stores that are either Master-authoritative or installed from a
 * verified user-Kernel projection, so both boundaries enforce identical
 * account, delegation, package, revision, and capability semantics.
 */
export async function isPackageAgentRuntimeAuthorized(
  ctx: Pick<KernelContext, "auth" | "caps" | "config" | "packages">,
  input: PackageAgentRuntimeAuthorization,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.ownerUid)
    || input.ownerUid < 0
    || !Number.isSafeInteger(input.runAsUid)
    || input.runAsUid < 0
    || typeof input.runAsUsername !== "string"
    || !input.runAsUsername
    || input.runAsUsername.length > 32
    || (input.packageSecurityRevision !== null
      && !/^sha256:[0-9a-f]{64}$/.test(input.packageSecurityRevision))
    || (input.requiredCall !== undefined
      && (typeof input.requiredCall !== "string"
        || !input.requiredCall
        || input.requiredCall.length > 128))
  ) {
    return false;
  }

  const owner = ctx.auth.getPasswdByUid(input.ownerUid);
  const ownerIdentity = owner ? ctx.auth.getAccountIdentity(owner.username) : null;
  const activeRoot = owner?.uid === 0
    && owner.username === "root"
    && ownerIdentity?.kind === "system";
  if (
    !owner
    || !ownerIdentity
    || ownerIdentity.uid !== owner.uid
    || ownerIdentity.state !== "active"
    || (ownerIdentity.kind !== "human" && !activeRoot)
  ) {
    return false;
  }

  const runAs = ctx.auth.getPasswdByUid(input.runAsUid);
  const runAsIdentity = runAs ? ctx.auth.getAccountIdentity(runAs.username) : null;
  if (
    !runAs
    || runAs.username !== input.runAsUsername
    || !runAsIdentity
    || runAsIdentity.uid !== runAs.uid
    || runAsIdentity.state !== "active"
    || !canOwnerRunAsAccount(ctx.auth, owner.uid, runAs, owner.uid === 0)
  ) {
    return false;
  }

  const packageIdentity = packageAgentRuntimeIdentity({ config: ctx.config }, runAs.uid);
  if (packageIdentity.kind === "invalid") return false;
  if (packageIdentity.kind === "ordinary") {
    return input.packageSecurityRevision === null;
  }
  if (
    input.packageSecurityRevision === null
    || packageIdentity.humanUid !== owner.uid
    || packageIdentity.securityRevision !== input.packageSecurityRevision
  ) {
    return false;
  }

  const scope = parsePackageAgentScope(packageIdentity.scope);
  if (!scope || (scope.kind === "user" && scope.uid !== owner.uid)) {
    return false;
  }
  const record = ctx.packages.get(packageIdentity.packageId, scope);
  if (!record || !isActivePackageAgentRecord(record)) return false;
  const profile = record.manifest.profiles?.find((candidate) => (
    candidate.name === packageIdentity.profileName
  ));
  if (!profile) return false;

  const securitySurface = packageAgentSecuritySurface(record, profile);
  const currentRevision = await packageAgentSecurityRevision(record, profile);
  const latestPackageIdentity = packageAgentRuntimeIdentity({ config: ctx.config }, runAs.uid);
  const latestRecord = ctx.packages.get(packageIdentity.packageId, scope);
  const latestProfile = latestRecord?.manifest.profiles?.find((candidate) => (
    candidate.name === packageIdentity.profileName
  ));
  if (
    latestPackageIdentity.kind !== "package"
    || latestPackageIdentity.packageId !== packageIdentity.packageId
    || latestPackageIdentity.scope !== packageIdentity.scope
    || latestPackageIdentity.profileName !== packageIdentity.profileName
    || latestPackageIdentity.humanUid !== packageIdentity.humanUid
    || latestPackageIdentity.securityRevision !== packageIdentity.securityRevision
    || !latestRecord
    || !isActivePackageAgentRecord(latestRecord)
    || !latestProfile
    || packageAgentSecuritySurface(latestRecord, latestProfile) !== securitySurface
    || currentRevision !== packageIdentity.securityRevision
    || currentRevision !== input.packageSecurityRevision
  ) {
    return false;
  }

  let exactAccount: PasswdEntry | null;
  try {
    exactAccount = findPackageAgentAccount(
      { auth: ctx.auth, config: ctx.config },
      latestRecord,
      latestProfile,
      owner.uid,
    );
  } catch {
    return false;
  }
  if (!exactAccount || exactAccount.uid !== runAs.uid || exactAccount.username !== runAs.username) {
    return false;
  }

  const accessGroup = ctx.auth.getGroupByName(packageAgentAccessGroup(runAs.username));
  if (
    !accessGroup
    || accessGroup.members.length !== 1
    || accessGroup.members[0] !== owner.username
  ) {
    return false;
  }
  const desiredCapabilities = new Set(latestProfile.capabilities ?? []);
  const currentCapabilities = new Set(
    ctx.caps.list(runAs.gid).map((entry) => entry.capability),
  );
  if (
    desiredCapabilities.size !== currentCapabilities.size
    || [...desiredCapabilities].some((capability) => !currentCapabilities.has(capability))
  ) {
    return false;
  }
  return input.requiredCall === undefined || hasCapability(
    [...desiredCapabilities],
    input.requiredCall,
  );
}

/**
 * Recompute every projected package security revision before it can become
 * local authority. This rejects partial stamps, duplicate tuples, stale
 * package/profile hashes, delegation drift, and capability amplification.
 */
export async function validatePackageAgentProjectionSecurity(
  snapshot: Pick<
    UserKernelProvisioningSnapshot,
    "uid" | "username" | "accounts" | "groups" | "capabilities" | "config" | "packages"
  >,
): Promise<void> {
  const config = new Map<string, string>();
  for (const entry of snapshot.config) {
    if (
      !entry
      || typeof entry.key !== "string"
      || typeof entry.value !== "string"
      || config.has(entry.key)
    ) {
      throw new Error("User Kernel config projection is invalid");
    }
    config.set(entry.key, entry.value);
  }
  const groups = new Map(snapshot.groups.map((group) => [group.name, group]));
  if (groups.size !== snapshot.groups.length) {
    throw new Error("User Kernel group projection is invalid");
  }
  const capabilities = new Map<number, Set<string>>();
  for (const grant of snapshot.capabilities) {
    const current = capabilities.get(grant.gid) ?? new Set<string>();
    if (current.has(grant.capability)) {
      throw new Error("User Kernel capability projection is invalid");
    }
    current.add(grant.capability);
    capabilities.set(grant.gid, current);
  }
  const packages = new Map<string, InstalledPackageRecord>();
  for (const record of snapshot.packages) {
    const key = `${packageScopeKey(record.scope)}\0${record.packageId}`;
    if (packages.has(key)) throw new Error("User Kernel package projection is invalid");
    packages.set(key, record);
  }
  const accountsByUid = new Map(snapshot.accounts.map((account) => [account.entry.uid, account]));
  if (accountsByUid.size !== snapshot.accounts.length) {
    throw new Error("User Kernel account projection is invalid");
  }
  const tupleOwners = new Set<string>();
  for (const account of snapshot.accounts) {
    const entry = account.entry;
    const values = {
      packageId: config.get(packageAgentOwnerKey(entry.uid)) ?? null,
      scope: config.get(packageAgentScopeKey(entry.uid)) ?? null,
      profileName: config.get(packageAgentProfileKey(entry.uid)) ?? null,
      humanUid: config.get(packageAgentHumanUidKey(entry.uid)) ?? null,
      accessGroup: config.get(packageAgentAccessGroupKey(entry.uid)) ?? null,
      contextFiles: config.get(packageAgentContextFilesKey(entry.uid)) ?? null,
      revision: config.get(packageAgentSecurityRevisionKey(entry.uid)) ?? null,
    };
    if (Object.values(values).every((value) => value === null)) continue;
    if (
      !values.packageId
      || !values.scope
      || !values.profileName
      || !values.accessGroup
      || values.contextFiles === null
      || !values.revision
      || account.kind !== "agent"
      || !account.locked
      || !/^sha256:[0-9a-f]{64}$/.test(values.revision)
    ) {
      throw new Error(`Package agent projection is invalid for uid ${entry.uid}`);
    }
    const humanUid = parseHumanUid(values.humanUid);
    const scope = parsePackageAgentScope(values.scope);
    const humanOwner = humanUid === null ? null : accountsByUid.get(humanUid);
    const rootProjection = snapshot.uid === 0 && snapshot.username === "root";
    const projectedOwnerIsActiveLogin = Boolean(
      humanOwner
      && !humanOwner.locked
      && (
        humanOwner.kind === "human"
        || (
          humanOwner.kind === "system"
          && humanOwner.entry.uid === 0
          && humanOwner.entry.username === "root"
        )
      ),
    );
    if (
      humanUid === null
      || (!rootProjection && humanUid !== snapshot.uid)
      || !projectedOwnerIsActiveLogin
      || !scope
      || (scope.kind === "user" && scope.uid !== humanUid)
    ) {
      throw new Error(`Package agent owner projection is invalid for uid ${entry.uid}`);
    }
    const tuple = JSON.stringify([values.scope, values.packageId, values.profileName, humanUid]);
    if (tupleOwners.has(tuple)) throw new Error("Package agent projection tuple is duplicated");
    tupleOwners.add(tuple);

    const record = packages.get(`${values.scope}\0${values.packageId}`);
    const profile = record?.manifest.profiles?.find((candidate) => (
      candidate.name === values.profileName
    ));
    if (!record || !isActivePackageAgentRecord(record) || !profile) {
      throw new Error(`Package agent package projection is invalid for uid ${entry.uid}`);
    }
    if (await packageAgentSecurityRevision(record, profile) !== values.revision) {
      throw new Error(`Package agent security revision projection is invalid for uid ${entry.uid}`);
    }
    const accessGroup = groups.get(values.accessGroup);
    if (
      values.accessGroup !== packageAgentAccessGroup(entry.username)
      || !accessGroup
      || accessGroup.members.length !== 1
      || accessGroup.members[0] !== humanOwner?.entry.username
    ) {
      throw new Error(`Package agent delegation projection is invalid for uid ${entry.uid}`);
    }
    const desired = new Set(profile.capabilities ?? []);
    const actual = capabilities.get(entry.gid) ?? new Set<string>();
    if (
      desired.size !== actual.size
      || [...desired].some((capability) => !actual.has(capability))
    ) {
      throw new Error(`Package agent capability projection is invalid for uid ${entry.uid}`);
    }
  }

  for (const key of config.keys()) {
    const match = /^users\/(\d+)\/pkg\/security_revision$/.exec(key);
    if (!match) continue;
    const uid = Number(match[1]);
    if (!snapshot.accounts.some((account) => account.entry.uid === uid)) {
      throw new Error("Package agent security revision has no projected account");
    }
  }
}

export function parsePackageAgentScope(value: string): InstalledPackageRecord["scope"] | null {
  if (value === "global") return { kind: "global" };
  const match = /^user:(\d+)$/.exec(value);
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid >= 0 ? { kind: "user", uid } : null;
}

/** Canonical private input for revision hashing and post-await TOCTOU checks. */
export function packageAgentSecuritySurface(
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
): string {
  return JSON.stringify({
    packageId: record.packageId,
    scope: packageScopeKey(record.scope),
    updatedAt: record.updatedAt,
    artifactHash: record.artifact.hash,
    profile: {
      name: profile.name,
      capabilities: [...new Set(profile.capabilities ?? [])].sort(),
      approvalPolicy: profile.approvalPolicy ?? null,
      contextFiles: [...profile.contextFiles]
        .map((file) => ({ name: file.name, text: file.text }))
        .sort((left, right) => (
          left.name.localeCompare(right.name) || left.text.localeCompare(right.text)
        )),
    },
  });
}

/** Resolve a locally projected account's bound package security revision. */
export function packageAgentRuntimeSecurityRevision(
  ctx: Pick<KernelContext, "config">,
  accountUid: number,
): string | null {
  const runtime = packageAgentRuntimeIdentity(ctx, accountUid);
  if (runtime.kind === "ordinary") return null;
  if (runtime.kind === "invalid") {
    throw new Error(`Package agent security metadata is invalid for uid ${accountUid}`);
  }
  return runtime.securityRevision;
}

/** Resolve the immutable account stamped for one exact package scope/profile. */
export function findPackageAgentAccount(
  ctx: Pick<KernelContext, "auth" | "config">,
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  humanUid: number,
): PasswdEntry | null {
  const scope = packageScopeKey(record.scope);
  const matches = ctx.auth.getPasswdEntries().filter((entry) => (
    ctx.config.get(packageAgentOwnerKey(entry.uid)) === record.packageId
    && ctx.config.get(packageAgentScopeKey(entry.uid)) === scope
    && ctx.config.get(packageAgentProfileKey(entry.uid)) === profile.name
    && ctx.config.get(packageAgentHumanUidKey(entry.uid)) === String(humanUid)
  ));
  if (matches.length > 1) {
    throw new Error(
      `Package agent identity collision for ${scope}/${record.packageId}#${profile.name}/${humanUid}`,
    );
  }
  const entry = matches[0] ?? null;
  if (!entry) return null;

  const identity = ctx.auth.getAccountIdentity(entry.username);
  if (
    !identity
    || identity.uid !== entry.uid
    || identity.kind !== "agent"
    || identity.state !== "active"
  ) {
    throw new Error(`Invalid package agent identity: ${entry.username}`);
  }
  return entry;
}

/**
 * Provision or reconcile the account for one exact package scope/profile.
 * The optional uid is retained for call-site compatibility; membership is
 * derived from the authoritative package scope, never from the caller.
 */
export async function ensurePackageAgent(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  enablingHumanUid?: number,
): Promise<ProcessIdentity> {
  const humanUid = resolveEntitledHumanUid(record, enablingHumanUid);
  const securityRevision = await packageAgentSecurityRevision(record, profile);
  let entry = findPackageAgentAccount(ctx, record, profile, humanUid);
  if (!entry) {
    const reservationKey = packageAgentReservationKey(record, profile, humanUid);
    let username = ctx.config.get(reservationKey);
    if (!username) {
      username = allocatePackageAgentUsername(ctx);
      // Persist the tuple mapping before account creation. createAccount commits
      // SQL identity before async home seeding, so retries must recover the same
      // principal rather than allocating a second one.
      ctx.config.set(reservationKey, username);
    }
    const accessGroupName = packageAgentAccessGroup(username);
    entry = ctx.auth.getPasswdByUsername(username);
    if (!entry) {
      try {
        const created = await createAccount(ctx, {
          kind: "agent",
          username,
          gecos: profile.displayName || `${record.manifest.name}#${profile.name}`,
          shared: false,
          capabilities: [...PACKAGE_AGENT_BASELINE, ...(profile.capabilities ?? [])],
          accessGroupName,
          contextFiles: profile.contextFiles.map((file) => ({ name: file.name, text: file.text })),
        });
        entry = ctx.auth.getPasswdByUid(created.identity.uid);
      } catch (error) {
        entry = ctx.auth.getPasswdByUsername(username);
        if (entry) {
          stampPackageAgentTuple(ctx, entry, record, profile, humanUid, accessGroupName);
        }
        throw error;
      }
    } else {
      assertRecoverableReservedPackageAgent(ctx, entry);
    }
    if (!entry) {
      throw new Error("Package agent account was not persisted");
    }
    stampPackageAgentTuple(ctx, entry, record, profile, humanUid, accessGroupName);
  }

  const accessGroupName = packageAgentAccessGroup(entry.username);
  ensurePackageAgentAccessGroup(ctx, entry.uid, accessGroupName);
  await ensureAccountHomeLayout(ctx.env, accountIdentity(ctx.auth, entry), {
    seedPromptContext: true,
  });
  await reconcilePackageAgentProfile(ctx, entry, profile);
  setPackageAgentAccessMembers(ctx, entry, [requireActivePackageOwner(ctx, humanUid).username]);
  ctx.config.set(packageAgentSecurityRevisionKey(entry.uid), securityRevision);
  return accountIdentity(ctx.auth, entry);
}

/** Provision every active profile in a record. */
export async function provisionEnabledPackageAgents(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  enablingHumanUid?: number,
): Promise<void> {
  if (!isActivePackageAgentRecord(record)) return;
  for (const humanUid of entitledHumanUids(ctx, record, enablingHumanUid)) {
    for (const profile of record.manifest.profiles ?? []) {
      await ensurePackageAgent(ctx, record, profile, humanUid);
    }
  }
}

/**
 * Reconcile the complete desired package-agent state. Removed, disabled,
 * unreviewed, and renamed profiles lose access and capabilities in the same
 * operation that reconciles active profiles.
 */
export async function reconcilePackageAgentEntitlements(
  ctx: KernelContext,
  records: readonly InstalledPackageRecord[] = ctx.packages.list({}),
): Promise<void> {
  const desired = new Map<string, {
    record: InstalledPackageRecord;
    profile: PackageProfileManifest;
    humanUid: number;
  }>();
  for (const record of records) {
    if (!isActivePackageAgentRecord(record)) continue;
    for (const humanUid of entitledHumanUids(ctx, record)) {
      for (const profile of record.manifest.profiles ?? []) {
        const key = packageAgentTupleKey(record, profile, humanUid);
        if (desired.has(key)) {
          throw new Error(`Duplicate package agent entitlement: ${key}`);
        }
        desired.set(key, { record, profile, humanUid });
      }
    }
  }

  for (const { record, profile, humanUid } of desired.values()) {
    await ensurePackageAgent(ctx, record, profile, humanUid);
  }

  for (const agent of listStampedPackageAgents(ctx)) {
    if (
      agent.scope
      && agent.humanUid !== null
      && desired.has(JSON.stringify([agent.scope, agent.packageId, agent.profileName, agent.humanUid]))
    ) {
      continue;
    }
    await deactivatePackageAgent(ctx, agent.entry);
  }
}

/** Setup compatibility wrapper; caller identity never defines entitlement. */
export async function provisionEnabledPackagesForCaller(
  ctx: KernelContext,
  records: readonly InstalledPackageRecord[],
): Promise<void> {
  await reconcilePackageAgentEntitlements(ctx, records);
}

/** Resolve and authorize a human-facing `package#profile` run-as selector. */
export function resolvePackageAgentRunAs(
  ctx: KernelContext,
  reference: string,
  ownerUid: number,
  isRoot: boolean,
): { ok: true; identity: ProcessIdentity } | { ok: false; error: string } {
  let resolved;
  try {
    resolved = resolvePackageProfileReference(
      reference,
      ctx.packages,
      visiblePackageScopesForActor({ uid: ownerUid }),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!resolved || !isActivePackageAgentRecord(resolved.record)) {
    return {
      ok: false,
      error: `Package agent unavailable: ${reference} (enable and review the package first)`,
    };
  }

  let entry: PasswdEntry | null;
  try {
    entry = findPackageAgentAccount(ctx, resolved.record, resolved.packageProfile, ownerUid);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!entry) {
    return {
      ok: false,
      error: `Package agent not provisioned: ${reference}`,
    };
  }

  if (!isRoot) {
    const ownerName = ctx.auth.getPasswdByUid(ownerUid)?.username;
    const group = ctx.auth.getGroupByName(packageAgentAccessGroup(entry.username));
    if (!ownerName || !group?.members.includes(ownerName)) {
      return { ok: false, error: `Permission denied: cannot run as ${reference}` };
    }
  }
  return { ok: true, identity: accountIdentity(ctx.auth, entry) };
}

function allocatePackageAgentUsername(ctx: KernelContext): string {
  for (let attempt = 0; attempt < PACKAGE_AGENT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const random = crypto.randomUUID().replaceAll("-", "").slice(0, PACKAGE_AGENT_RANDOM_CHARACTERS);
    const username = `${PACKAGE_AGENT_USERNAME_PREFIX}${random}`;
    if (
      isUsernameAvailable(ctx.auth, username)
      && !ctx.auth.getGroupByName(packageAgentAccessGroup(username))
    ) {
      return username;
    }
  }
  throw new Error("Unable to allocate a package agent identity");
}

function entitledHumanUids(
  ctx: KernelContext,
  record: InstalledPackageRecord,
  requestedHumanUid?: number,
): number[] {
  if (record.scope.kind === "user") {
    return [requireActivePackageOwner(ctx, record.scope.uid).uid];
  }
  if (requestedHumanUid !== undefined) {
    return [requireActivePackageOwner(ctx, requestedHumanUid).uid];
  }
  return ctx.auth.getPasswdEntries().flatMap((entry) => {
    const identity = ctx.auth.getAccountIdentity(entry.username);
    return identity?.uid === entry.uid
      && identity.state === "active"
      && (
        identity.kind === "human"
        || (identity.kind === "system" && entry.uid === 0 && entry.username === "root")
      )
      ? [entry.uid]
      : [];
  }).sort((left, right) => left - right);
}

function resolveEntitledHumanUid(
  record: InstalledPackageRecord,
  requestedHumanUid?: number,
): number {
  if (record.scope.kind === "user") {
    if (requestedHumanUid !== undefined && requestedHumanUid !== record.scope.uid) {
      throw new Error("User-scoped package agent owner does not match its install scope");
    }
    return record.scope.uid;
  }
  if (requestedHumanUid === undefined) {
    throw new Error("Global package agent provisioning requires an owning human uid");
  }
  return requestedHumanUid;
}

function requireActivePackageOwner(ctx: KernelContext, uid: number): PasswdEntry {
  const entry = ctx.auth.getPasswdByUid(uid);
  const identity = entry ? ctx.auth.getAccountIdentity(entry.username) : null;
  const isRoot = entry?.uid === 0
    && entry.username === "root"
    && identity?.kind === "system";
  if (
    !entry
    || !identity
    || identity.uid !== entry.uid
    || (identity.kind !== "human" && !isRoot)
    || identity.state !== "active"
  ) {
    throw new Error(`Package agent owner is not an active login account: ${uid}`);
  }
  return entry;
}

function assertRecoverableReservedPackageAgent(ctx: KernelContext, entry: PasswdEntry): void {
  const identity = ctx.auth.getAccountIdentity(entry.username);
  if (
    !identity
    || identity.uid !== entry.uid
    || identity.kind !== "agent"
    || identity.state !== "active"
  ) {
    throw new Error(`Reserved package agent identity is unavailable: ${entry.username}`);
  }
}

function stampPackageAgentTuple(
  ctx: KernelContext,
  entry: PasswdEntry,
  record: InstalledPackageRecord,
  profile: PackageProfileManifest,
  humanUid: number,
  accessGroupName: string,
): void {
  const expected = [
    [packageAgentOwnerKey(entry.uid), record.packageId],
    [packageAgentScopeKey(entry.uid), packageScopeKey(record.scope)],
    [packageAgentProfileKey(entry.uid), profile.name],
    [packageAgentHumanUidKey(entry.uid), String(humanUid)],
    [packageAgentAccessGroupKey(entry.uid), accessGroupName],
  ] as const;
  for (const [key, value] of expected) {
    const current = ctx.config.get(key);
    if (current !== null && current !== value) {
      throw new Error(`Package agent tuple collision for ${entry.username}`);
    }
    ctx.config.set(key, value);
  }
  if (ctx.config.get(packageAgentContextFilesKey(entry.uid)) === null) {
    ctx.config.set(
      packageAgentContextFilesKey(entry.uid),
      JSON.stringify(profileContextFileNames(profile)),
    );
  }
}

function ensurePackageAgentAccessGroup(
  ctx: KernelContext,
  agentUid: number,
  groupName: string,
): void {
  const key = packageAgentAccessGroupKey(agentUid);
  const stampedGroupName = ctx.config.get(key);
  if (stampedGroupName && stampedGroupName !== groupName) {
    throw new Error(
      `Package agent access group collision: agent ${agentUid} is stamped for "${stampedGroupName}"`,
    );
  }
  const group = ctx.auth.getGroupByName(groupName);
  if (group) {
    if (stampedGroupName !== groupName) {
      throw new Error(`Package agent access group collision: ${groupName}`);
    }
    return;
  }
  ctx.auth.addGroup({ name: groupName, gid: ctx.auth.allocateGid(), members: [] });
  ctx.config.set(key, groupName);
}

function setPackageAgentAccessMembers(
  ctx: KernelContext,
  entry: PasswdEntry,
  members: readonly string[],
): void {
  const groupName = ctx.config.get(packageAgentAccessGroupKey(entry.uid))
    ?? packageAgentAccessGroup(entry.username);
  const group = ctx.auth.getGroupByName(groupName);
  if (!group) {
    throw new Error(`Package agent access group is missing: ${groupName}`);
  }
  const next = [...new Set(members)].sort();
  const current = [...group.members].sort();
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    ctx.auth.updateGroupMembers(groupName, next);
  }
}

async function reconcilePackageAgentProfile(
  ctx: KernelContext,
  entry: PasswdEntry,
  profile: PackageProfileManifest,
): Promise<void> {
  const desiredCapabilities = new Set([...PACKAGE_AGENT_BASELINE, ...(profile.capabilities ?? [])]);
  const currentCapabilities = new Set(ctx.caps.list(entry.gid).map((row) => row.capability));
  for (const capability of currentCapabilities) {
    if (!desiredCapabilities.has(capability)) ctx.caps.revoke(entry.gid, capability);
  }
  for (const capability of desiredCapabilities) {
    if (!currentCapabilities.has(capability)) ctx.caps.grant(entry.gid, capability);
  }

  const approvalKey = `users/${entry.uid}/ai/tools/approval`;
  if (profile.approvalPolicy) ctx.config.set(approvalKey, profile.approvalPolicy);
  else ctx.config.delete(approvalKey);

  const contextFilesKey = packageAgentContextFilesKey(entry.uid);
  const previousNames = parseContextFileNames(ctx.config.get(contextFilesKey));
  const nextNames = new Set(profileContextFileNames(profile));
  const identity = accountIdentity(ctx.auth, entry);
  for (const file of profile.contextFiles) {
    await writeContextFile(ctx.env, identity, file.name, file.text);
  }
  for (const previousName of previousNames) {
    if (!nextNames.has(previousName)) {
      await removeContextFile(ctx.env, identity, previousName);
    }
  }
  ctx.config.set(contextFilesKey, JSON.stringify([...nextNames].sort()));
}

async function deactivatePackageAgent(ctx: KernelContext, entry: PasswdEntry): Promise<void> {
  // Invalidate durable executions before the slower profile cleanup. The tuple
  // stamps stay reserved forever, while absence of a revision fails closed.
  ctx.config.delete(packageAgentSecurityRevisionKey(entry.uid));
  const groupName = ctx.config.get(packageAgentAccessGroupKey(entry.uid))
    ?? packageAgentAccessGroup(entry.username);
  const group = ctx.auth.getGroupByName(groupName);
  if (group?.members.length) {
    ctx.auth.updateGroupMembers(groupName, []);
  }
  for (const capability of ctx.caps.list(entry.gid)) {
    ctx.caps.revoke(entry.gid, capability.capability);
  }
  ctx.config.delete(`users/${entry.uid}/ai/tools/approval`);
  const identity = accountIdentity(ctx.auth, entry);
  const contextKey = packageAgentContextFilesKey(entry.uid);
  for (const name of parseContextFileNames(ctx.config.get(contextKey))) {
    await removeContextFile(ctx.env, identity, name);
  }
  ctx.config.set(contextKey, "[]");
}

function listStampedPackageAgents(ctx: KernelContext): Array<{
  entry: PasswdEntry;
  packageId: string;
  scope: string | null;
  profileName: string;
  humanUid: number | null;
}> {
  return ctx.auth.getPasswdEntries().flatMap((entry) => {
    const packageId = ctx.config.get(packageAgentOwnerKey(entry.uid));
    const profileName = ctx.config.get(packageAgentProfileKey(entry.uid));
    if (!packageId || !profileName) return [];
    return [{
      entry,
      packageId,
      scope: ctx.config.get(packageAgentScopeKey(entry.uid)),
      profileName,
      humanUid: parseHumanUid(ctx.config.get(packageAgentHumanUidKey(entry.uid))),
    }];
  });
}

function parseHumanUid(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function profileContextFileNames(profile: PackageProfileManifest): string[] {
  return [...new Set(profile.contextFiles.map((file) => file.name))].sort();
}

function parseContextFileNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}
