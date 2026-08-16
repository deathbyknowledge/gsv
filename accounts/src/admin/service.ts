import type { ManagedInstallationState } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import type { ManagedInferencePolicyStore } from "../inference-policy";
import type { IssuedInstallationOnboarding } from "../onboarding";
import { InstallationOnboardingStore } from "../onboarding";
import {
  AccountStore,
  type InstallationDataDeletionState,
} from "../store";

const REGISTRY_PRINCIPAL_ID = "principal_managed_registry";
const REGISTRY_PRINCIPAL_EMAIL = "registry@gsv.invalid";
export const ADMIN_INSTALLATIONS_PAGE_SIZE = 50;

export const ADMIN_VISIBLE_INSTALLATION_STATES = [
  "reserved",
  "provisioning",
  "trialing",
  "active",
  "past_due",
  "restricted",
  "cancelled",
  "retained",
  "deleting",
] as const satisfies readonly ManagedInstallationState[];

export type AdminVisibleInstallationState =
  typeof ADMIN_VISIBLE_INSTALLATION_STATES[number];

type AdminOperationState =
  | "reserved"
  | "provisioning"
  | "complete"
  | "failed";

export type AdminInstallationSummary = {
  installationId: string;
  handle: string;
  state: ManagedInstallationState;
  operationState: AdminOperationState;
  createdAt: number;
  inferenceEnabled: boolean;
};

export type AdminInstallationListQuery = {
  query: string;
  state: AdminVisibleInstallationState | null;
  page: number;
};

export type AdminInstallationList = AdminInstallationListQuery & {
  installations: AdminInstallationSummary[];
  pageSize: number;
  total: number;
  totalPages: number;
};

export type AdminInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: ManagedInstallationState;
  operationState: AdminOperationState;
  onboardingExpiresAt: number | null;
  createdAt: number;
  activatedAt: number | null;
  reset: {
    previousInstallationId: string;
    dataDeletionState: InstallationDataDeletionState;
  } | null;
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
    mailIntake: AdminInferencePurposeUsage;
  };
};

export type AdminInferencePurposeUsage = {
  requests: number;
  tokens: number;
  costNanoUsd: number;
};

export type AdminInferenceOverview = {
  enabled: boolean;
  period: string;
  requests: number;
  tokens: number;
  costNanoUsd: number;
  failed: number;
  aborted: number;
  abandoned: number;
  mailIntake: AdminInferencePurposeUsage;
};

export type IssuedAdminInstallation = {
  installation: AdminInstallation;
  onboarding: IssuedInstallationOnboarding;
  reset?: {
    previousInstallationId: string;
    dataDeletionState: InstallationDataDeletionState;
  };
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
  inference_mail_intake_requests?: number;
  inference_mail_intake_tokens?: number;
  inference_mail_intake_cost_nano_usd?: number;
  inference_enabled?: number;
  inference_monthly_limit_nano_usd?: number;
  previous_installation_id?: string | null;
  data_deletion_state?: InstallationDataDeletionState | null;
};

type AdminInstallationSummaryRow = Pick<
  AdminInstallationRow,
  | "id"
  | "handle"
  | "state"
  | "operation_state"
  | "created_at"
  | "inference_enabled"
>;

type AdminInferenceUsageRow = {
  requests: number;
  tokens: number;
  cost_nano_usd: number;
  failed: number;
  aborted: number;
  abandoned: number;
  mail_intake_requests: number;
  mail_intake_tokens: number;
  mail_intake_cost_nano_usd: number;
};

export class InstallationAdminService {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly inferencePolicies: ManagedInferencePolicyStore,
  ) {}

  async listInstallations(
    input: AdminInstallationListQuery,
  ): Promise<AdminInstallationList> {
    const query = input.query.trim().toLowerCase();
    if (query.length > 100) throw new Error("query is too long");
    if (
      input.state !== null
      && !ADMIN_VISIBLE_INSTALLATION_STATES.includes(input.state)
    ) {
      throw new Error("state is invalid");
    }
    if (!Number.isSafeInteger(input.page) || input.page < 1) {
      throw new Error("page is invalid");
    }

    const predicates = [
      "i.state != 'deleted'",
      `NOT EXISTS (
        SELECT 1 FROM installation_reset_operations r
        WHERE r.previous_installation_id = i.id
      )`,
    ];
    const bindings: Array<string | number> = [];
    if (query) {
      predicates.push("(instr(i.handle, ?) > 0 OR instr(i.id, ?) > 0)");
      bindings.push(query, query);
    }
    if (input.state !== null) {
      predicates.push("i.state = ?");
      bindings.push(input.state);
    }
    const where = predicates.join(" AND ");
    const offset = (input.page - 1) * ADMIN_INSTALLATIONS_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) throw new Error("page is invalid");

    const [count, rows] = await Promise.all([
      this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM installations i
         WHERE ${where}`,
      ).bind(...bindings).first<{ total: number }>(),
      this.db.prepare(
        `SELECT
           i.id, i.handle, i.state,
           (
             SELECT p.state
             FROM provisioning_operations p
             WHERE p.installation_id = i.id AND p.kind = 'create'
             ORDER BY p.updated_at DESC
             LIMIT 1
           ) AS operation_state,
           i.created_at,
           COALESCE(ip.enabled, 0) AS inference_enabled
         FROM installations i
         LEFT JOIN managed_inference_policies ip ON ip.installation_id = i.id
         WHERE ${where}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT ? OFFSET ?`,
      ).bind(
        ...bindings,
        ADMIN_INSTALLATIONS_PAGE_SIZE,
        offset,
      ).all<AdminInstallationSummaryRow>(),
    ]);
    const total = count?.total ?? 0;
    return {
      query,
      state: input.state,
      page: input.page,
      pageSize: ADMIN_INSTALLATIONS_PAGE_SIZE,
      total,
      totalPages: Math.max(
        1,
        Math.ceil(total / ADMIN_INSTALLATIONS_PAGE_SIZE),
      ),
      installations: rows.results.map(adminInstallationSummaryFromRow),
    };
  }

  async inferenceOverview(): Promise<AdminInferenceOverview> {
    const period = currentInferencePeriod();
    const [control, usage] = await Promise.all([
      this.inferencePolicies.control(),
      this.db.prepare(
        `SELECT
           COUNT(*) AS requests,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd,
           COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0)
             AS failed,
           COALESCE(SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END), 0)
             AS aborted,
           COALESCE(SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END), 0)
             AS abandoned,
           COALESCE(SUM(CASE WHEN purpose = 'mail-intake' THEN 1 ELSE 0 END), 0)
             AS mail_intake_requests,
           COALESCE(SUM(CASE WHEN purpose = 'mail-intake' THEN total_tokens ELSE 0 END), 0)
             AS mail_intake_tokens,
           COALESCE(SUM(CASE WHEN purpose = 'mail-intake' THEN cost_nano_usd ELSE 0 END), 0)
             AS mail_intake_cost_nano_usd
         FROM managed_inference_usage_events
         WHERE period = ?`,
      ).bind(period).first<AdminInferenceUsageRow>(),
    ]);
    return {
      enabled: control.enabled,
      period,
      requests: usage?.requests ?? 0,
      tokens: usage?.tokens ?? 0,
      costNanoUsd: usage?.cost_nano_usd ?? 0,
      failed: usage?.failed ?? 0,
      aborted: usage?.aborted ?? 0,
      abandoned: usage?.abandoned ?? 0,
      mailIntake: {
        requests: usage?.mail_intake_requests ?? 0,
        tokens: usage?.mail_intake_tokens ?? 0,
        costNanoUsd: usage?.mail_intake_cost_nano_usd ?? 0,
      },
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

  async getInstallation(
    installationIdValue: string,
  ): Promise<AdminInstallation | null> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const period = currentInferencePeriod();
    const row = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state,
         (
           SELECT p.state
           FROM provisioning_operations p
           WHERE p.installation_id = i.id AND p.kind = 'create'
           ORDER BY p.updated_at DESC
           LIMIT 1
         ) AS operation_state,
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at,
         COALESCE(u.requests, 0) AS inference_requests,
         COALESCE(u.tokens, 0) AS inference_tokens,
         COALESCE(u.cost_nano_usd, 0) AS inference_cost_nano_usd,
         COALESCE(u.failed, 0) AS inference_failed,
         COALESCE(u.aborted, 0) AS inference_aborted,
         COALESCE(u.abandoned, 0) AS inference_abandoned,
         COALESCE(u.mail_intake_requests, 0) AS inference_mail_intake_requests,
         COALESCE(u.mail_intake_tokens, 0) AS inference_mail_intake_tokens,
         COALESCE(u.mail_intake_cost_nano_usd, 0)
           AS inference_mail_intake_cost_nano_usd,
         COALESCE(ip.enabled, 0) AS inference_enabled,
         COALESCE(ip.monthly_limit_nano_usd, 0)
           AS inference_monthly_limit_nano_usd,
         reset.previous_installation_id,
         reset.data_deletion_state
       FROM installations i
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       LEFT JOIN managed_inference_policies ip ON ip.installation_id = i.id
       LEFT JOIN installation_reset_operations reset
         ON reset.replacement_installation_id = i.id
       LEFT JOIN (
         SELECT
           installation_id,
           COUNT(*) AS requests,
           SUM(total_tokens) AS tokens,
           SUM(cost_nano_usd) AS cost_nano_usd,
           SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END) AS aborted,
           SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN purpose = 'mail-intake' THEN 1 ELSE 0 END)
             AS mail_intake_requests,
           SUM(CASE WHEN purpose = 'mail-intake' THEN total_tokens ELSE 0 END)
             AS mail_intake_tokens,
           SUM(CASE WHEN purpose = 'mail-intake' THEN cost_nano_usd ELSE 0 END)
             AS mail_intake_cost_nano_usd
         FROM managed_inference_usage_events
         WHERE period = ? AND installation_id = ?
         GROUP BY installation_id
       ) u ON u.installation_id = i.id
       WHERE i.id = ? AND i.state != 'deleted'
       LIMIT 1`,
    ).bind(period, installationId, installationId).first<AdminInstallationRow>();
    return row ? adminInstallationFromRow(row, period) : null;
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

  async resetInstallation(
    installationIdValue: string,
    input: { operationId: string; confirmHandle: string },
  ): Promise<IssuedAdminInstallation> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const reset = await this.accounts.resetInstallation({
      installationId,
      operationId: input.operationId,
      confirmHandle: input.confirmHandle,
    });
    const onboarding = await this.onboarding.begin(reset.installationId);
    return {
      installation: await this.requireInstallation(reset.installationId),
      onboarding,
      reset: {
        previousInstallationId: reset.previousInstallationId,
        dataDeletionState: reset.dataDeletionState,
      },
    };
  }

  private async requireInstallation(
    installationId: string,
  ): Promise<AdminInstallation> {
    const installation = await this.getInstallation(installationId);
    if (!installation) throw new Error("installation is unavailable");
    return installation;
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

function adminInstallationSummaryFromRow(
  row: AdminInstallationSummaryRow,
): AdminInstallationSummary {
  return {
    installationId: row.id,
    handle: row.handle,
    state: row.state,
    operationState: row.operation_state,
    createdAt: row.created_at,
    inferenceEnabled: row.inference_enabled === 1,
  };
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
    reset: row.previous_installation_id && row.data_deletion_state
      ? {
          previousInstallationId: row.previous_installation_id,
          dataDeletionState: row.data_deletion_state,
        }
      : null,
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
      mailIntake: {
        requests: row.inference_mail_intake_requests ?? 0,
        tokens: row.inference_mail_intake_tokens ?? 0,
        costNanoUsd: row.inference_mail_intake_cost_nano_usd ?? 0,
      },
    },
  };
}

function currentInferencePeriod(): string {
  return new Date().toISOString().slice(0, 7);
}
