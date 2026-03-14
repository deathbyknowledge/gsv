import type { KernelContext } from "./context";
import type { SysLinkConsumeArgs, SysLinkConsumeResult } from "../syscalls/system";

export function handleSysLinkConsume(
  args: SysLinkConsumeArgs,
  ctx: KernelContext,
): SysLinkConsumeResult {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error("Authentication required");
  }

  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";
  if (!code) {
    throw new Error("code is required");
  }

  const challenge = ctx.adapters.linkChallenges.consume(code, identity.process.uid);
  if (!challenge) {
    throw new Error("Invalid or expired link code");
  }

  const link = ctx.adapters.identityLinks.link(
    challenge.adapter,
    challenge.accountId,
    challenge.actorId,
    identity.process.uid,
    identity.process.uid,
    { code: challenge.code, surfaceKind: challenge.surfaceKind, surfaceId: challenge.surfaceId },
  );

  return {
    linked: true,
    link: {
      adapter: link.adapter,
      accountId: link.accountId,
      actorId: link.actorId,
      uid: link.uid,
      createdAt: link.createdAt,
    },
  };
}
