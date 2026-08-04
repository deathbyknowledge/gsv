import type { ManagedEntitlementState } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";

const EXTERNAL_ID_PATTERN = /^[\x21-\x7e]{1,255}$/;
const PLAN_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export type BillingProviderSubscriptionState =
  | "pending"
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled";

export type BillingSubscriptionState = BillingProviderSubscriptionState
  | "restricted"
  | "retained";

export type BillingWebhookEvent = {
  eventId: string;
  createdAt: number;
  subject:
    | { kind: "subscription"; id: string }
    | { kind: "other" };
};

export type BillingSubscriptionSnapshot = {
  subscriptionId: string;
  customerId: string;
  installationId: string;
  planKey: string;
  state: BillingProviderSubscriptionState;
  observedAt: number;
  currentPeriodStartsAt: number;
  currentPeriodEndsAt: number;
  cancelAtPeriodEnd: boolean;
};

export interface BillingWebhookProvider {
  readonly name: string;
  verifyWebhook(rawBody: ArrayBuffer, headers: Headers): Promise<BillingWebhookEvent>;
  getSubscription(subscriptionId: string): Promise<BillingSubscriptionSnapshot>;
}

export type BillingPlan = {
  planKey: string;
  inferenceBudgetMicrounits: number;
  storageLimitBytes: number;
};

export type BillingLifecyclePolicy = {
  pastDueGraceMs: number;
  cancelledRetentionMs: number;
};

export type StoredBillingLifecycle = {
  providerState: BillingProviderSubscriptionState;
  graceEndsAt: number | null;
  retentionEndsAt: number | null;
  entitlement: BillingEntitlementTemplate | null;
};

export type BillingEntitlementTemplate = {
  state: ManagedEntitlementState;
  planKey: string;
  inferenceBudgetMicrounits: number;
  inferencePeriodStartsAt: number;
  inferencePeriodEndsAt: number;
  storageLimitBytes: number;
};

export type DerivedBillingLifecycle = {
  state: BillingSubscriptionState;
  paidThrough: number | null;
  graceEndsAt: number | null;
  retentionEndsAt: number | null;
  entitlement: BillingEntitlementTemplate | null;
};

export function deriveBillingLifecycle(input: {
  snapshot: BillingSubscriptionSnapshot;
  plan: BillingPlan;
  existing: StoredBillingLifecycle | null;
  policy: BillingLifecyclePolicy;
  now: number;
}): DerivedBillingLifecycle {
  const snapshot = parseSubscriptionSnapshot(input.snapshot, input.now);
  const plan = parseBillingPlan(input.plan);
  const policy = parseLifecyclePolicy(input.policy);
  const now = parseTimestamp(input.now, "now");
  const entitlement = (state: ManagedEntitlementState): BillingEntitlementTemplate => ({
    state,
    planKey: plan.planKey,
    inferenceBudgetMicrounits: plan.inferenceBudgetMicrounits,
    inferencePeriodStartsAt: snapshot.currentPeriodStartsAt,
    inferencePeriodEndsAt: snapshot.currentPeriodEndsAt,
    storageLimitBytes: plan.storageLimitBytes,
  });

  switch (snapshot.state) {
    case "pending":
      return input.existing?.entitlement
        ? {
            state: "restricted",
            paidThrough: null,
            graceEndsAt: null,
            retentionEndsAt: null,
            entitlement: entitlement("restricted"),
          }
        : {
            state: "pending",
            paidThrough: null,
            graceEndsAt: null,
            retentionEndsAt: null,
            entitlement: null,
          };
    case "trialing":
      return {
        state: "trialing",
        paidThrough: snapshot.currentPeriodEndsAt,
        graceEndsAt: null,
        retentionEndsAt: null,
        entitlement: entitlement("trialing"),
      };
    case "active":
      return {
        state: "active",
        paidThrough: snapshot.currentPeriodEndsAt,
        graceEndsAt: null,
        retentionEndsAt: null,
        entitlement: entitlement("active"),
      };
    case "past_due": {
      const graceEndsAt = input.existing?.providerState === "past_due"
          && input.existing.graceEndsAt !== null
        ? input.existing.graceEndsAt
        : now + policy.pastDueGraceMs;
      const restricted = now >= graceEndsAt;
      return {
        state: restricted ? "restricted" : "past_due",
        paidThrough: snapshot.currentPeriodEndsAt,
        graceEndsAt,
        retentionEndsAt: null,
        entitlement: entitlement(restricted ? "restricted" : "past_due"),
      };
    }
    case "cancelled": {
      const paidThrough = snapshot.currentPeriodEndsAt;
      const retentionEndsAt = input.existing?.providerState === "cancelled"
          && input.existing.retentionEndsAt !== null
        ? input.existing.retentionEndsAt
        : Math.max(now, paidThrough) + policy.cancelledRetentionMs;
      const retained = now >= paidThrough;
      return {
        state: retained ? "retained" : "cancelled",
        paidThrough,
        graceEndsAt: null,
        retentionEndsAt,
        entitlement: entitlement(retained ? "retained" : "active"),
      };
    }
  }
}

export function parseWebhookEvent(
  value: BillingWebhookEvent,
  now = Date.now(),
): BillingWebhookEvent {
  const eventId = parseExternalId(value.eventId, "provider event ID");
  const createdAt = parseTimestamp(value.createdAt, "provider event timestamp");
  if (createdAt > now + 5 * 60_000) {
    throw new Error("provider event timestamp is invalid");
  }
  if (value.subject.kind === "other") {
    return { eventId, createdAt, subject: { kind: "other" } };
  }
  if (value.subject.kind !== "subscription") {
    throw new Error("provider event subject is invalid");
  }
  return {
    eventId,
    createdAt,
    subject: {
      kind: "subscription",
      id: parseExternalId(value.subject.id, "provider subscription ID"),
    },
  };
}

export function parseSubscriptionSnapshot(
  value: BillingSubscriptionSnapshot,
  now = Date.now(),
): BillingSubscriptionSnapshot {
  const observedAt = parseTimestamp(value.observedAt, "provider observation timestamp");
  if (observedAt > now + 60_000) {
    throw new Error("provider observation timestamp is invalid");
  }
  const currentPeriodStartsAt = parseTimestamp(
    value.currentPeriodStartsAt,
    "subscription period start",
  );
  const currentPeriodEndsAt = parseTimestamp(
    value.currentPeriodEndsAt,
    "subscription period end",
  );
  if (currentPeriodEndsAt <= currentPeriodStartsAt) {
    throw new Error("subscription period is invalid");
  }
  if (!isProviderState(value.state)) {
    throw new Error("provider subscription state is invalid");
  }
  if (typeof value.cancelAtPeriodEnd !== "boolean") {
    throw new Error("provider cancellation state is invalid");
  }
  return {
    subscriptionId: parseExternalId(
      value.subscriptionId,
      "provider subscription ID",
    ),
    customerId: parseExternalId(value.customerId, "provider customer ID"),
    installationId: parseOpaqueId(value.installationId, "installationId"),
    planKey: parsePlanKey(value.planKey),
    state: value.state,
    observedAt,
    currentPeriodStartsAt,
    currentPeriodEndsAt,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
  };
}

export function parseBillingPlan(value: BillingPlan): BillingPlan {
  const planKey = parsePlanKey(value.planKey);
  for (const [field, amount] of [
    ["inference budget", value.inferenceBudgetMicrounits],
    ["storage limit", value.storageLimitBytes],
  ] as const) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`billing plan ${field} is invalid`);
    }
  }
  return {
    planKey,
    inferenceBudgetMicrounits: value.inferenceBudgetMicrounits,
    storageLimitBytes: value.storageLimitBytes,
  };
}

export function parsePlanKey(value: unknown): string {
  if (typeof value !== "string" || !PLAN_KEY_PATTERN.test(value)) {
    throw new Error("billing plan key is invalid");
  }
  return value;
}

export function parseProviderName(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[a-z][a-z0-9_-]{1,31}$/.test(value)
  ) {
    throw new Error("billing provider is invalid");
  }
  return value;
}

export function parseExternalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !EXTERNAL_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function stableSnapshot(snapshot: BillingSubscriptionSnapshot): string {
  return JSON.stringify({
    subscriptionId: snapshot.subscriptionId,
    customerId: snapshot.customerId,
    installationId: snapshot.installationId,
    planKey: snapshot.planKey,
    state: snapshot.state,
    observedAt: snapshot.observedAt,
    currentPeriodStartsAt: snapshot.currentPeriodStartsAt,
    currentPeriodEndsAt: snapshot.currentPeriodEndsAt,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
  });
}

function parseLifecyclePolicy(value: BillingLifecyclePolicy): BillingLifecyclePolicy {
  for (const [field, duration] of [
    ["past-due grace", value.pastDueGraceMs],
    ["cancelled retention", value.cancelledRetentionMs],
  ] as const) {
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new Error(`billing ${field} duration is invalid`);
    }
  }
  return value;
}

function parseTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value as number;
}

function isProviderState(value: unknown): value is BillingProviderSubscriptionState {
  return value === "pending"
    || value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "cancelled";
}
