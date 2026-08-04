import {
  parseExternalId,
  parseBillingPlan,
  parsePlanKey,
  type BillingPlan,
} from "./domain";

export class BillingPlanCatalog {
  private readonly plans: Map<string, BillingPlan>;

  constructor(plans: readonly BillingPlan[]) {
    this.plans = new Map();
    for (const input of plans) {
      const plan = parseBillingPlan(input);
      if (this.plans.has(plan.planKey)) {
        throw new Error(`billing plan ${plan.planKey} is duplicated`);
      }
      this.plans.set(plan.planKey, plan);
    }
    if (this.plans.size === 0) {
      throw new Error("at least one billing plan is required");
    }
  }

  require(planKeyValue: string): BillingPlan {
    const planKey = parsePlanKey(planKeyValue);
    const plan = this.plans.get(planKey);
    if (!plan) throw new Error("billing plan is unavailable");
    return plan;
  }
}

export class BillingProviderPriceCatalog {
  private readonly prices: Map<string, string>;

  constructor(entries: readonly {
    planKey: string;
    providerPriceId: string;
  }[]) {
    this.prices = new Map();
    for (const entry of entries) {
      const planKey = parsePlanKey(entry.planKey);
      const providerPriceId = parseExternalId(
        entry.providerPriceId,
        "provider price ID",
      );
      if (this.prices.has(planKey)) {
        throw new Error(`billing price for ${planKey} is duplicated`);
      }
      this.prices.set(planKey, providerPriceId);
    }
  }

  require(planKeyValue: string): string {
    const planKey = parsePlanKey(planKeyValue);
    const providerPriceId = this.prices.get(planKey);
    if (!providerPriceId) throw new Error("billing price is unavailable");
    return providerPriceId;
  }
}
