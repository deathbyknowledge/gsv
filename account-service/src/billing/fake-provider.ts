import { constantTimeEqual } from "../security/tokens";
import {
  parseExternalId,
  parseProviderName,
  type BillingSubscriptionSnapshot,
  type BillingWebhookEvent,
  type BillingWebhookProvider,
} from "./domain";

const SIGNATURE_HEADER = "x-gsv-fake-signature";

export class FakeBillingProvider implements BillingWebhookProvider {
  readonly name: string;
  readonly subscriptionReads = new Map<string, number>();
  private readonly subscriptions = new Map<string, BillingSubscriptionSnapshot>();

  constructor(
    private readonly signingSecret: string,
    name = "fake",
  ) {
    this.name = parseProviderName(name);
    if (signingSecret.length < 16) {
      throw new Error("fake billing signing secret is invalid");
    }
  }

  setSubscription(snapshot: BillingSubscriptionSnapshot): void {
    this.subscriptions.set(snapshot.subscriptionId, structuredClone(snapshot));
  }

  async getSubscription(
    subscriptionIdValue: string,
  ): Promise<BillingSubscriptionSnapshot> {
    const subscriptionId = parseExternalId(
      subscriptionIdValue,
      "provider subscription ID",
    );
    this.subscriptionReads.set(
      subscriptionId,
      (this.subscriptionReads.get(subscriptionId) ?? 0) + 1,
    );
    const snapshot = this.subscriptions.get(subscriptionId);
    if (!snapshot) throw new Error("fake provider subscription is unavailable");
    return structuredClone(snapshot);
  }

  async verifyWebhook(
    rawBody: ArrayBuffer,
    headers: Headers,
  ): Promise<BillingWebhookEvent> {
    const signature = headers.get(SIGNATURE_HEADER) ?? "";
    const expected = await this.sign(rawBody);
    if (!constantTimeEqual(signature, expected)) {
      throw new Error("fake billing signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new Error("fake billing event is invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("fake billing event is invalid");
    }
    const event = value as Record<string, unknown>;
    if (
      typeof event.eventId !== "string"
      || typeof event.createdAt !== "number"
      || !event.subject
      || typeof event.subject !== "object"
      || Array.isArray(event.subject)
    ) {
      throw new Error("fake billing event is invalid");
    }
    const subject = event.subject as Record<string, unknown>;
    if (subject.kind === "other") {
      return {
        eventId: event.eventId,
        createdAt: event.createdAt,
        subject: { kind: "other" },
      };
    }
    if (subject.kind !== "subscription" || typeof subject.id !== "string") {
      throw new Error("fake billing event is invalid");
    }
    return {
      eventId: event.eventId,
      createdAt: event.createdAt,
      subject: { kind: "subscription", id: subject.id },
    };
  }

  async signedEvent(event: BillingWebhookEvent): Promise<{
    body: ArrayBuffer;
    headers: Headers;
  }> {
    const body = new TextEncoder().encode(JSON.stringify(event)).buffer as ArrayBuffer;
    return {
      body,
      headers: new Headers({ [SIGNATURE_HEADER]: await this.sign(body) }),
    };
  }

  private async sign(body: ArrayBuffer): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, body);
    return Array.from(
      new Uint8Array(signature),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  }
}
