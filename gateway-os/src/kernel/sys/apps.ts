import type { SysAppOpenArgs, SysAppOpenResult } from "../../syscalls/app";
import type { KernelContext } from "../context";
import { openAppSession } from "../apps";

export function handleSysAppOpen(
  args: SysAppOpenArgs,
  ctx: KernelContext,
): SysAppOpenResult {
  return openAppSession(args, ctx);
}
