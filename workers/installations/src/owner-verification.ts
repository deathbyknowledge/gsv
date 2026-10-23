import { InstallationOwnerAuthStore, type IssuedOwnerCode, type OwnerCodeRequest } from "./owner-auth-store";
import { ownerVerificationEmail, type OwnerEmailSender } from "./owner-verification-email";

/** Both browser and native sign-in share the durable delivery lease and receipt. */
export async function sendOwnerVerification(auth: InstallationOwnerAuthStore, mail: SendEmail, sender: OwnerEmailSender,
  input: OwnerCodeRequest): Promise<Pick<IssuedOwnerCode, "challengeId" | "expiresAt" | "retryAt" | "deliveryStatus"> & { attemptedDelivery: boolean }> {
  const issued = await auth.issue(input);
  let deliveryStatus = issued.deliveryStatus;
  if (issued.sendRequired && issued.deliveryId) {
    let sent = false;
    try {
      await mail.send({ from: { email: sender.from, name: "Ship" }, to: issued.email,
        ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        ...ownerVerificationEmail(input.purpose, issued.code, issued.expiresAt) });
      sent = true;
    } catch {
      // Delivery errors can contain addresses and mail bodies. Only expose the outcome.
    }
    await auth.recordDelivery({ challengeId: input.challengeId, deliveryId: issued.deliveryId, browserSecret: input.browserSecret, sent });
    deliveryStatus = sent ? "sent" : "failed";
  }
  return { challengeId: issued.challengeId, expiresAt: issued.expiresAt, retryAt: issued.retryAt, deliveryStatus, attemptedDelivery: issued.sendRequired };
}
