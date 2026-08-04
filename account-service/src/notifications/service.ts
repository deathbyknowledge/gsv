import type { LifecycleNotificationMailer } from "../email/mailer";
import {
  LifecycleNotificationStore,
  type ClaimedLifecycleNotification,
} from "./store";

const MAX_DELIVERY_ATTEMPTS = 20;
const INITIAL_RETRY_MS = 30_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

const PERMANENT_EMAIL_ERRORS = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

export type LifecycleNotificationSyncResult = {
  claimed: number;
  sent: number;
  failed: number;
};

export class LifecycleNotificationService {
  private readonly accountOrigin: string;

  constructor(
    private readonly store: LifecycleNotificationStore,
    private readonly mailer: LifecycleNotificationMailer,
    accountOrigin: string,
  ) {
    const url = new URL(accountOrigin);
    if (
      url.origin !== accountOrigin
      || url.protocol !== "https:"
      || url.pathname !== "/"
      || url.username
      || url.password
    ) {
      throw new Error("notification account origin is invalid");
    }
    this.accountOrigin = url.origin;
  }

  async sync(
    now = Date.now(),
    limit = 10,
  ): Promise<LifecycleNotificationSyncResult> {
    await this.store.enqueueDue(now);
    const claimed = await this.store.claimDue(now, limit);
    const outcomes = await Promise.all(claimed.map((notification) => (
      this.deliver(notification, now)
    )));
    return {
      claimed: claimed.length,
      sent: outcomes.filter((outcome) => outcome === "sent").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
    };
  }

  private async deliver(
    notification: ClaimedLifecycleNotification,
    now: number,
  ): Promise<"sent" | "failed"> {
    try {
      const result = await this.mailer.sendLifecycleNotification({
        to: notification.recipientEmail,
        kind: notification.kind,
        installationHandle: notification.installationHandle,
        canonicalOrigin: notification.canonicalOrigin,
        accountUrl: accountUrl(
          this.accountOrigin,
          notification.installationId,
        ),
        deadlineAt: notification.deadlineAt,
      });
      await this.store.markSent({
        id: notification.id,
        leaseNonce: notification.leaseNonce,
        providerMessageId: result.messageId,
        now,
      });
      return "sent";
    } catch (error) {
      const classified = classifyDeliveryError(error);
      const retryAt = now + retryDelay(notification.attempt);
      await this.store.markFailed({
        id: notification.id,
        leaseNonce: notification.leaseNonce,
        errorCode: classified.code,
        retryAt,
        permanent: classified.permanent
          || notification.attempt >= MAX_DELIVERY_ATTEMPTS,
        now,
      }).catch(() => undefined);
      return "failed";
    }
  }
}

function accountUrl(origin: string, installationId: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("installation", installationId);
  return url.toString();
}

function classifyDeliveryError(error: unknown): {
  code: string;
  permanent: boolean;
} {
  const code = emailErrorCode(error);
  return {
    code,
    permanent: PERMANENT_EMAIL_ERRORS.has(code),
  };
}

function emailErrorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  return "delivery_unavailable";
}

function retryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return INITIAL_RETRY_MS;
  }
  return Math.min(
    MAX_RETRY_MS,
    INITIAL_RETRY_MS * 2 ** Math.min(attempt - 1, 20),
  );
}
