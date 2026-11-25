import type { ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import type { OwnerSignInVerification } from "@humansandmachines/gsv/services/ownership";
import { z } from "zod";
import { emailSignInConfigured } from "../installation/lifecycle";
import { signInSessionSchema } from "./account-recovery";
import type { KernelContext } from "./context";

const signInStartSchema = z.strictObject({
  id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), email: z.string().trim().min(3).max(254), resend: z.boolean().optional(),
});

export type EmailSignInFailure = Extract<OwnerSignInVerification, { failed: string }>["failed"];

/** What the person can do about a refused sign-in; nothing in it says whether an email owns this Ship. */
export class EmailSignInError extends Error {
  constructor(readonly reason: EmailSignInFailure) { super(`Email sign-in ${reason}`); }
}

/**
 * Email sign-in to the personal account rests on owner recovery: Accounts mails a code only to this Ship's owner and
 * turns a correct one into a claim, which this Kernel spends on a session. The client keeps the attempt's id and secret
 * and the session credential, so a lost answer at any step can be retried.
 */
export async function startEmailSignIn(input: ArgsOf<"account.signin.start">, ctx: KernelContext): Promise<ResultOf<"account.signin.start">> {
  const args = signInStartSchema.parse(input);
  const ownership = configuredOwnership(ctx);
  // A Ship that is still being set up has no personal account to sign in to; it answers the same way.
  if (ctx.auth.isSetupMode()) return { accepted: true };
  await ownership.sendOwnerSignInCode({ installationId: ctx.installationId, attemptId: args.id, secret: args.secret, email: args.email,
    source: ctx.connection?.state.source ?? "unknown", ...(args.resend ? { resend: true } : undefined) });
  return { accepted: true };
}

export async function redeemEmailSignIn(input: ArgsOf<"account.signin.redeem">, ctx: KernelContext): Promise<ResultOf<"account.signin.redeem">> {
  const args = signInSessionSchema.parse(input);
  const ownership = configuredOwnership(ctx);
  const previous = await ctx.accountRecovery.signedInSession(args);
  if (previous) return previous;
  const verification = await ownership.verifyOwnerSignIn({ installationId: ctx.installationId, attemptId: args.id, secret: args.secret, code: args.code });
  if ("failed" in verification) throw new EmailSignInError(verification.failed);
  return ctx.accountRecovery.openSession(verification.authorized, args);
}

function configuredOwnership(ctx: KernelContext) {
  const ownership = ctx.env.INSTALLATION_OWNERSHIP;
  if (!ownership || !emailSignInConfigured(ctx.env)) throw new EmailSignInError("unavailable");
  return ownership;
}
