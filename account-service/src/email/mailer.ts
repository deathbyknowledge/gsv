export type VerificationEmail = {
  to: string;
  verificationUrl: string;
  expiresInMinutes: number;
};

export type SecurityNotification = {
  to: string;
  kind: "passkey_registered" | "recovery_started" | "recovery_completed";
};

export interface TransactionalMailer {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
  sendSecurityNotification(message: SecurityNotification): Promise<void>;
}

export class CloudflareTransactionalMailer implements TransactionalMailer {
  constructor(
    private readonly sender: SendEmail,
    private readonly from: string,
  ) {}

  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    const verificationUrl = escapeHtml(message.verificationUrl);
    const minutes = Math.max(1, Math.floor(message.expiresInMinutes));
    await this.sender.send({
      to: message.to,
      from: { email: this.from, name: "GSV" },
      subject: "Verify your GSV account",
      text: [
        "Verify your email to continue creating your GSV:",
        message.verificationUrl,
        "",
        `This link expires in ${minutes} minutes. If you did not request it, you can ignore this email.`,
      ].join("\n"),
      html: [
        "<p>Verify your email to continue creating your GSV.</p>",
        `<p><a href="${verificationUrl}">Verify email</a></p>`,
        `<p>This link expires in ${minutes} minutes. If you did not request it, you can ignore this email.</p>`,
      ].join(""),
    });
  }

  async sendSecurityNotification(message: SecurityNotification): Promise<void> {
    const content = securityNotificationContent(message.kind);
    await this.sender.send({
      to: message.to,
      from: { email: this.from, name: "GSV" },
      subject: content.subject,
      text: `${content.message}\n\nIf this was not you, contact GSV support immediately.`,
      html: [
        `<p>${content.message}</p>`,
        "<p>If this was not you, contact GSV support immediately.</p>",
      ].join(""),
    });
  }
}

function securityNotificationContent(kind: SecurityNotification["kind"]): {
  subject: string;
  message: string;
} {
  switch (kind) {
    case "passkey_registered":
      return {
        subject: "A passkey was added to your GSV account",
        message: "A new passkey was registered for your GSV account.",
      };
    case "recovery_started":
      return {
        subject: "GSV account recovery started",
        message: "A recovery code was used. Existing sessions and passkeys were revoked.",
      };
    case "recovery_completed":
      return {
        subject: "GSV account recovery completed",
        message: "A replacement passkey was registered and account recovery completed.",
      };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
