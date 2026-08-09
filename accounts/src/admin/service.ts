import type { ManagedInstallationState } from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
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
};

export class InstallationAdminService {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
  ) {}

  async list(): Promise<AdminInstallation[]> {
    const rows = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state,
         p.state AS operation_state,
         c.expires_at AS onboarding_expires_at,
         i.created_at, i.activated_at
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
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

function adminInstallationFromRow(row: AdminInstallationRow): AdminInstallation {
  return {
    installationId: row.id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    operationState: row.operation_state,
    onboardingExpiresAt: row.onboarding_expires_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}
