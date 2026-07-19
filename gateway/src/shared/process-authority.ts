import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

export type ProcessAuthority = {
  processId: string;
  identity: ProcessIdentity;
  ownerIdentity: ProcessIdentity;
};

export type ProcessAuthorityResult =
  | { ok: true; authority: ProcessAuthority }
  | { ok: false; error: string };

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<ProcessIdentity>;
  return isUnixId(identity.uid)
    && isUnixId(identity.gid)
    && Array.isArray(identity.gids)
    && identity.gids.every(isUnixId)
    && typeof identity.username === "string"
    && identity.username.length > 0
    && typeof identity.home === "string"
    && identity.home.length > 0
    && typeof identity.cwd === "string"
    && identity.cwd.length > 0;
}

export function processIdentityEquals(
  left: ProcessIdentity,
  right: ProcessIdentity,
  options: { includeCwd?: boolean } = {},
): boolean {
  const leftGids = [...left.gids].sort((a, b) => a - b);
  const rightGids = [...right.gids].sort((a, b) => a - b);
  return left.uid === right.uid
    && left.gid === right.gid
    && left.username === right.username
    && left.home === right.home
    && (!options.includeCwd || left.cwd === right.cwd)
    && leftGids.length === rightGids.length
    && leftGids.every((gid, index) => gid === rightGids[index]);
}

function isUnixId(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}
