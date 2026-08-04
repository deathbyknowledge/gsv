import type { PlatformAuthService } from "../auth/service";
import type { InstallationReservation } from "../store";
import { AccountStore } from "../store";
import type { BillingSubscriptionState } from "./domain";
import { BillingStore } from "./store";

type BillingAuth = Pick<PlatformAuthService, "authenticateSession">;

export type BillingInstallationView = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  installationState: InstallationReservation["state"];
  operationState: InstallationReservation["operationState"];
  subscription: null | {
    planKey: string;
    state: BillingSubscriptionState;
    currentPeriodEndsAt: number;
    cancelAtPeriodEnd: boolean;
    paidThrough: number | null;
    graceEndsAt: number | null;
    retentionEndsAt: number | null;
  };
};

export class BillingOverviewService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly billing: BillingStore,
    private readonly auth: BillingAuth,
  ) {}

  async get(sessionToken: string): Promise<BillingInstallationView[]> {
    const session = await this.auth.authenticateSession(sessionToken);
    if (!session) throw new Error("authentication required");
    const installations = await this.accounts.listInstallationsForPrincipal(
      session.principal.id,
    );
    return await Promise.all(installations
      .filter((installation) => (
        installation.ownerPrincipalId === session.principal.id
        && installation.state !== "deleted"
      ))
      .map(async (installation) => {
        const subscription = await this.billing.getSubscriptionByInstallation(
          installation.installationId,
        );
        return {
          installationId: installation.installationId,
          handle: installation.handle,
          canonicalOrigin: installation.canonicalOrigin,
          installationState: installation.state,
          operationState: installation.operationState,
          subscription: subscription ? {
            planKey: subscription.planKey,
            state: subscription.state,
            currentPeriodEndsAt: subscription.currentPeriodEndsAt,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            paidThrough: subscription.paidThrough,
            graceEndsAt: subscription.graceEndsAt,
            retentionEndsAt: subscription.retentionEndsAt,
          } : null,
        };
      }));
  }
}
