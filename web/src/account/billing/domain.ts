import type {
  BillingInstallation,
  BillingSubscriptionState,
} from "./types";

export type BillingTone = "neutral" | "success" | "warning" | "error";

export function billingState(state: BillingSubscriptionState): {
  label: string;
  tone: BillingTone;
} {
  switch (state) {
    case "pending":
      return { label: "ACTIVATING", tone: "neutral" };
    case "trialing":
      return { label: "TRIAL", tone: "success" };
    case "active":
      return { label: "ACTIVE", tone: "success" };
    case "past_due":
      return { label: "PAYMENT DUE", tone: "warning" };
    case "restricted":
      return { label: "RESTRICTED", tone: "error" };
    case "cancelled":
      return { label: "CANCELLED", tone: "warning" };
    case "retained":
      return { label: "RETAINED", tone: "error" };
  }
}

export function billingDeadline(installation: BillingInstallation): {
  label: string;
  at: number;
} | null {
  const subscription = installation.subscription;
  if (!subscription) return null;
  if (subscription.state === "past_due" && subscription.graceEndsAt !== null) {
    return { label: "GRACE ENDS", at: subscription.graceEndsAt };
  }
  if (subscription.state === "retained" && subscription.retentionEndsAt !== null) {
    return { label: "DATA RETAINED UNTIL", at: subscription.retentionEndsAt };
  }
  if (subscription.cancelAtPeriodEnd && subscription.paidThrough !== null) {
    return { label: "ACTIVE THROUGH", at: subscription.paidThrough };
  }
  return {
    label: "CURRENT PERIOD ENDS",
    at: subscription.currentPeriodEndsAt,
  };
}

export function monthlyPrice(
  amountMinor: number,
  currency: string,
  locale?: string,
): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}
