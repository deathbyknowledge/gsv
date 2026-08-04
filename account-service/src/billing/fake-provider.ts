import { constantTimeEqual, sha256Hex } from "../security/tokens";
import {
  parseExternalId,
  parseProviderName,
  type BillingSubscriptionSnapshot,
  type BillingCommerceProvider,
  type BillingHostedSession,
  type BillingWebhookEvent,
  type BillingWebhookProvider,
} from "./domain";

const SIGNATURE_HEADER = "x-gsv-fake-signature";

export class FakeBillingProvider implements BillingWebhookProvider, BillingCommerceProvider {
  readonly name: string;
  readonly subscriptionReads = new Map<string, number>();
  private readonly subscriptions = new Map<string, BillingSubscriptionSnapshot>();
  private readonly customers = new Map<string, {
    input: string;
    customerId: string;
  }>();
  private readonly hostedSessions = new Map<string, {
    input: string;
    session: BillingHostedSession;
  }>();

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

  async ensureCustomer(input: {
    operationId: string;
    principalId: string;
    email: string;
    displayName: string;
  }): Promise<{ customerId: string }> {
    const serialized = JSON.stringify(input);
    const existing = this.customers.get(input.operationId);
    if (existing) {
      if (existing.input !== serialized) {
        throw new Error("fake customer idempotency conflict");
      }
      return { customerId: existing.customerId };
    }
    const customerId = `customer_${(await sha256Hex(serialized)).slice(0, 24)}`;
    this.customers.set(input.operationId, { input: serialized, customerId });
    return { customerId };
  }

  async createCheckout(input: {
    operationId: string;
    customerId: string;
    installationId: string;
    planKey: string;
    providerPriceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<BillingHostedSession> {
    return await this.hostedSession("checkout", input);
  }

  async createPortal(input: {
    operationId: string;
    customerId: string;
    returnUrl: string;
  }): Promise<BillingHostedSession> {
    return await this.hostedSession("portal", input);
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

  private async hostedSession(
    kind: "checkout" | "portal",
    input: { operationId: string } & Record<string, unknown>,
  ): Promise<BillingHostedSession> {
    const key = `${kind}:${input.operationId}`;
    const serialized = JSON.stringify(input);
    const existing = this.hostedSessions.get(key);
    if (existing) {
      if (existing.input !== serialized) {
        throw new Error("fake hosted-session idempotency conflict");
      }
      return structuredClone(existing.session);
    }
    const suffix = (await sha256Hex(`${kind}:${serialized}`)).slice(0, 24);
    const session = {
      sessionId: `${kind}_${suffix}`,
      url: `https://${kind}.billing.test/session/${suffix}`,
      ...(kind === "checkout" ? { expiresAt: Date.now() + 30 * 60_000 } : {}),
    };
    this.hostedSessions.set(key, { input: serialized, session });
    return structuredClone(session);
  }
}
