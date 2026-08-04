import {
  parseSubscriptionSnapshot,
  parseWebhookEvent,
  type BillingWebhookProvider,
} from "./domain";
import { BillingReconciler } from "./reconciler";
import { BillingStore } from "./store";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type BillingWebhookResult = {
  accepted: true;
  outcome: "reconciled" | "ignored" | "duplicate" | "in_progress";
};

export class BillingWebhookRejectedError extends Error {}
export class BillingWebhookProcessingError extends Error {}

export class BillingWebhookProcessor {
  constructor(
    private readonly store: BillingStore,
    private readonly reconciler: BillingReconciler,
    private readonly provider: BillingWebhookProvider,
  ) {}

  async process(
    rawBody: ArrayBuffer,
    headers: Headers,
    now = Date.now(),
  ): Promise<BillingWebhookResult> {
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
      throw new BillingWebhookRejectedError("Billing webhook body is invalid");
    }
    let event;
    try {
      event = parseWebhookEvent(
        await this.provider.verifyWebhook(rawBody.slice(0), headers),
        now,
      );
    } catch {
      throw new BillingWebhookRejectedError("Billing webhook signature is invalid");
    }
    const lease = await this.store.beginEvent({
      provider: this.provider.name,
      event,
      bodyHash: await bodyHash(rawBody),
      now,
    });
    if (lease.kind !== "acquired") {
      return { accepted: true, outcome: lease.kind };
    }

    try {
      if (event.subject.kind === "other") {
        await this.store.completeEvent({
          provider: this.provider.name,
          eventId: event.eventId,
          leaseNonce: lease.nonce,
          outcome: "ignored",
          now,
        });
        return { accepted: true, outcome: "ignored" };
      }
      const snapshot = parseSubscriptionSnapshot(
        await this.provider.getSubscription(event.subject.id),
        now,
      );
      if (snapshot.subscriptionId !== event.subject.id) {
        throw new Error("provider returned a different subscription");
      }
      await this.reconciler.reconcile(this.provider.name, snapshot, now);
      await this.store.completeEvent({
        provider: this.provider.name,
        eventId: event.eventId,
        leaseNonce: lease.nonce,
        outcome: "reconciled",
        now,
      });
      return { accepted: true, outcome: "reconciled" };
    } catch (error) {
      await this.store.failEvent({
        provider: this.provider.name,
        eventId: event.eventId,
        leaseNonce: lease.nonce,
        errorCode: billingFailureCode(error),
      }).catch(() => undefined);
      throw new BillingWebhookProcessingError(
        "Billing webhook could not be reconciled",
      );
    }
  }
}

async function bodyHash(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function billingFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("plan is unavailable")) return "plan_unavailable";
  if (message.includes("customer is unavailable")) return "customer_unavailable";
  if (message.includes("installation")) return "installation_unavailable";
  if (message.includes("subscription")) return "subscription_invalid";
  return "reconciliation_failed";
}
