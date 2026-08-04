import type {
  ManagedEntitlementProjection,
  ManagedEntitlementState,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";

const PLAN_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export type EntitlementState = ManagedEntitlementState;
export type EntitlementProjection = ManagedEntitlementProjection;

type EntitlementRow = {
  installation_id: string;
  state: string;
  plan_key: string;
  inference_budget_microunits: number;
  inference_period_starts_at: number | null;
  inference_period_ends_at: number | null;
  storage_limit_bytes: number;
  effective_at: number;
  version: number;
};

export class EntitlementStore {
  constructor(private readonly db: D1Database) {}

  async project(input: EntitlementProjection): Promise<EntitlementProjection> {
    const projection = parseProjection(input);
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO entitlements (
         installation_id, state, plan_key, inference_budget_microunits,
         inference_period_starts_at, inference_period_ends_at,
         storage_limit_bytes, effective_at, version
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM installations
       WHERE id = ? AND state NOT IN ('deleting', 'deleted')
       ON CONFLICT(installation_id) DO UPDATE SET
         state = excluded.state,
         plan_key = excluded.plan_key,
         inference_budget_microunits = excluded.inference_budget_microunits,
         inference_period_starts_at = excluded.inference_period_starts_at,
         inference_period_ends_at = excluded.inference_period_ends_at,
         storage_limit_bytes = excluded.storage_limit_bytes,
         effective_at = excluded.effective_at,
         version = excluded.version
       WHERE excluded.version > entitlements.version`,
      ).bind(
        projection.installationId,
        projection.state,
        projection.planKey,
        projection.inferenceBudgetMicrounits,
        projection.inferencePeriodStartsAt,
        projection.inferencePeriodEndsAt,
        projection.storageLimitBytes,
        projection.effectiveAt,
        projection.version,
        projection.installationId,
      ),
      this.db.prepare(
        `UPDATE installations
         SET state = ?
         WHERE id = ?
           AND state IN ('trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained')
           AND EXISTS (
             SELECT 1 FROM provisioning_operations p
             WHERE p.installation_id = installations.id AND p.state = 'complete'
           )
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = installations.id
               AND e.state = ? AND e.plan_key = ?
               AND e.inference_budget_microunits = ?
               AND e.inference_period_starts_at = ?
               AND e.inference_period_ends_at = ?
               AND e.storage_limit_bytes = ?
               AND e.effective_at = ? AND e.version = ?
           )`,
      ).bind(
        projection.state,
        projection.installationId,
        projection.state,
        projection.planKey,
        projection.inferenceBudgetMicrounits,
        projection.inferencePeriodStartsAt,
        projection.inferencePeriodEndsAt,
        projection.storageLimitBytes,
        projection.effectiveAt,
        projection.version,
      ),
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT ?, i.owner_principal_id, e.installation_id,
                'entitlement.projected', 'succeeded', ?, '{}'
         FROM entitlements e
         JOIN installations i ON i.id = e.installation_id
         WHERE e.installation_id = ? AND e.state = ? AND e.plan_key = ?
           AND e.inference_budget_microunits = ?
           AND e.inference_period_starts_at = ?
           AND e.inference_period_ends_at = ?
           AND e.storage_limit_bytes = ?
           AND e.effective_at = ? AND e.version = ?`,
      ).bind(
        `audit_entitlement_${projection.installationId}_${projection.version}`,
        Date.now(),
        projection.installationId,
        projection.state,
        projection.planKey,
        projection.inferenceBudgetMicrounits,
        projection.inferencePeriodStartsAt,
        projection.inferencePeriodEndsAt,
        projection.storageLimitBytes,
        projection.effectiveAt,
        projection.version,
      ),
    ]);
    const stored = await this.get(projection.installationId);
    if (!stored) throw new Error("entitlement installation is unavailable");
    if (!sameProjection(stored, projection)) {
      throw new Error(
        stored.version >= projection.version
          ? "entitlement projection is stale or conflicts with its version"
          : "entitlement projection was not committed",
      );
    }
    return stored;
  }

  async get(installationIdValue: string): Promise<EntitlementProjection | null> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const row = await this.db.prepare(
      `SELECT
         installation_id, state, plan_key, inference_budget_microunits,
         inference_period_starts_at, inference_period_ends_at,
         storage_limit_bytes, effective_at, version
       FROM entitlements
       WHERE installation_id = ?
       LIMIT 1`,
    ).bind(installationId).first<EntitlementRow>();
    return row ? projectionFromRow(row) : null;
  }

  async requireProvisioningAllowed(
    installationId: string,
    now = Date.now(),
  ): Promise<EntitlementProjection> {
    const projection = await this.get(installationId);
    if (
      !projection
      || projection.effectiveAt > now
      || (projection.state !== "trialing" && projection.state !== "active")
    ) {
      throw new Error("provisioning entitlement is required");
    }
    return projection;
  }
}

function parseProjection(input: EntitlementProjection): EntitlementProjection {
  const installationId = parseOpaqueId(input.installationId, "installationId");
  if (!isEntitlementState(input.state)) {
    throw new Error("entitlement state is invalid");
  }
  if (typeof input.planKey !== "string" || !PLAN_KEY_PATTERN.test(input.planKey)) {
    throw new Error("entitlement planKey is invalid");
  }
  for (const [field, value] of [
    ["inferenceBudgetMicrounits", input.inferenceBudgetMicrounits],
    ["storageLimitBytes", input.storageLimitBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`entitlement ${field} is invalid`);
    }
  }
  if (
    !Number.isSafeInteger(input.inferencePeriodStartsAt)
    || !Number.isSafeInteger(input.inferencePeriodEndsAt)
    || input.inferencePeriodStartsAt < 0
    || input.inferencePeriodEndsAt <= input.inferencePeriodStartsAt
  ) {
    throw new Error("entitlement inference period is invalid");
  }
  if (
    !Number.isSafeInteger(input.effectiveAt)
    || input.effectiveAt < 0
    || input.effectiveAt > Date.now() + 60_000
  ) {
    throw new Error("entitlement effectiveAt is invalid");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error("entitlement version is invalid");
  }
  return {
    installationId,
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

function projectionFromRow(row: EntitlementRow): EntitlementProjection {
  if (!isEntitlementState(row.state)) {
    throw new Error("stored entitlement state is invalid");
  }
  if (
    row.inference_period_starts_at === null
    || row.inference_period_ends_at === null
  ) {
    throw new Error("stored entitlement inference period is invalid");
  }
  return {
    installationId: row.installation_id,
    state: row.state,
    planKey: row.plan_key,
    inferenceBudgetMicrounits: row.inference_budget_microunits,
    inferencePeriodStartsAt: row.inference_period_starts_at,
    inferencePeriodEndsAt: row.inference_period_ends_at,
    storageLimitBytes: row.storage_limit_bytes,
    effectiveAt: row.effective_at,
    version: row.version,
  };
}

function isEntitlementState(value: unknown): value is EntitlementState {
  return value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "restricted"
    || value === "cancelled"
    || value === "retained";
}

function sameProjection(
  left: EntitlementProjection,
  right: EntitlementProjection,
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
