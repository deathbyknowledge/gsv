import type { JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import type { ResponsibilityStore } from "./responsibility-store";
import type { KernelContext } from "./context";

type OnboardingState = { createdAtMs: number; details?: JsonObject; activatedRevision?: number };

export const INITIAL_ONBOARDING_DEDUPE_KEY = "onboarding.initial";

const ONBOARDING_SOURCE = { kind: "system", component: "onboarding" } as const;

type OnboardingContract = {
  title: string;
  details: JsonObject;
};

/**
 * The current onboarding contract. The Ship's prompt snapshot renders the
 * record with its details, and the responsibilities context tells the Ship to
 * follow them while this record is unresolved. The brief itself is the Markdown
 * prompt file `prompts/onboarding/welcome.md`.
 */
const WELCOME_CONTRACT: OnboardingContract = {
  title: "Welcome to Ship",
  details: {
    responsibilityType: "onboarding.initial",
    instructions: welcomeBrief.trim(),
  },
};

/** Match a dormant welcome without reopening work Ship or its owner has changed. */
function isUntouchedSeed(
  record: ResponsibilityRecord,
  state: "waiting" | "open" = "waiting",
): boolean {
  return record.title === WELCOME_CONTRACT.title
    && record.blocker === (state === "waiting" ? "Waiting for the user to dismiss the welcome card." : undefined)
    && JSON.stringify(record.details ?? {}) === JSON.stringify(WELCOME_CONTRACT.details)
    && record.state === state
    && record.priority === "high"
    && record.assignee.kind === "ship"
    && record.parentId === undefined
    && record.audience === undefined
    && record.dueAtMs === undefined
    && record.nextCheckAtMs === undefined
    && record.leaseExpiresAtMs === undefined
    && record.resolution === undefined;
}

/**
 * Seed the owner's onboarding responsibility only when no record exists. Only a
 * new personal agent, or the retirement of the exact generated boot file that
 * preceded the ledger, may seed: a home that finished the earlier flow has no
 * record and must not be onboarded again.
 */
export class InitialOnboarding {
  constructor(private readonly storage: DurableObjectStorage, private readonly responsibilities: ResponsibilityStore) {}

  prepare(ownerUid: number, now = Date.now()): void {
    const key = `initial-onboarding:${ownerUid}`;
    if (this.storage.kv.get(key) || this.responsibilities.getByDedupeKey(ownerUid, INITIAL_ONBOARDING_DEDUPE_KEY)) return;
    this.storage.kv.put(key, { createdAtMs: now, details: WELCOME_CONTRACT.details });
  }

  createdAt(ownerUid: number): number | undefined {
    return this.storage.kv.get<{ createdAtMs: number }>(`initial-onboarding:${ownerUid}`)?.createdAtMs
      ?? this.responsibilities.getByDedupeKey(ownerUid, INITIAL_ONBOARDING_DEDUPE_KEY)?.createdAtMs;
  }

  /** Activate only an untouched welcome seed; retries must not reopen work Ship already handled. */
  activate(ownerUid: number, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      const key = `initial-onboarding:${ownerUid}`;
      const pending = this.storage.kv.get<OnboardingState>(key);
      const record = this.responsibilities.getByDedupeKey(ownerUid, INITIAL_ONBOARDING_DEDUPE_KEY);
      if (record) {
        if (pending?.activatedRevision === record.revision) return this.responsibilities.nextWakeAt(ownerUid, now) !== null;
        if (!isUntouchedSeed(record)) {
          return isUntouchedSeed(record, "open")
            && this.responsibilities.nextWakeAt(ownerUid, now) !== null;
        }
        this.responsibilities.update({
          ownerUid, id: record.id, patch: { state: "open", blocker: null },
          actor: ONBOARDING_SOURCE, observedByShip: false, now,
        });
        return true;
      }
      if (!pending?.details) return false;
      const created = this.responsibilities.create({
        ownerUid, title: WELCOME_CONTRACT.title, details: pending.details,
        source: ONBOARDING_SOURCE, assignee: { kind: "ship" }, state: "open", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, actor: ONBOARDING_SOURCE, observedByShip: false, now,
      });
      this.storage.kv.put(key, { createdAtMs: pending.createdAtMs, activatedRevision: created.record.revision });
      return true;
    });
  }
}

/** Admit the person's message before scheduling recovery of newly activated work. */
export async function withInitialOnboarding<T>(
  ownerUid: number | undefined,
  ctx: KernelContext,
  deliver: () => Promise<T>,
): Promise<T> {
  const activated = ownerUid !== undefined && ctx.welcome.activate(ownerUid);
  try {
    return await deliver();
  } finally {
    if (activated && ownerUid !== undefined) ctx.defer(ctx.reconcileResponsibilityWake(ownerUid));
  }
}
