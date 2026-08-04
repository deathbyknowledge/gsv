import type {
  ManagedGatewayTelegramInterface,
  ManagedTelegramClaim,
  ManagedTelegramClaimInspection,
  ManagedTelegramControlInterface,
} from "@humansandmachines/gsv/protocol";
import type { PlatformAuthService } from "../auth/service";
import { parseOpaqueId } from "../domain";
import { sha256Hex } from "../security/tokens";
import {
  AccountStore,
  type ActiveInstallationMembership,
} from "../store";
import {
  ManagedTelegramLinkOperationStore,
  type ManagedTelegramLinkOperation,
} from "./store";

type TelegramLinkAuth = Pick<
  PlatformAuthService,
  "authenticateSession" | "requireRecentPasskeySession"
>;

export type ManagedTelegramLinkableInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: ActiveInstallationMembership["state"];
  role: ActiveInstallationMembership["role"];
};

export type ManagedTelegramClaimView = {
  claimId: string;
  actorName?: string;
  actorHandle?: string;
  expiresAt: number;
  linked: boolean;
};

export type ManagedTelegramClaimViewResult =
  | {
      ok: true;
      claim: ManagedTelegramClaimView;
      installations: ManagedTelegramLinkableInstallation[];
    }
  | { ok: false; reason: "invalid" | "expired" | "used" };

export type ManagedTelegramLinkResult = {
  state: "active";
  claimId: string;
  actorId: string;
  installation: ManagedTelegramLinkableInstallation;
};

export class ManagedTelegramControlUnavailableError extends Error {}

export class ManagedTelegramClaimRejectedError extends Error {
  constructor(readonly reason: "invalid" | "expired" | "used") {
    super(`Managed Telegram claim is ${reason}`);
  }
}

export class ManagedTelegramLinkService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly operations: ManagedTelegramLinkOperationStore,
    private readonly auth: TelegramLinkAuth,
    private readonly telegram: ManagedTelegramControlInterface,
    private readonly gateway: ManagedGatewayTelegramInterface,
  ) {}

  async inspect(input: {
    sessionToken: string;
    claimToken: string;
  }): Promise<ManagedTelegramClaimViewResult> {
    const session = await this.auth.authenticateSession(input.sessionToken);
    if (!session) throw new Error("authentication required");
    const inspection = await this.inspectRemoteClaim(
      parseClaimToken(input.claimToken),
    );
    if (!inspection.ok) return inspection;
    const memberships = await this.accounts.listActiveInstallationMemberships(
      session.principal.id,
    );
    return {
      ok: true,
      claim: claimView(inspection.claim),
      installations: memberships.map(membershipView),
    };
  }

  async confirm(input: {
    sessionToken: string;
    claimToken: string;
    installationId: string;
    idempotencyKey: string;
  }): Promise<ManagedTelegramLinkResult> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const claimToken = parseClaimToken(input.claimToken);
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const claimTokenHash = await sha256Hex(
      `gsv-managed-telegram-claim:${claimToken}`,
    );
    const operationHash = await sha256Hex(
      `gsv-managed-telegram-link:${session.principal.id}:${idempotencyKey}`,
    );
    let operation = await this.operations.findByTokenHash(claimTokenHash);
    const membership = await this.requireMembership(
      session.principal.id,
      installationId,
    );

    if (operation) {
      assertResumableOperation(operation, session.principal.id, membership);
    } else {
      const inspection = await this.inspectRemoteClaim(claimToken);
      if (!inspection.ok) {
        throw new ManagedTelegramClaimRejectedError(inspection.reason);
      }
      operation = await this.operations.begin({
        operationId: `telegram_${operationHash}`,
        claimTokenHash,
        principalId: session.principal.id,
        claim: inspection.claim,
        target: membership,
      });
    }

    if (operation.state !== "complete") {
      await this.operations.recordAttempt(operation.operationId);
      operation = await this.resume(operation, claimToken);
    }
    return {
      state: "active",
      claimId: operation.claimId,
      actorId: operation.actorId,
      installation: membershipView(operation.target),
    };
  }

  private async resume(
    initial: ManagedTelegramLinkOperation,
    claimToken: string,
  ): Promise<ManagedTelegramLinkOperation> {
    let operation = initial;
    if (operation.state === "created") {
      let suspended;
      try {
        suspended = await this.telegram.suspendManagedTelegramClaim({
          operationId: operation.operationId,
          claimToken,
        });
      } catch {
        await this.operations.recordFailure(
          operation.operationId,
          "telegram_unavailable",
        );
        throw new ManagedTelegramControlUnavailableError(
          "Managed Telegram linking is temporarily unavailable",
        );
      }
      assertClaimMatchesOperation(suspended.claim, operation);
      operation = await this.operations.recordRouteSuspended(
        operation.operationId,
        suspended.previousRoute,
      );
    }

    if (operation.state === "route_suspended") {
      if (operation.previousRoute) {
        try {
          const result = await this.gateway.unlinkManagedTelegramActor({
            operationId: `${operation.operationId}:unlink`,
            installationId: operation.previousRoute.installationId,
            actorId: operation.actorId,
            surfaceId: operation.surfaceId,
            expectedLocalUid: operation.previousRoute.localUid,
          });
          if (
            result.installationId !== operation.previousRoute.installationId
            || result.actorId !== operation.actorId
            || result.surfaceId !== operation.surfaceId
            || result.localUid !== operation.previousRoute.localUid
          ) {
            throw new Error("Gateway returned a mismatched Telegram unlink result");
          }
        } catch {
          await this.operations.recordFailure(
            operation.operationId,
            "gateway_unavailable",
          );
          throw new ManagedTelegramControlUnavailableError(
            "Managed Telegram linking is temporarily unavailable",
          );
        }
      }
      operation = await this.operations.recordOldKernelUnlinked(
        operation.operationId,
      );
    }

    if (operation.state === "old_kernel_unlinked") {
      const membership = await this.accounts.getActiveInstallationMembership(
        operation.principalId,
        operation.target.installationId,
      );
      if (
        !membership
        || membership.localUid !== operation.target.localUid
        || membership.canonicalOrigin !== operation.target.canonicalOrigin
      ) {
        await this.operations.recordFailure(
          operation.operationId,
          "membership_unavailable",
        );
        throw new Error("installation membership is unavailable");
      }
      try {
        const result = await this.gateway.linkManagedTelegramActor({
          operationId: `${operation.operationId}:link`,
          installationId: operation.target.installationId,
          principalId: operation.principalId,
          localUid: operation.target.localUid,
          actorId: operation.actorId,
          surfaceId: operation.surfaceId,
        });
        if (
          result.installationId !== operation.target.installationId
          || result.actorId !== operation.actorId
          || result.surfaceId !== operation.surfaceId
          || result.localUid !== operation.target.localUid
        ) {
          throw new Error("Gateway returned a mismatched Telegram link result");
        }
      } catch {
        await this.operations.recordFailure(
          operation.operationId,
          "gateway_unavailable",
        );
        throw new ManagedTelegramControlUnavailableError(
          "Managed Telegram linking is temporarily unavailable",
        );
      }
      operation = await this.operations.recordNewKernelLinked(
        operation.operationId,
      );
    }

    if (operation.state === "new_kernel_linked") {
      try {
        const result = await this.telegram.activateManagedTelegramClaim({
          operationId: operation.operationId,
          claimToken,
          installationId: operation.target.installationId,
          localUid: operation.target.localUid,
          canonicalOrigin: operation.target.canonicalOrigin,
        });
        if (
          result.claimId !== operation.claimId
          || result.actorId !== operation.actorId
          || result.surfaceId !== operation.surfaceId
          || result.route.installationId !== operation.target.installationId
          || result.route.localUid !== operation.target.localUid
          || result.route.canonicalOrigin !== operation.target.canonicalOrigin
        ) {
          throw new Error("Telegram returned a mismatched route activation result");
        }
      } catch {
        await this.operations.recordFailure(
          operation.operationId,
          "telegram_unavailable",
        );
        throw new ManagedTelegramControlUnavailableError(
          "Managed Telegram linking is temporarily unavailable",
        );
      }
      operation = await this.operations.complete(operation.operationId);
    }
    return operation;
  }

  private async inspectRemoteClaim(
    claimToken: string,
  ): Promise<ManagedTelegramClaimInspection> {
    try {
      return await this.telegram.inspectManagedTelegramClaim(claimToken);
    } catch {
      throw new ManagedTelegramControlUnavailableError(
        "Managed Telegram linking is temporarily unavailable",
      );
    }
  }

  private async requireMembership(
    principalId: string,
    installationId: string,
  ): Promise<ActiveInstallationMembership> {
    const membership = await this.accounts.getActiveInstallationMembership(
      principalId,
      installationId,
    );
    if (!membership) throw new Error("installation membership is unavailable");
    return membership;
  }
}

function claimView(claim: ManagedTelegramClaim): ManagedTelegramClaimView {
  return {
    claimId: claim.claimId,
    ...(claim.actorName ? { actorName: claim.actorName } : {}),
    ...(claim.actorHandle ? { actorHandle: claim.actorHandle } : {}),
    expiresAt: claim.expiresAt,
    linked: claim.activeRoute !== undefined,
  };
}

function membershipView(
  membership: ActiveInstallationMembership,
): ManagedTelegramLinkableInstallation {
  return {
    installationId: membership.installationId,
    handle: membership.handle,
    canonicalOrigin: membership.canonicalOrigin,
    state: membership.state,
    role: membership.role,
  };
}

function assertResumableOperation(
  operation: ManagedTelegramLinkOperation,
  principalId: string,
  membership: ActiveInstallationMembership,
): void {
  if (
    operation.principalId !== principalId
    || operation.target.installationId !== membership.installationId
    || operation.target.localUid !== membership.localUid
    || operation.target.canonicalOrigin !== membership.canonicalOrigin
  ) {
    throw new Error("Managed Telegram claim is already owned by another link operation");
  }
}

function assertClaimMatchesOperation(
  claim: ManagedTelegramClaim,
  operation: ManagedTelegramLinkOperation,
): void {
  if (
    claim.claimId !== operation.claimId
    || claim.actorId !== operation.actorId
    || claim.surfaceId !== operation.surfaceId
  ) {
    throw new Error("Managed Telegram claim changed during linking");
  }
}

function parseIdempotencyKey(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("idempotencyKey is invalid");
  }
  return value.toLowerCase();
}

function parseClaimToken(value: string): string {
  if (!value || value.length > 512 || value !== value.trim()) {
    throw new ManagedTelegramClaimRejectedError("invalid");
  }
  return value;
}
