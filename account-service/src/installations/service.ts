import type { ManagedGatewayProvisioningInterface } from "@humansandmachines/gsv/protocol";
import type { PlatformAuthService } from "../auth/service";
import {
  EntitlementStore,
  type EntitlementProjection,
} from "../entitlements/store";
import { sha256Hex } from "../security/tokens";
import { provisionReservedInstallation } from "../provisioning";
import { AccountStore, type InstallationReservation } from "../store";

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ManagedInstallationView = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: InstallationReservation["state"];
  operationState: InstallationReservation["operationState"];
  ownerUsername: string | null;
  agentName: string | null;
  timezone: string | null;
  reservationExpiresAt: number | null;
  entitlement: null | Pick<EntitlementProjection, "state" | "planKey" | "effectiveAt">;
};

export class InstallationProvisioningUnavailableError extends Error {}

export class ManagedInstallationService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly entitlements: EntitlementStore,
    private readonly auth: PlatformAuthService,
    private readonly gateway: ManagedGatewayProvisioningInterface,
  ) {}

  async list(sessionToken: string): Promise<ManagedInstallationView[]> {
    const session = await this.auth.authenticateSession(sessionToken);
    if (!session) throw new Error("authentication required");
    const reservations = await this.accounts.listInstallationsForPrincipal(
      session.principal.id,
    );
    return await Promise.all(reservations.map((reservation) => this.view(reservation)));
  }

  async reserve(input: {
    sessionToken: string;
    idempotencyKey: string;
    handle: string;
    ownerUsername: string;
    agentName?: string;
    timezone?: string;
  }): Promise<ManagedInstallationView> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const operationHash = await sha256Hex(
      `gsv-installation-reservation:${session.principal.id}:${idempotencyKey}`,
    );
    const reservation = await this.accounts.reserveInstallation({
      principalId: session.principal.id,
      operationId: `operation_${operationHash}`,
      handle: input.handle,
      ownerUsername: input.ownerUsername,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    return await this.view(reservation);
  }

  async provision(input: {
    sessionToken: string;
    installationId: string;
  }): Promise<ManagedInstallationView> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const reservation = await this.accounts.getOwnedInstallation(
      input.installationId,
      session.principal.id,
    );
    if (!reservation) throw new Error("installation is unavailable");
    if (!reservation.ownerUsername) {
      throw new Error("installation setup is incomplete");
    }
    let completed: InstallationReservation;
    try {
      completed = await provisionReservedInstallation(this.accounts, this.gateway, {
        principalId: session.principal.id,
        operationId: reservation.operationId,
        username: reservation.ownerUsername,
        ...(reservation.agentName ? { agentName: reservation.agentName } : {}),
        ...(reservation.timezone ? { timezone: reservation.timezone } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("entitlement") || message.includes("reservation expired")) {
        throw error;
      }
      throw new InstallationProvisioningUnavailableError(
        "managed installation provisioning failed",
      );
    }
    return await this.view(completed);
  }

  private async view(
    reservation: InstallationReservation,
  ): Promise<ManagedInstallationView> {
    const entitlement = await this.entitlements.get(reservation.installationId);
    return {
      installationId: reservation.installationId,
      handle: reservation.handle,
      canonicalOrigin: reservation.canonicalOrigin,
      state: reservation.state,
      operationState: reservation.operationState,
      ownerUsername: reservation.ownerUsername,
      agentName: reservation.agentName,
      timezone: reservation.timezone,
      reservationExpiresAt: reservation.reservationExpiresAt,
      entitlement: entitlement ? {
        state: entitlement.state,
        planKey: entitlement.planKey,
        effectiveAt: entitlement.effectiveAt,
      } : null,
    };
  }
}

function parseIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("idempotencyKey is invalid");
  }
  return value.toLowerCase();
}
