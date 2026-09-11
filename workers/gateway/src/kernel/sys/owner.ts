import { z } from "zod";
import { principalOf, type KernelContext } from "../context";
import { sha256 } from "../account-recovery";

const ownerLinkSchema = z.strictObject({ id: z.uuid(), secret: z.string().min(32).max(256) });

export async function handleOwnerLink(input: { id: string; secret: string }, ctx: KernelContext): Promise<{ url: string; expiresAt: number }> {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || principal.account.uid !== 0 || ctx.peer?.provenance.kind !== "credential") throw new Error("Owner linking requires a signed-in root human");
  const args = ownerLinkSchema.parse(input);
  if (!ctx.env.INSTALLATION_OWNERSHIP || !ctx.installationIdentity) throw new Error("Owner linking is not configured");
  const epoch = ctx.auth.credentialEpoch(0);
  if (ctx.connection && (ctx.connection.state.step !== "connected" || (ctx.connection.state.credentialEpoch ?? 0) !== epoch)) throw new Error("Root credentials changed; sign in again");
  const secretHash = await sha256(args.secret);
  ctx.accountRecovery.beginOwnerLink(args.id, secretHash, epoch);
  const result = await ctx.env.INSTALLATION_OWNERSHIP.beginInstallationOwnerLink({ installationId: ctx.installationId, attemptId: args.id, secretHash });
  const url = new URL(result.url);
  url.hash = new URLSearchParams({ id: args.id, secret: args.secret }).toString();
  return { url: url.href, expiresAt: result.expiresAt };
}
