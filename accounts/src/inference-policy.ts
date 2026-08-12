import type { ManagedInferencePolicy } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "./domain";

export type ManagedInferenceControl = {
  enabled: boolean;
  updatedAt: number;
};

export type ManagedInferenceInstallationPolicy = {
  enabled: boolean;
  monthlyLimitNanoUsd: number;
  updatedAt: number | null;
};

type ResolvedPolicyRow = {
  state: string | null;
  control_enabled: number;
  policy_enabled: number;
  monthly_limit_nano_usd: number;
};

export class ManagedInferencePolicyStore {
  constructor(private readonly db: D1Database) {}

  async resolve(
    installationIdValue: string,
  ): Promise<ManagedInferencePolicy> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const row = await this.db.prepare(
      `SELECT
         i.state,
         c.enabled AS control_enabled,
         COALESCE(p.enabled, 0) AS policy_enabled,
         COALESCE(p.monthly_limit_nano_usd, 0) AS monthly_limit_nano_usd
       FROM managed_inference_control c
       LEFT JOIN installations i ON i.id = ? AND i.state != 'deleted'
       LEFT JOIN managed_inference_policies p ON p.installation_id = i.id
       WHERE c.singleton = 1`,
    ).bind(installationId).first<ResolvedPolicyRow>();
    if (!row) throw new Error("managed inference control is unavailable");
    const monthlyLimitNanoUsd = storedMonthlyLimit(
      row.monthly_limit_nano_usd,
    );
    return {
      version: 1,
      installationId,
      enabled: row.control_enabled === 1
        && row.state === "active"
        && row.policy_enabled === 1
        && monthlyLimitNanoUsd > 0,
      monthlyLimitNanoUsd,
    };
  }

  async control(): Promise<ManagedInferenceControl> {
    const row = await this.db.prepare(
      `SELECT enabled, updated_at
       FROM managed_inference_control
       WHERE singleton = 1`,
    ).first<{ enabled: number; updated_at: number }>();
    if (!row) throw new Error("managed inference control is unavailable");
    return {
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    };
  }

  async setControl(enabledValue: boolean): Promise<ManagedInferenceControl> {
    const enabled = requiredBoolean(enabledValue, "enabled");
    const updatedAt = Date.now();
    const result = await this.db.prepare(
      `UPDATE managed_inference_control
       SET enabled = ?, updated_at = ?
       WHERE singleton = 1`,
    ).bind(enabled ? 1 : 0, updatedAt).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("managed inference control is unavailable");
    }
    return { enabled, updatedAt };
  }

  async setInstallationPolicy(
    installationIdValue: string,
    input: { enabled: boolean; monthlyLimitNanoUsd: number },
  ): Promise<ManagedInferenceInstallationPolicy> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const enabled = requiredBoolean(input.enabled, "enabled");
    const monthlyLimitNanoUsd = requiredMonthlyLimit(
      input.monthlyLimitNanoUsd,
    );
    if (enabled && monthlyLimitNanoUsd === 0) {
      throw new Error("managed inference monthly limit is required when enabled");
    }
    const updatedAt = Date.now();
    const result = await this.db.prepare(
      `INSERT INTO managed_inference_policies (
         installation_id, enabled, monthly_limit_nano_usd, updated_at
       )
       SELECT id, ?, ?, ?
       FROM installations
       WHERE id = ? AND state != 'deleted'
       ON CONFLICT(installation_id) DO UPDATE SET
         enabled = excluded.enabled,
         monthly_limit_nano_usd = excluded.monthly_limit_nano_usd,
         updated_at = excluded.updated_at`,
    ).bind(
      enabled ? 1 : 0,
      monthlyLimitNanoUsd,
      updatedAt,
      installationId,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("installation is unavailable");
    }
    return { enabled, monthlyLimitNanoUsd, updatedAt };
  }
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is invalid`);
  return value;
}

function requiredMonthlyLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("managed inference monthly limit is invalid");
  }
  return value;
}

function storedMonthlyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("stored managed inference monthly limit is invalid");
  }
  return value;
}
