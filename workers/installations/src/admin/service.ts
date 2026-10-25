import { UsernamePolicy, type UsernamePolicyInput, type UsernamePolicyLists } from "../username-policy";
import type { InstallationResetService } from "@humansandmachines/gsv/services/lifecycle";
import type { PdsModerationService } from "@humansandmachines/gsv/services/pds";
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

/** What resetting a Ship does to its person, which an operator reads before confirming one. */
export const RESET_CONSEQUENCES: readonly string[] = [
  "The person gets a new Ship at the same address and can't return to this one. They set it up again from a new activation link, and sessions, devices, messengers and background work on this Ship stop.",
  "They get a new identity on the open network: the new Ship registers a new DID.",
  "Their contacts end, and each one needs a new invitation.",
  "Their public profile and records stop being served, and leave the open network when this Ship's data is erased.",
  "Nothing is erased yet: this Ship's data is kept as pending deletion until a separate deletion removes it.",
];

/** Accounts kept a Ship's new lifecycle state, but the deployment's PDS could not follow it. */
export class OpenNetworkFollowError extends Error {
  constructor(readonly state: "active" | "restricted", options: ErrorOptions) {
    super(`The Ship is ${state === "restricted" ? "suspended" : "reactivated"}, but its open-network host could not be told.`, options);
    this.name = "OpenNetworkFollowError";
  }
}

export class InstallationAdminService extends InstallationAdminStore {
  private readonly resets: InstallationResetCoordinator;

  constructor(
    private readonly database: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly registryPrincipal: OperatorRegistryPrincipal,
    participants: Readonly<Record<string, InstallationResetService>>,
    /** The deployment's PDS, which tells relays when a Ship is suspended or reactivated. */
    private readonly pds?: PdsModerationService,
  ) {
    super(database);
    this.resets = new InstallationResetCoordinator(database, accounts, participants);
  }

  /**
   * Suspends or reactivates the installation, then has the deployment's PDS
   * follow. If the PDS can't, the request fails with the new state kept, and
   * repeating it tells the PDS.
   */
  override async setInstallationState(installationId: string, state: "active" | "restricted"): Promise<void> {
    await super.setInstallationState(installationId, state);
    try {
      await this.pds?.reconcileAccountStatus(installationId);
    } catch (error) {
      throw new OpenNetworkFollowError(state, { cause: error });
    }
  }

  getUsernamePolicy(): Promise<UsernamePolicyLists> {
    return new UsernamePolicy(this.database).list();
  }

  setUsernamePolicy(value: UsernamePolicyInput): Promise<void> {
    return new UsernamePolicy(this.database).replace(value);
  }

  async reserve(input: { operationId: string; handle: string }) {
    await this.ensureRegistryPrincipal();
    return this.accounts.reserveInstallation({
      principalId: this.registryPrincipal.id, operationId: input.operationId, handle: input.handle, allowReservedHandle: true,
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
