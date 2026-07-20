import type { SyscallName } from "../syscalls";

const MASTER_OWNED_SYSCALLS = new Set<SyscallName>([
  "sys.bootstrap",
  "sys.config.get",
  "sys.config.set",
  "sys.token.create",
  "sys.token.list",
  "sys.token.revoke",
  "sys.link",
  "sys.unlink",
  "sys.link.list",
  "sys.link.consume",
  "account.create",
  "account.list",
  "pkg.list",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.remote.list",
  "pkg.remote.add",
  "pkg.remote.remove",
  "pkg.public.list",
  "pkg.public.set",
  "adapter.connect",
  "adapter.disconnect",
  "adapter.state.update",
  "adapter.send",
  "adapter.status",
  "adapter.list",
]);

const MASTER_MUTATIONS_REQUIRING_PROJECTION_REFRESH = new Set<SyscallName>([
  "sys.bootstrap",
  "sys.config.set",
  "account.create",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.remote.add",
  "pkg.remote.remove",
  "pkg.public.set",
]);

// A package mutation can persist its package record and then fail while
// reconciling one of many owner-specific principals. The error response has no
// trustworthy final scope, so convergence deliberately invalidates every user
// Kernel instead of pretending the mutation was atomic.
const FAILED_MUTATIONS_REQUIRING_GLOBAL_PACKAGE_INVALIDATION = new Set<SyscallName>([
  "sys.bootstrap",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.public.set",
]);

const FAILED_MUTATIONS_REQUIRING_GLOBAL_REPO_INVALIDATION = new Set<SyscallName>([
  "pkg.create",
  "pkg.public.set",
]);

const MASTER_MUTATIONS_REQUIRING_PACKAGE_PROJECTION_FENCE = new Set<SyscallName>([
  "sys.bootstrap",
  "account.create",
  "pkg.add",
  "pkg.create",
  "pkg.sync",
  "pkg.checkout",
  "pkg.install",
  "pkg.review.approve",
  "pkg.remove",
  "pkg.public.set",
]);

/**
 * Rare ship-wide operations with an explicit master owner. This is a closed
 * allowlist, not a missing-state fallback: all unlisted calls execute in the
 * caller's user Kernel.
 */
export function isMasterOwnedSyscall(call: SyscallName): boolean {
  return MASTER_OWNED_SYSCALLS.has(call);
}

export function masterMutationNeedsProjectionRefresh(call: SyscallName): boolean {
  return MASTER_MUTATIONS_REQUIRING_PROJECTION_REFRESH.has(call);
}

export function failedMasterMutationNeedsGlobalPackageInvalidation(
  call: SyscallName,
): boolean {
  return FAILED_MUTATIONS_REQUIRING_GLOBAL_PACKAGE_INVALIDATION.has(call);
}

export function failedMasterMutationNeedsGlobalRepoInvalidation(
  call: SyscallName,
): boolean {
  return FAILED_MUTATIONS_REQUIRING_GLOBAL_REPO_INVALIDATION.has(call);
}

/** Mutations that can create, reconcile, revoke, or replace package principals. */
export function masterMutationNeedsPackageProjectionFence(call: SyscallName): boolean {
  return MASTER_MUTATIONS_REQUIRING_PACKAGE_PROJECTION_FENCE.has(call);
}
