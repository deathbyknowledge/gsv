import type { KernelContext, PrincipalView } from "../context";
import { principalOf } from "../context";
import type {
  SysLinkListArgs,
  SysLinkListResult,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

/** How a managed link names the person, recorded when it connected. */
const linkDisplaySchema = z.object({
  actorName: z.catch(z.optional(z.string()), undefined),
  actorHandle: z.catch(z.optional(z.string()), undefined),
  linkedAt: z.catch(z.optional(z.number()), undefined),
});

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

  const links = ctx.adapters.identityLinks.list(uidFilter).map((link) => {
    const entry: SysLinkListResult["links"][number] = {
      adapter: link.adapter,
      accountId: link.accountId,
      actorId: link.actorId,
      uid: link.uid,
      createdAt: link.createdAt,
      linkedByUid: link.linkedByUid,
    };
    const display = linkDisplaySchema.parse(link.metadata ?? {});
    if (display.actorName) entry.actorName = display.actorName;
    if (display.actorHandle) entry.actorHandle = display.actorHandle;
    if (display.linkedAt !== undefined) entry.linkedAt = display.linkedAt;
    return entry;
  });

  return { links };
}

function requirePrincipalView(ctx: KernelContext): PrincipalView {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human") {
    throw new Error("Authentication required");
  }
  return identity;
}
