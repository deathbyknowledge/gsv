import type { InstallationResetService } from "@humansandmachines/gsv/services/lifecycle";
import { InstallationAdminStore, type AdminInstallation } from "../administration";
import { parseOpaqueId } from "../domain";
import { InstallationOnboardingStore, type IssuedInstallationOnboarding } from "../onboarding";
import { InstallationResetCoordinator } from "../reset-preparation";
import { AccountStore, type InstallationDataDeletionState } from "../store";

export type IssuedAdminInstallation = {
  installation: AdminInstallation;
  onboarding: IssuedInstallationOnboarding;
  reset?: { previousInstallationId: string; dataDeletionState: InstallationDataDeletionState };
};

/** The hosting operator supplies this identity; an HTTP caller cannot choose it. */
export type OperatorRegistryPrincipal = { id: string; email: string; displayName: string };

export class InstallationAdminService extends InstallationAdminStore {
  private readonly resets: InstallationResetCoordinator;

  constructor(
    private readonly database: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly registryPrincipal: OperatorRegistryPrincipal,
    participants: Readonly<Record<string, InstallationResetService>>,
  ) {
    super(database);
    this.resets = new InstallationResetCoordinator(database, accounts, participants);
  }

  async reserve(input: { operationId: string; handle: string }) {
    await this.ensureRegistryPrincipal();
    return this.accounts.reserveInstallation({
      principalId: this.registryPrincipal.id, operationId: input.operationId, handle: input.handle,
    });
  }

  async create(input: { operationId: string; handle: string }): Promise<IssuedAdminInstallation> {
    const reservation = await this.reserve(input);
    const onboarding = await this.onboarding.begin(reservation.installationId);
    return { installation: await this.requireInstallation(reservation.installationId), onboarding };
  }

  async reissueOnboarding(installationIdValue: string): Promise<IssuedAdminInstallation> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const onboarding = await this.onboarding.begin(installationId);
    return { installation: await this.requireInstallation(installationId), onboarding };
  }

  async resetInstallation(
    installationIdValue: string,
    input: { operationId: string; confirmHandle: string },
  ): Promise<IssuedAdminInstallation> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const reset = await this.resets.reset({ installationId, operationId: input.operationId, confirmHandle: input.confirmHandle });
    const onboarding = await this.onboarding.begin(reset.installationId);
    return {
      installation: await this.requireInstallation(reset.installationId), onboarding,
      reset: { previousInstallationId: reset.previousInstallationId, dataDeletionState: reset.dataDeletionState },
    };
  }

  private async requireInstallation(installationId: string): Promise<AdminInstallation> {
    const installation = await this.getInstallation(installationId);
    if (!installation) throw new Error("installation is unavailable");
    return installation;
  }

  private async ensureRegistryPrincipal(): Promise<void> {
    const { id, email, displayName } = this.registryPrincipal;
    const now = Date.now();
    await this.database.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(id, email, email.trim().toLowerCase(), displayName, now, now, now).run();
    const principal = await this.accounts.getPrincipal(id);
    if (!principal || principal.state !== "active" || principal.emailVerifiedAt === null) {
      throw new Error("installation registry principal is unavailable");
    }
  }
}
