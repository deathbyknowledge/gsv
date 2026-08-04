import {
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
