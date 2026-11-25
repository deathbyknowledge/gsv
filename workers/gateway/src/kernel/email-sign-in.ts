import type { ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import type { OwnerSignInVerification } from "@humansandmachines/gsv/services/ownership";
import { emitTelemetry, telemetryErrorTypeSchema } from "@humansandmachines/gsv/telemetry";
import { ZodError, z } from "zod";
import { emailSignInConfigured } from "../installation/lifecycle";
import { PersonalAccountUnavailableError, signInSessionSchema } from "./account-recovery";
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
    source: ctx.connection?.state.source ?? "unknown", ...(args.resend ? { resend: true } : undefined),
    ...(ctx.connection?.state.origin ? { origin: ctx.connection.state.origin } : undefined) });
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

/** A failed sign-in's answer: the refusal, and for an unexpected failure the reference to its record. */
export type EmailSignInFailed = { status: 400 | 429; details: { signIn: EmailSignInFailure } | { signIn: "unavailable"; diagnosticId: string } };

/** The latest unexpected sign-in failure, kept only in this Kernel for operator inspection. */
export const EMAIL_SIGN_IN_FAILURE_KEY = "email_sign_in_failure";

/**
 * What a failed sign-in answers. A refusal names only what the person can do about it. Any other failure keeps its
 * cause in this Kernel's private record; the answer and telemetry carry only its reference.
 */
export function emailSignInFailed(call: "start" | "redeem", error: Error, kernel: Pick<KernelContext, "env" | "installationId">,
  storage: Pick<DurableObjectStorage, "kv">): EmailSignInFailed {
  if (error instanceof EmailSignInError) return { status: error.reason === "locked" ? 429 : 400, details: { signIn: error.reason } };
  if (error instanceof PersonalAccountUnavailableError || error instanceof ZodError) return { status: 400, details: { signIn: "unavailable" } };
  const diagnosticId = crypto.randomUUID();
  storage.kv.put(EMAIL_SIGN_IN_FAILURE_KEY, { diagnosticId, call, recordedAt: Date.now(),
    cause: (error.stack ?? error.message).slice(0, 8192) });
  emitTelemetry(kernel.env, { installationId: kernel.installationId, component: "gateway", event: {
    stream: "operational", name: "account.signin.failed",
    properties: { diagnosticId, call, errorType: telemetryErrorTypeSchema.safeParse(error.name).data ?? "unknown" },
  } });
  return { status: 400, details: { signIn: "unavailable", diagnosticId } };
}

function configuredOwnership(ctx: KernelContext) {
  const ownership = ctx.env.INSTALLATION_OWNERSHIP;
  if (!ownership || !emailSignInConfigured(ctx.env)) throw new EmailSignInError("unavailable");
  return ownership;
}
