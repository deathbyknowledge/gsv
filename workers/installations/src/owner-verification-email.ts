import { escapeHtml } from "./admin/page";
import type { OwnerAuthPurpose } from "./owner-auth-store";

export type OwnerEmailSender = { from: string; replyTo?: string };

export function ownerVerificationEmail(purpose: OwnerAuthPurpose, code: string, expiresAt: number) {
  const label = purpose === "recover" ? "account recovery" : purpose === "link" ? "email verification" : "sign-in";
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  const introduction = "Enter this code in Ship to continue:";
  const expiry = `This code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Don’t share it with anyone.`;
  const footer = "If you didn’t request this code, you can ignore this email.";
  return {
    subject: `Your Ship ${label} code`,
    text: `${introduction}\n\n${code}\n\n${expiry}\n\n${footer}\n\nShip`,
    html: ownerEmailHtml([{ text: introduction }, { text: code, style: "code" }, { text: expiry }, { text: footer, style: "note" }]),
  };
}

/** One paragraph of an owner email: plain, the code to type, or a quieter note. */
export type OwnerEmailBlock = { text: string; style?: "code" | "note" };

/** An owner email's HTML: its paragraphs in order, on Ship's card, signed by Ship. */
export function ownerEmailHtml(blocks: OwnerEmailBlock[]): string {
  const paragraphs = blocks.map(({ text, style }) => style === "code"
    ? `<p style="margin:0 0 24px;padding:20px 12px;background-color:#f0eef8;text-align:center;"><strong style="font-family:'Courier New',Courier,monospace;font-size:36px;line-height:44px;letter-spacing:6px;color:#221e44;">${escapeHtml(text)}</strong></p>`
    : `<p style="margin:0 0 24px;${style === "note" ? "font-size:14px;line-height:22px;color:#6d6899;" : ""}">${escapeHtml(text)}</p>`);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f3fb;color:#1b1836;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f3fb;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:480px;background-color:#ffffff;">
        <tr><td style="padding:32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#1b1836;">
          ${paragraphs.join("\n          ")}
          <p style="margin:0;font-weight:bold;color:#5a52a8;">Ship</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
