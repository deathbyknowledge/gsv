import { operatorUpdateCatalogSchema } from "@humansandmachines/gsv/services/operator-updates";
import instructions from "../prompts/tasks/operator-update.md";
import { INITIAL_ONBOARDING_DEDUPE_KEY } from "./onboarding-responsibility";
import type { ResponsibilityStore } from "./responsibility-store";

/** Operator releases reconcile locally when an existing personal agent is used. */
export function reconcileOperatorUpdates(ownerUid: number, responsibilities: ResponsibilityStore, configuration?: string, now = Date.now()): void {
  if (!configuration) return;
  const catalog = operatorUpdateCatalogSchema.parse(JSON.parse(configuration));
  const onboarding = responsibilities.getByDedupeKey(ownerUid, INITIAL_ONBOARDING_DEDUPE_KEY);
  const source = { kind: "system", component: "operator-updates" } as const;
  for (const update of catalog.updates) {
    if (update.publishedAtMs > now || onboarding && onboarding.createdAtMs >= update.publishedAtMs) continue;
    responsibilities.create({
      ownerUid,
      title: update.title,
      details: {
        responsibilityType: "operator.update",
        publisher: catalog.publisher,
        updateId: update.id,
        publishedAtMs: update.publishedAtMs,
        brief: update.brief,
        instructions: instructions.trim(),
      },
      source,
      actor: source,
      assignee: { kind: "ship" },
      state: "waiting",
      priority: "normal",
      blocker: "Waiting for a suitable conversation with the user.",
      dedupeKey: `operator.update:${catalog.publisher.id}:${update.id}`,
      observedByShip: true,
      now,
    });
  }
}
