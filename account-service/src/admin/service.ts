import type {
  ManagedEntitlementState,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import type { EntitlementProjector } from "../entitlements/projector";
import { EntitlementStore } from "../entitlements/store";
import type { IssuedInstallationOnboarding } from "../installations/onboarding";
import { InstallationOnboardingStore } from "../installations/onboarding";
import { AccountStore } from "../store";

const REGISTRY_PRINCIPAL_ID = "principal_managed_registry";
const REGISTRY_PRINCIPAL_EMAIL = "registry@gsv.invalid";
const ENTITLEMENT_PERIOD_MS = 30 * 24 * 60 * 60_000;

export type OperatorEntitlement = {
  planKey: string;
  inferenceBudgetMicrounits: number;
  storageLimitBytes: number;
};

export type OperatorEntitlementEnvironment = {
  GSV_OPERATOR_PLAN_KEY: string;
  GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS: string;
  GSV_OPERATOR_STORAGE_LIMIT_BYTES: string;
};

export function operatorEntitlementConfig(
  env: OperatorEntitlementEnvironment,
): OperatorEntitlement {
  const planKey = env.GSV_OPERATOR_PLAN_KEY.trim();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(planKey)) {
    throw new Error("GSV_OPERATOR_PLAN_KEY is invalid");
  }
  return {
    planKey,
    inferenceBudgetMicrounits: positiveInteger(
      env.GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS,
      "GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS",
    ),
    storageLimitBytes: positiveInteger(
      env.GSV_OPERATOR_STORAGE_LIMIT_BYTES,
      "GSV_OPERATOR_STORAGE_LIMIT_BYTES",
    ),
  };
}

export type AdminInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: ManagedInstallationState;
  operationState: "reserved" | "provisioning" | "complete" | "failed";
  entitlementState: ManagedEntitlementState | null;
  planKey: string | null;
  onboardingExpiresAt: number | null;
  createdAt: number;
  activatedAt: number | null;
};

export type IssuedAdminInstallation = {
  installation: AdminInstallation;
  onboarding: IssuedInstallationOnboarding;
};

type AdminInstallationRow = {
  id: string;
  handle: string;
  canonical_origin: string;
  state: ManagedInstallationState;
  operation_state: AdminInstallation["operationState"];
  entitlement_state: ManagedEntitlementState | null;
  plan_key: string | null;
  onboarding_expires_at: number | null;
  created_at: number;
  activated_at: number | null;
};

export class InstallationAdminService {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly entitlements: EntitlementStore,
    private readonly entitlementProjector: EntitlementProjector,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly entitlement: OperatorEntitlement,
  ) {}

  async list(): Promise<AdminInstallation[]> {
    const rows = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state,
         p.state AS operation_state,
         e.state AS entitlement_state, e.plan_key,
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       LEFT JOIN entitlements e ON e.installation_id = i.id
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       WHERE i.state != 'deleted'
       ORDER BY i.created_at DESC`,
    ).all<AdminInstallationRow>();
    return rows.results.map(adminInstallationFromRow);
  }

  async create(input: {
    operationId: string;
    handle: string;
  }): Promise<IssuedAdminInstallation> {
    await this.ensureRegistryPrincipal();
    const reservation = await this.accounts.reserveInstallation({
      principalId: REGISTRY_PRINCIPAL_ID,
      operationId: input.operationId,
      handle: input.handle,
    });
    const now = Date.now();
    const storedEntitlement = await this.entitlements.get(
      reservation.installationId,
    );
    if (
      storedEntitlement
      && storedEntitlement.state !== "trialing"
      && storedEntitlement.state !== "active"
    ) {
      throw new Error("installation entitlement does not permit onboarding");
    }
    await this.entitlementProjector.project(storedEntitlement ?? {
      installationId: reservation.installationId,
      state: "active",
      planKey: this.entitlement.planKey,
      inferenceBudgetMicrounits: this.entitlement.inferenceBudgetMicrounits,
      inferencePeriodStartsAt: now,
      inferencePeriodEndsAt: now + ENTITLEMENT_PERIOD_MS,
      storageLimitBytes: this.entitlement.storageLimitBytes,
      effectiveAt: now,
      version: 1,
    });
    const onboarding = await this.onboarding.begin(reservation.installationId);
    return {
      installation: await this.requireInstallation(reservation.installationId),
      onboarding,
    };
  }

  async reissueOnboarding(
    installationIdValue: string,
  ): Promise<IssuedAdminInstallation> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const onboarding = await this.onboarding.begin(installationId);
    return {
      installation: await this.requireInstallation(installationId),
      onboarding,
    };
  }

  private async requireInstallation(
    installationId: string,
  ): Promise<AdminInstallation> {
    const row = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state,
         p.state AS operation_state,
         e.state AS entitlement_state, e.plan_key,
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       LEFT JOIN entitlements e ON e.installation_id = i.id
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       WHERE i.id = ? AND i.state != 'deleted'
       LIMIT 1`,
    ).bind(installationId).first<AdminInstallationRow>();
    if (!row) throw new Error("installation is unavailable");
    return adminInstallationFromRow(row);
  }

  private async ensureRegistryPrincipal(): Promise<void> {
    const now = Date.now();
    await this.db.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'Managed registry', ?, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      REGISTRY_PRINCIPAL_ID,
      REGISTRY_PRINCIPAL_EMAIL,
      REGISTRY_PRINCIPAL_EMAIL,
      now,
      now,
      now,
    ).run();
    const principal = await this.accounts.getPrincipal(REGISTRY_PRINCIPAL_ID);
    if (
      !principal
      || principal.state !== "active"
      || principal.emailVerifiedAt === null
    ) {
      throw new Error("managed registry principal is unavailable");
    }
  }
}

function adminInstallationFromRow(
  row: AdminInstallationRow,
): AdminInstallation {
  return {
    installationId: row.id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    operationState: row.operation_state,
    entitlementState: row.entitlement_state,
    planKey: row.plan_key,
    onboardingExpiresAt: row.onboarding_expires_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

function positiveInteger(value: string, field: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${field} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}
