import type { BillingLifecyclePolicy, BillingPlan } from "./domain";
import type {
  StripeBillingConfig,
  StripeMerchantMode,
} from "./stripe-provider";

export type BillingProductEnvironment = {
  GSV_BILLING_PLAN_KEY: string;
  GSV_BILLING_CURRENCY: string;
  GSV_BILLING_MONTHLY_PRICE_MINOR: string;
  GSV_BILLING_INFERENCE_BUDGET_MICROUNITS: string;
  GSV_BILLING_STORAGE_LIMIT_BYTES: string;
  GSV_BILLING_PAST_DUE_GRACE_MS: string;
  GSV_BILLING_RETENTION_MS: string;
};

export type StripeBillingEnvironment = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  GSV_STRIPE_FOUNDING_PRICE_ID?: string;
  GSV_STRIPE_MERCHANT_MODE?: string;
};

export function billingProductConfig(env: BillingProductEnvironment): {
  plan: BillingPlan;
  policy: BillingLifecyclePolicy;
  offer: { currency: string; monthlyPriceMinor: number };
} {
  const currency = required(env.GSV_BILLING_CURRENCY, "GSV_BILLING_CURRENCY")
    .toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error("GSV_BILLING_CURRENCY is invalid");
  }
  return {
    plan: {
      planKey: required(env.GSV_BILLING_PLAN_KEY, "GSV_BILLING_PLAN_KEY"),
      inferenceBudgetMicrounits: positiveInteger(
        env.GSV_BILLING_INFERENCE_BUDGET_MICROUNITS,
        "GSV_BILLING_INFERENCE_BUDGET_MICROUNITS",
      ),
      storageLimitBytes: positiveInteger(
        env.GSV_BILLING_STORAGE_LIMIT_BYTES,
        "GSV_BILLING_STORAGE_LIMIT_BYTES",
      ),
    },
    policy: {
      pastDueGraceMs: positiveInteger(
        env.GSV_BILLING_PAST_DUE_GRACE_MS,
        "GSV_BILLING_PAST_DUE_GRACE_MS",
      ),
      cancelledRetentionMs: positiveInteger(
        env.GSV_BILLING_RETENTION_MS,
        "GSV_BILLING_RETENTION_MS",
      ),
    },
    offer: {
      currency,
      monthlyPriceMinor: positiveInteger(
        env.GSV_BILLING_MONTHLY_PRICE_MINOR,
        "GSV_BILLING_MONTHLY_PRICE_MINOR",
      ),
    },
  };
}

export function stripeBillingConfig(
  env: StripeBillingEnvironment,
  planKey: string,
): StripeBillingConfig {
  return {
    secretKey: required(env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"),
    webhookSecret: required(
      env.STRIPE_WEBHOOK_SECRET,
      "STRIPE_WEBHOOK_SECRET",
    ),
    prices: [{
      planKey,
      providerPriceId: required(
        env.GSV_STRIPE_FOUNDING_PRICE_ID,
        "GSV_STRIPE_FOUNDING_PRICE_ID",
      ),
    }],
    merchantMode: merchantMode(env.GSV_STRIPE_MERCHANT_MODE),
  };
}

function merchantMode(value: string | undefined): StripeMerchantMode {
  if (value === "direct" || value === "managed_payments") return value;
  throw new Error("GSV_STRIPE_MERCHANT_MODE is invalid");
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function positiveInteger(value: string, field: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${field} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}
