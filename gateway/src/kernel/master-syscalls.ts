import type { SyscallName } from "../syscalls";

const MASTER_OWNED_SYSCALLS = new Set<SyscallName>([
  "sys.bootstrap",
  "sys.config.get",
  "sys.config.set",
  "sys.cap.list",
  "sys.token.create",
  "sys.token.list",
  "sys.token.revoke",
  "sys.link",
  "sys.unlink",
  "sys.link.list",
  "sys.link.consume",
  "account.create",
  "account.list",
  "account.get",
  "repo.list",
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

/**
 * Rare ship-wide operations with an explicit master owner. This is a closed
 * allowlist, not a missing-state fallback: all unlisted calls execute in the
 * caller's user Kernel.
 */
export function isMasterOwnedSyscall(call: SyscallName): boolean {
  return MASTER_OWNED_SYSCALLS.has(call);
}
