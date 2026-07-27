import type { PasswdEntry } from "../auth/passwd";
import type { KernelContext } from "./context";

export const USER_ADMIN_CAPABILITY = "user.admin";

/**
 * Require ship-level user administration authority from current durable state.
 *
 * uid 0 is the only root identity. Delegated administration must be granted
 * directly on the human's primary gid so a personal agent cannot inherit it
 * through its supplementary membership in the human's private group.
 */
export function requireUserAdmin(ctx: KernelContext): PasswdEntry {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error("Permission denied");
  }

  const account = ctx.auth.getPasswdByUid(identity.process.uid);
  if (!account || account.username !== identity.process.username) {
    throw new Error("Permission denied");
  }
  if (account.uid === 0) {
    return account;
  }

  const directlyGranted = ctx.caps
    .list(account.gid)
    .some((entry) => entry.capability === USER_ADMIN_CAPABILITY);
  if (!directlyGranted) {
    throw new Error("Permission denied");
  }

  return account;
}
