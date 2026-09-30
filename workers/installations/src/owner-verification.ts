import { escapeHtml } from "./admin/page";
import { InstallationOwnerAuthStore, type IssuedOwnerCode, type OwnerCodeRequest } from "./owner-auth-store";

/** Both browser and native sign-in share the durable delivery lease and receipt. */
export async function sendOwnerVerification(auth: InstallationOwnerAuthStore, mail: SendEmail, from: string,
  input: OwnerCodeRequest): Promise<Pick<IssuedOwnerCode, "challengeId" | "expiresAt" | "retryAt" | "deliveryStatus"> & { attemptedDelivery: boolean }> {
  const issued = await auth.issue(input);
  let deliveryStatus = issued.deliveryStatus;
  if (issued.sendRequired && issued.deliveryId) {
    let sent = false;
    try {
      const purpose = input.purpose === "recover" ? "root recovery" : input.purpose === "link" ? "space ownership" : "sign-in";
      const text = `Your GSV ${purpose} code is ${issued.code}.\n\nThis code expires at ${new Date(issued.expiresAt).toUTCString()} and works only where you requested it. Do not share it.\n\nIf you did not request this code, you can ignore this email.`;
      await mail.send({ from: { email: from, name: "GSV" }, to: issued.email, subject: `Your GSV ${purpose} code`, text,
        html: `<p>${escapeHtml(text).replaceAll("\n\n", "</p><p>").replaceAll("\n", "<br>")}</p>` });
      sent = true;
    } catch {
      // Delivery errors can contain addresses and mail bodies. Only expose the outcome.
    }
    await auth.recordDelivery({ challengeId: input.challengeId, deliveryId: issued.deliveryId, browserSecret: input.browserSecret, sent });
    deliveryStatus = sent ? "sent" : "failed";
  }
  return { challengeId: issued.challengeId, expiresAt: issued.expiresAt, retryAt: issued.retryAt, deliveryStatus, attemptedDelivery: issued.sendRequired };
}
