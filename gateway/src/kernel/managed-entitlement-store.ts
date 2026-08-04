import type {
  ManagedEntitlementProjection,
  ManagedEntitlementState,
} from "@humansandmachines/gsv/protocol";
import type { InstallationId } from "../installation/identity";

const PLAN_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

type ManagedEntitlementRow = {
  installation_id: string;
  state: string;
  plan_key: string;
  inference_budget_microunits: number;
  inference_period_starts_at: number;
  inference_period_ends_at: number;
  storage_limit_bytes: number;
  effective_at: number;
  version: number;
};

export type ManagedEntitlementProjectionResult = {
  projection: ManagedEntitlementProjection;
  changed: boolean;
};

export class ManagedEntitlementStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly installationId: InstallationId,
  ) {}

  get(): ManagedEntitlementProjection | null {
    const row = this.sql.exec<ManagedEntitlementRow>(
      `SELECT installation_id, state, plan_key, inference_budget_microunits,
              inference_period_starts_at, inference_period_ends_at,
              storage_limit_bytes, effective_at, version
       FROM managed_entitlement
       WHERE record_id = 1`,
    ).toArray()[0];
    return row ? projectionFromRow(row) : null;
  }

  project(input: ManagedEntitlementProjection): ManagedEntitlementProjectionResult {
    const projection = parseManagedEntitlementProjection(input);
    if (projection.installationId !== this.installationId) {
      throw new Error("entitlement installation does not match Kernel");
    }

    const existing = this.get();
    if (existing && projection.version <= existing.version) {
      if (sameProjection(existing, projection)) {
        return { projection: existing, changed: false };
      }
      throw new Error("managed entitlement projection is stale or conflicts with its version");
    }

    this.sql.exec(
      `INSERT INTO managed_entitlement (
         record_id, installation_id, state, plan_key,
         inference_budget_microunits, inference_period_starts_at,
         inference_period_ends_at, storage_limit_bytes, effective_at, version
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         installation_id = excluded.installation_id,
         state = excluded.state,
         plan_key = excluded.plan_key,
         inference_budget_microunits = excluded.inference_budget_microunits,
         inference_period_starts_at = excluded.inference_period_starts_at,
         inference_period_ends_at = excluded.inference_period_ends_at,
         storage_limit_bytes = excluded.storage_limit_bytes,
         effective_at = excluded.effective_at,
         version = excluded.version`,
      projection.installationId,
      projection.state,
      projection.planKey,
      projection.inferenceBudgetMicrounits,
      projection.inferencePeriodStartsAt,
      projection.inferencePeriodEndsAt,
      projection.storageLimitBytes,
      projection.effectiveAt,
      projection.version,
    );
    return { projection: this.get()!, changed: true };
  }

  allowsScheduledWork(): boolean {
    const state = this.get()?.state;
    return state === "trialing" || state === "active" || state === "past_due";
  }
}

export function parseManagedEntitlementProjection(
  input: ManagedEntitlementProjection,
): ManagedEntitlementProjection {
  if (!input || typeof input !== "object") {
    throw new Error("managed entitlement projection is required");
  }
  if (!isEntitlementState(input.state)) {
    throw new Error("managed entitlement state is invalid");
  }
  if (typeof input.installationId !== "string" || !input.installationId.trim()) {
    throw new Error("managed entitlement installationId is invalid");
  }
  if (typeof input.planKey !== "string" || !PLAN_KEY_PATTERN.test(input.planKey)) {
    throw new Error("managed entitlement planKey is invalid");
  }
  for (const [field, value] of [
    ["inferenceBudgetMicrounits", input.inferenceBudgetMicrounits],
    ["storageLimitBytes", input.storageLimitBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`managed entitlement ${field} is invalid`);
    }
  }
  if (
    !Number.isSafeInteger(input.inferencePeriodStartsAt)
    || !Number.isSafeInteger(input.inferencePeriodEndsAt)
    || input.inferencePeriodStartsAt < 0
    || input.inferencePeriodEndsAt <= input.inferencePeriodStartsAt
  ) {
    throw new Error("managed entitlement inference period is invalid");
  }
  if (
    !Number.isSafeInteger(input.effectiveAt)
    || input.effectiveAt < 0
    || input.effectiveAt > Date.now() + 60_000
  ) {
    throw new Error("managed entitlement effectiveAt is invalid");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error("managed entitlement version is invalid");
  }
  return {
    installationId: input.installationId,
    state: input.state,
    planKey: input.planKey,
    inferenceBudgetMicrounits: input.inferenceBudgetMicrounits,
    inferencePeriodStartsAt: input.inferencePeriodStartsAt,
    inferencePeriodEndsAt: input.inferencePeriodEndsAt,
    storageLimitBytes: input.storageLimitBytes,
    effectiveAt: input.effectiveAt,
    version: input.version,
  };
}

function projectionFromRow(row: ManagedEntitlementRow): ManagedEntitlementProjection {
  if (!isEntitlementState(row.state)) {
    throw new Error("stored managed entitlement state is invalid");
  }
  return parseManagedEntitlementProjection({
    installationId: row.installation_id,
    state: row.state,
    planKey: row.plan_key,
    inferenceBudgetMicrounits: row.inference_budget_microunits,
    inferencePeriodStartsAt: row.inference_period_starts_at,
    inferencePeriodEndsAt: row.inference_period_ends_at,
    storageLimitBytes: row.storage_limit_bytes,
    effectiveAt: row.effective_at,
    version: row.version,
  });
}

function sameProjection(
  left: ManagedEntitlementProjection,
  right: ManagedEntitlementProjection,
): boolean {
  return left.installationId === right.installationId
    && left.state === right.state
    && left.planKey === right.planKey
    && left.inferenceBudgetMicrounits === right.inferenceBudgetMicrounits
    && left.inferencePeriodStartsAt === right.inferencePeriodStartsAt
    && left.inferencePeriodEndsAt === right.inferencePeriodEndsAt
    && left.storageLimitBytes === right.storageLimitBytes
    && left.effectiveAt === right.effectiveAt
    && left.version === right.version;
}

function isEntitlementState(value: unknown): value is ManagedEntitlementState {
  return value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "restricted"
    || value === "cancelled"
    || value === "retained";
}
