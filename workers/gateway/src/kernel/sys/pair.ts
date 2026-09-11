import { z } from "zod";
import {
  PAIRING_CREDENTIAL_PATTERN, PAIRING_SECRET_PATTERN, PAIRING_TARGET_PATTERN,
  type SysPairCreateArgs, type SysPairCreateResult, type SysPairCancelArgs, type SysPairCancelResult,
  type SysPairListResult, type SysPairRedeemArgs, type SysPairRedeemResult,
} from "@humansandmachines/gsv/protocol";
import { principalOf, type KernelContext } from "../context";
import { DevicePairingCreateError } from "../device-pairings";

const createSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(PAIRING_SECRET_PATTERN),
  targetId: z.string().regex(PAIRING_TARGET_PATTERN), label: z.string().trim().min(1).max(100).refine((value) => !/[\p{Cc}]/u.test(value)), replace: z.boolean().optional() });
const redeemSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(PAIRING_SECRET_PATTERN), credential: z.string().regex(PAIRING_CREDENTIAL_PATTERN) });

function requireHuman(ctx: KernelContext): number {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human") throw new Error("Pairing requires a signed-in human");
  return principal.account.uid;
}

export async function handleSysPairCreate(args: SysPairCreateArgs, ctx: KernelContext): Promise<SysPairCreateResult> {
  const uid = requireHuman(ctx);
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) throw new DevicePairingCreateError("Invalid pairing invitation. Check the name and target ID.");
  return { pairing: await ctx.pairings.create(uid, parsed.data) };
}

export function handleSysPairList(ctx: KernelContext): SysPairListResult {
  return { pairings: ctx.pairings.list(requireHuman(ctx)) };
}

export function handleSysPairCancel(args: SysPairCancelArgs, ctx: KernelContext): SysPairCancelResult {
  return { pairing: ctx.pairings.cancel(requireHuman(ctx), args.id) };
}

export async function handleSysPairRedeem(args: SysPairRedeemArgs, ctx: KernelContext): Promise<SysPairRedeemResult> {
  const parsed = redeemSchema.safeParse(args);
  if (!parsed.success) throw new Error("Invalid pairing invitation or device credential");
  return ctx.pairings.redeem(parsed.data);
}
