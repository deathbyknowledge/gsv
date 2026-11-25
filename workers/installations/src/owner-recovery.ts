import type { AuthorizeRootRecoveryInput } from "@humansandmachines/gsv/services/ownership";
import { InstallationOwnerAuthStore, OwnerAuthError } from "./owner-auth-store";
import { InstallationOwnerStore, OwnerAttemptUnavailableError, type OwnerRecoveryShip } from "./owner-store";
import { sendOwnerVerification } from "./owner-verification";
import type { OwnerEmailSender } from "./owner-verification-email";
import { sha256Hex } from "./tokens";

/** Longer than a normal send, so mailing the real owner takes no longer to answer than mailing nobody. */
export const RECOVERY_RESPONSE_FLOOR_MS = 1500;

export type OwnerRecoveryCode = {
  ship: OwnerRecoveryShip;
  /** The recovery attempt, which is also its code challenge. */
  attemptId: string;
  browserSecret: string;
  email: string;
  ip: string;
  resend: boolean;
  /** Email sign-in: the mail also links to the Ship, where the client that asked can finish without the code. */
  signIn?: { origin?: string };
};

export type VerifiedOwnerRecovery = { claim: AuthorizeRootRecoveryInput; canonicalOrigin: string; sessionExpiresAt: number };

/**
 * Recovery proves that someone holds the current owner's email for one Ship. Password recovery and email sign-in both
 * rest on it; the Kernel decides what the resulting one-time claim buys.
 */
export class InstallationOwnerRecovery {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly owners: InstallationOwnerStore,
    private readonly mail: SendEmail, private readonly sender: OwnerEmailSender, private readonly floorMs = RECOVERY_RESPONSE_FLOOR_MS) {}

  /**
   * The same answer whether or not this email owns this Ship, and whatever limit or delivery problem applied: only the
   * owner's inbox learns that the attempt was real. An unexpected failure reaches the caller after the same wait.
   */
  async sendCode(input: OwnerRecoveryCode): Promise<void> {
    const answer = new Promise((resolve) => setTimeout(resolve, this.floorMs));
    try {
      const attempt = input.resend ? await this.owners.get(input.attemptId) : await this.owners.beginRecovery(input.ship, input.attemptId);
      if (!attempt || attempt.purpose !== "recover" || ("installationId" in input.ship && attempt.installation_id !== input.ship.installationId)) {
        throw new OwnerAttemptUnavailableError("Owner recovery is unavailable");
      }
      if (!input.resend) await this.owners.startEmailAuthentication(input.attemptId, { browserSecretHash: await sha256Hex(input.browserSecret) });
      const origin = input.signIn ? await this.owners.signInOrigin(attempt.installation_id, input.signIn.origin) : null;
      const issued = await sendOwnerVerification(this.auth, this.mail, this.sender, {
        challengeId: input.attemptId, purpose: "recover", ownerAttemptId: input.attemptId, email: input.email,
        browserSecret: input.browserSecret, ip: input.ip, resend: input.resend,
      }, input.signIn ? { label: "sign-in", link: origin ? (code) => signInLink(origin, input.attemptId, code) : undefined } : undefined);
      if (issued.deliveryStatus === "failed") console.warn("[Owner] Recovery code delivery failed");
    } catch (error) {
      if (!(error instanceof OwnerAuthError) && !(error instanceof OwnerAttemptUnavailableError)) {
        await answer;
        throw error;
      }
    }
    await answer;
  }

  /** A correct code from the current owner's email: the claim for the Kernel and the Ship it belongs to. */
  async verify(input: { attemptId: string; browserSecret: string; sessionSecret: string; code: string }): Promise<VerifiedOwnerRecovery> {
    const challenge = { challengeId: input.attemptId, purpose: "recover" as const, ownerAttemptId: input.attemptId };
    const verified = await this.auth.verify({ ...challenge, code: input.code, browserSecret: input.browserSecret, sessionSecret: input.sessionSecret });
    await this.auth.receipt({ receiptId: verified.receiptId, browserSecret: input.browserSecret, purpose: "recover", ownerAttemptId: input.attemptId });
    const secretHash = await sha256Hex(input.browserSecret);
    const attempt = await this.owners.verifyPrincipal(input.attemptId, secretHash, verified.principalId);
    const destination = await this.owners.destination(attempt);
    return {
      claim: { installationId: destination.installationId, attemptId: attempt.id, purpose: "root-password-reset", secretHash, expiresAt: attempt.expires_at },
      canonicalOrigin: destination.canonicalOrigin,
      sessionExpiresAt: verified.sessionExpiresAt,
    };
  }
}

/** The Ship's own app finishes the attempt from this link only in the browser that holds its secret. */
export function signInLink(origin: string, attemptId: string, code: string): string {
  const url = new URL("/chat", origin);
  url.hash = new URLSearchParams({ signin: attemptId, code }).toString();
  return url.href;
}
