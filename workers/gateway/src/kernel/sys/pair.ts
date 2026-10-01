import { z } from "zod";
import {
  PAIRING_CREDENTIAL_PATTERN, PAIRING_SECRET_PATTERN, PAIRING_TARGET_PATTERN,
  type SysPairCreateArgs, type SysPairCreateResult, type SysPairCancelArgs, type SysPairCancelResult,
  type SysPairListResult, type SysPairRedeemArgs, type SysPairRedeemResult,
} from "@humansandmachines/gsv/protocol";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "../context";
import { DevicePairingCreateError } from "../device-pairings";
import { authorizeNestedOperation } from "../tool-approval";

const createSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(PAIRING_SECRET_PATTERN),
  targetId: z.string().regex(PAIRING_TARGET_PATTERN), label: z.string().trim().min(1).max(100).refine((value) => !/[\p{Cc}]/u.test(value)), replace: z.boolean().optional() });
const redeemSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(PAIRING_SECRET_PATTERN), credential: z.string().regex(PAIRING_CREDENTIAL_PATTERN) });

function pairingOwnerUid(ctx: KernelContext): number {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human") throw new Error("Pairing requires a signed-in human");
  return resolveCallerOwnerUid(ctx);
}

export async function handleSysPairCreate(args: SysPairCreateArgs, ctx: KernelContext): Promise<SysPairCreateResult> {
  const uid = pairingOwnerUid(ctx);
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) throw new DevicePairingCreateError("Invalid pairing invitation. Check the name and target ID.");
  const { targetId, label, replace } = parsed.data;
  await authorizeNestedOperation(ctx, "sys.pair.create", { targetId, label, replace: replace ?? false });
  return { pairing: await ctx.pairings.create(uid, parsed.data, ctx.requestSignal) };
}

export function handleSysPairList(ctx: KernelContext): SysPairListResult {
  return { pairings: ctx.pairings.list(pairingOwnerUid(ctx)) };
}

export async function handleSysPairCancel(args: SysPairCancelArgs, ctx: KernelContext): Promise<SysPairCancelResult> {
  const uid = pairingOwnerUid(ctx);
  await authorizeNestedOperation(ctx, "sys.pair.cancel", { id: args.id });
  ctx.requestSignal?.throwIfAborted();
  return { pairing: ctx.pairings.cancel(uid, args.id) };
}

export async function handleSysPairRedeem(args: SysPairRedeemArgs, ctx: KernelContext): Promise<SysPairRedeemResult> {
  const parsed = redeemSchema.safeParse(args);
  if (!parsed.success) throw new Error("Invalid pairing invitation or device credential");
  return ctx.pairings.redeem(parsed.data);
}
