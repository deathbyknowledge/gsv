export type VerificationEmail = {
  to: string;
  verificationUrl: string;
  expiresInMinutes: number;
};

export type SecurityNotification = {
  to: string;
  kind: "passkey_registered" | "recovery_started" | "recovery_completed";
};

export type LifecycleNotificationEmail = {
  to: string;
  kind:
    | "payment_past_due"
    | "service_restricted"
    | "retention_started"
    | "retention_7_days"
    | "retention_1_day"
    | "user_deletion_requested"
    | "user_deletion_recovered"
    | "installation_deleted";
  installationHandle: string;
  canonicalOrigin: string;
  accountUrl: string;
  deadlineAt: number | null;
};

export interface TransactionalMailer {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
  sendSecurityNotification(message: SecurityNotification): Promise<void>;
}

export interface LifecycleNotificationMailer {
  sendLifecycleNotification(
    message: LifecycleNotificationEmail,
  ): Promise<{ messageId: string }>;
}

export class CloudflareTransactionalMailer
  implements TransactionalMailer, LifecycleNotificationMailer
{
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

  async sendLifecycleNotification(
    message: LifecycleNotificationEmail,
  ): Promise<{ messageId: string }> {
    const content = lifecycleNotificationContent(message);
    const accountUrl = escapeHtml(message.accountUrl);
    const canonicalOrigin = escapeHtml(message.canonicalOrigin);
    return await this.sender.send({
      to: message.to,
      from: { email: this.from, name: "GSV" },
      subject: content.subject,
      text: [
        content.message,
        "",
        `Manage this GSV: ${message.accountUrl}`,
        `GSV address: ${message.canonicalOrigin}`,
      ].join("\n"),
      html: [
        `<p>${escapeHtml(content.message)}</p>`,
        `<p><a href="${accountUrl}">Manage this GSV</a></p>`,
        `<p>GSV address: <a href="${canonicalOrigin}">${canonicalOrigin}</a></p>`,
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

function lifecycleNotificationContent(message: LifecycleNotificationEmail): {
  subject: string;
  message: string;
} {
  const address = new URL(message.canonicalOrigin).hostname;
  const deadline = message.deadlineAt === null
    ? null
    : new Date(message.deadlineAt).toUTCString();
  switch (message.kind) {
    case "payment_past_due":
      return {
        subject: `Payment needs attention for ${address}`,
        message: `We could not renew ${address}. Update billing before ${deadline} to avoid service restriction.`,
      };
    case "service_restricted":
      return {
        subject: `${address} has been restricted`,
        message: `${address} is no longer starting new paid work. Your data remains available for billing repair, inspection, export, or deletion.`,
      };
    case "retention_started":
      return {
        subject: `Data retention started for ${address}`,
        message: `Service for ${address} has ended. Its data is retained until ${deadline}; export it or restore service before then.`,
      };
    case "retention_7_days":
      return {
        subject: `Seven days until ${address} is deleted`,
        message: `The retained data for ${address} is scheduled for permanent deletion on ${deadline}. Export it or restore service now.`,
      };
    case "retention_1_day":
      return {
        subject: `One day until ${address} is deleted`,
        message: `The retained data for ${address} is scheduled for permanent deletion on ${deadline}. This is the final reminder.`,
      };
    case "user_deletion_requested":
      return {
        subject: `Deletion requested for ${address}`,
        message: `${address} has stopped accepting new work. You can recover it until ${deadline}; after that its data will be permanently deleted.`,
      };
    case "user_deletion_recovered":
      return {
        subject: `Deletion cancelled for ${address}`,
        message: `${address} has been recovered and its routing and saved work are available again.`,
      };
    case "installation_deleted":
      return {
        subject: `${address} was deleted`,
        message: `The installation-owned runtime, repositories, stored media, inference state, and messaging routes for ${address} were permanently deleted.`,
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
