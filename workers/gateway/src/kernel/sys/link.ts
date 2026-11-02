import type { KernelContext, PrincipalView } from "../context";
import { principalOf } from "../context";
import type {
  SysLinkListArgs,
  SysLinkListResult,
} from "@humansandmachines/gsv/protocol";

export function handleSysLinkList(
  args: SysLinkListArgs,
  ctx: KernelContext,
): SysLinkListResult {
  const identity = requirePrincipalView(ctx);

  let uidFilter: number | undefined;
  if (args.uid !== undefined) {
    if (identity.account.uid !== 0 && args.uid !== identity.account.uid) {
      throw new Error("Permission denied");
    }
    uidFilter = args.uid;
  } else if (identity.account.uid !== 0) {
    uidFilter = identity.account.uid;
  }

  const links = ctx.adapters.identityLinks.list(uidFilter).map((link) => ({
    adapter: link.adapter,
    accountId: link.accountId,
    actorId: link.actorId,
    uid: link.uid,
    createdAt: link.createdAt,
    linkedByUid: link.linkedByUid,
  }));

  return { links };
}

function requirePrincipalView(ctx: KernelContext): PrincipalView {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human") {
    throw new Error("Authentication required");
  }
  return identity;
}
