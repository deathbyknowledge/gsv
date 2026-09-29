import type { SysLedgerListArgs, SysLedgerListResult } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { resolveCallerOwnerUid } from "../context";
import { ledgerListArgsSchema } from "../ledger";

/**
 * Lists ledger lines newest first, paged by cursor. Visibility is the same rule
 * `proc.list` uses: a caller sees the lines of the human who owns them; root
 * sees every line.
 */
export async function handleSysLedgerList(
  args: SysLedgerListArgs,
  ctx: KernelContext,
): Promise<SysLedgerListResult> {
  if (!ctx.ledger) throw new Error("The ledger is not available");
  const parsed = ledgerListArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error("Invalid ledger query");
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  return ctx.ledger.list({
    ownerUid: callerOwnerUid === 0 ? null : callerOwnerUid,
    pid: parsed.data.pid,
    target: parsed.data.target,
    callPrefix: parsed.data.callPrefix,
    since: parsed.data.since,
    until: parsed.data.until,
    limit: parsed.data.limit ?? 50,
    cursor: parsed.data.cursor,
  });
}
