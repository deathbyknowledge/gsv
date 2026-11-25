import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationOwnershipService, OwnerSignInCodeInput, OwnerSignInVerification, OwnerSignInVerifyInput,
} from "@humansandmachines/gsv/services/ownership";

/** The owner email of every integration Ship, and the one code its inbox receives. */
export const INTEGRATION_OWNER_EMAIL = "owner@example.com";
export const INTEGRATION_SIGN_IN_CODE = "246810";

const sent = new Map<string, { installationId: string; expiresAt: number }>();

/**
 * Accounts' answers to a Kernel's email sign-in, without mail: only the owner's email receives a code, and a correct
 * one becomes the same claim for as long as the attempt lasts.
 */
export class IntegrationOwnerSignIn extends WorkerEntrypoint implements Pick<InstallationOwnershipService, "sendOwnerSignInCode" | "verifyOwnerSignIn"> {
  async sendOwnerSignInCode(input: OwnerSignInCodeInput): Promise<{ accepted: true }> {
    if (input.email === INTEGRATION_OWNER_EMAIL && !sent.has(input.attemptId)) {
      sent.set(input.attemptId, { installationId: input.installationId, expiresAt: Date.now() + 5 * 60_000 });
    }
    return { accepted: true };
  }

  async verifyOwnerSignIn(input: OwnerSignInVerifyInput): Promise<OwnerSignInVerification> {
    const attempt = sent.get(input.attemptId);
    if (!attempt || attempt.installationId !== input.installationId || input.code !== INTEGRATION_SIGN_IN_CODE) return { failed: "invalid" };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.secret));
    const secretHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { authorized: { installationId: input.installationId, attemptId: input.attemptId, purpose: "root-password-reset", secretHash, expiresAt: attempt.expiresAt } };
  }
}
