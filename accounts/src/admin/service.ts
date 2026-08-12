import type { ManagedInstallationState } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import type { ManagedInferencePolicyStore } from "../inference-policy";
import type { IssuedInstallationOnboarding } from "../onboarding";
import { InstallationOnboardingStore } from "../onboarding";
import { AccountStore } from "../store";

const REGISTRY_PRINCIPAL_ID = "principal_managed_registry";
const REGISTRY_PRINCIPAL_EMAIL = "registry@gsv.invalid";

export type AdminInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: ManagedInstallationState;
  operationState: "reserved" | "provisioning" | "complete" | "failed";
  onboardingExpiresAt: number | null;
  createdAt: number;
  activatedAt: number | null;
  inference: {
    enabled: boolean;
    monthlyLimitNanoUsd: number;
    period: string;
    requests: number;
    tokens: number;
    costNanoUsd: number;
    failed: number;
    aborted: number;
    abandoned: number;
  };
};

export type AdminOverview = {
  inference: {
    enabled: boolean;
  };
  installations: AdminInstallation[];
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
  onboarding_expires_at: number | null;
  created_at: number;
  activated_at: number | null;
  inference_requests?: number;
  inference_tokens?: number;
  inference_cost_nano_usd?: number;
  inference_failed?: number;
  inference_aborted?: number;
  inference_abandoned?: number;
  inference_enabled?: number;
  inference_monthly_limit_nano_usd?: number;
};

export class InstallationAdminService {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly inferencePolicies: ManagedInferencePolicyStore,
  ) {}

  async overview(): Promise<AdminOverview> {
    const [installations, control] = await Promise.all([
      this.listInstallations(),
      this.inferencePolicies.control(),
    ]);
    return {
      inference: { enabled: control.enabled },
      installations,
    };
  }

  async setInferenceControl(enabled: boolean): Promise<void> {
    await this.inferencePolicies.setControl(enabled);
  }

  async setInstallationInferencePolicy(
    installationId: string,
    input: { enabled: boolean; monthlyLimitNanoUsd: number },
  ): Promise<void> {
    await this.inferencePolicies.setInstallationPolicy(installationId, input);
  }

  async setInstallationState(
    installationIdValue: string,
    state: "active" | "restricted",
  ): Promise<void> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const expectedState = state === "active" ? "restricted" : "active";
    const result = await this.db.prepare(
      `UPDATE installations
       SET state = ?
       WHERE id = ? AND state = ?`,
    ).bind(state, installationId, expectedState).run();
    if ((result.meta.changes ?? 0) === 1) return;

    const current = await this.db.prepare(
      `SELECT state
       FROM installations
       WHERE id = ? AND state != 'deleted'
       LIMIT 1`,
    ).bind(installationId).first<{ state: ManagedInstallationState }>();
    if (!current) throw new Error("installation is unavailable");
    if (current.state === state) return;
    throw new Error(
      `installation cannot transition from ${current.state} to ${state}`,
    );
  }

  private async listInstallations(): Promise<AdminInstallation[]> {
    const period = currentInferencePeriod();
    const rows = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state,
         p.state AS operation_state,
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at,
         COALESCE(u.requests, 0) AS inference_requests,
         COALESCE(u.tokens, 0) AS inference_tokens,
         COALESCE(u.cost_nano_usd, 0) AS inference_cost_nano_usd,
         COALESCE(u.failed, 0) AS inference_failed,
         COALESCE(u.aborted, 0) AS inference_aborted,
         COALESCE(u.abandoned, 0) AS inference_abandoned,
         COALESCE(ip.enabled, 0) AS inference_enabled,
         COALESCE(ip.monthly_limit_nano_usd, 0)
           AS inference_monthly_limit_nano_usd
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       LEFT JOIN managed_inference_policies ip ON ip.installation_id = i.id
       LEFT JOIN (
         SELECT
           installation_id,
           COUNT(*) AS requests,
           SUM(total_tokens) AS tokens,
           SUM(cost_nano_usd) AS cost_nano_usd,
           SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END) AS aborted,
           SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned
         FROM managed_inference_usage_events
         WHERE period = ?
         GROUP BY installation_id
       ) u ON u.installation_id = i.id
       WHERE i.state != 'deleted'
       ORDER BY i.created_at DESC`,
    ).bind(period).all<AdminInstallationRow>();
    return rows.results.map((row) => adminInstallationFromRow(row, period));
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
    const onboarding = await this.onboarding.begin(reservation.installationId);
    return {
      installation: await this.requireInstallation(reservation.installationId),
      onboarding,
    };
  }

  async reissueOnboarding(
    installationIdValue: string,
  ): Promise<IssuedAdminInstallation> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
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
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       WHERE i.id = ? AND i.state != 'deleted'
       LIMIT 1`,
    ).bind(installationId).first<AdminInstallationRow>();
    if (!row) throw new Error("installation is unavailable");
    return adminInstallationFromRow(row, currentInferencePeriod());
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
  inferencePeriod: string,
): AdminInstallation {
  return {
    installationId: row.id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    operationState: row.operation_state,
    onboardingExpiresAt: row.onboarding_expires_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    inference: {
      enabled: row.inference_enabled === 1,
      monthlyLimitNanoUsd: row.inference_monthly_limit_nano_usd ?? 0,
      period: inferencePeriod,
      requests: row.inference_requests ?? 0,
      tokens: row.inference_tokens ?? 0,
      costNanoUsd: row.inference_cost_nano_usd ?? 0,
      failed: row.inference_failed ?? 0,
      aborted: row.inference_aborted ?? 0,
      abandoned: row.inference_abandoned ?? 0,
    },
  };
}

function currentInferencePeriod(): string {
  return new Date().toISOString().slice(0, 7);
}
