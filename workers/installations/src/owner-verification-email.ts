import { escapeHtml } from "./admin/page";
import type { OwnerAuthPurpose } from "./owner-auth-store";

export type OwnerEmailSender = { from: string; replyTo?: string };
/** Email sign-in rests on recovery, so it names its own purpose; its button opens the Ship that asked. */
export type OwnerEmailPresentation = { label: "sign-in"; link?: (code: string) => string };

export function ownerVerificationEmail(purpose: OwnerAuthPurpose, code: string, expiresAt: number, presentation?: OwnerEmailPresentation) {
  const label = presentation?.label ?? (purpose === "recover" ? "account recovery" : purpose === "link" ? "email verification" : "sign-in");
  const link = presentation?.link?.(code);
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  const introduction = link ? "Sign in on the device where you asked, or enter this code there:" : "Enter this code in Ship to continue:";
  const expiry = `This code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Don’t share it with anyone.`;
  const footer = "If you didn’t request this code, you can ignore this email.";
  return {
    // The code leads the subject, so a phone's notification shows it without opening the mail.
    subject: `${code} is your Ship ${label} code`,
    text: `${link ? `Sign in to Ship: ${link}\n\n` : ""}${introduction}\n\n${code}\n\n${expiry}\n\n${footer}\n\nShip`,
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f3fb;color:#1b1836;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f3fb;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:480px;background-color:#ffffff;">
        <tr><td style="padding:32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#1b1836;">
          ${link ? `<p style="margin:0 0 24px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background-color:#5a52a8;color:#ffffff;font-weight:bold;text-decoration:none;">Sign in to Ship</a></p>` : ""}
          <p style="margin:0 0 24px;">${escapeHtml(introduction)}</p>
          <p style="margin:0 0 24px;padding:20px 12px;background-color:#f0eef8;text-align:center;"><strong style="font-family:'Courier New',Courier,monospace;font-size:36px;line-height:44px;letter-spacing:6px;color:#221e44;">${escapeHtml(code)}</strong></p>
          <p style="margin:0 0 24px;">${escapeHtml(expiry)}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:22px;color:#6d6899;">${escapeHtml(footer)}</p>
          <p style="margin:0;font-weight:bold;color:#5a52a8;">Ship</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
