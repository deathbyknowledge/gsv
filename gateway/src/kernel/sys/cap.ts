/**
 * sys.cap.list — read group capability records.
 *
 * Root sees the full capability map. Non-root callers see the system groups
 * (gid < 1000, deliberately public security policy) plus groups they belong
 * to — the same visibility the Kernel directory exposes at /sys/capabilities.
 */

import type {
  SysCapListArgs,
  SysCapListResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";

export function handleSysCapList(
  args: SysCapListArgs,
  ctx: KernelContext,
): SysCapListResult {
  const identity = ctx.identity!;
  const isRoot = identity.process.uid === 0;
  const memberGids = new Set(identity.process.gids);
  const visible = (gid: number) => isRoot || gid < 1000 || memberGids.has(gid);

  if (typeof args.gid === "number") {
    if (!Number.isSafeInteger(args.gid) || args.gid < 0) {
      throw new Error("Invalid gid");
    }
    if (!visible(args.gid)) {
      throw new Error(`Permission denied: cannot list capabilities of gid ${args.gid}`);
    }
  }

  const records = ctx.caps
    .list(args.gid)
    .filter((record) => visible(record.gid))
    .map((record) => ({ gid: record.gid, capability: record.capability }));
  return { records };
}
