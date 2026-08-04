import type {
  ManagedGatewayDataLifecycleInterface,
  ManagedInferenceDataLifecycleInterface,
  ManagedTelegramDataLifecycleInterface,
  ManagedTelegramInstallationRouteLifecycleInput,
} from "@humansandmachines/gsv/protocol";
import type { PlatformAuthService } from "../auth/service";
import { parseOpaqueId } from "../domain";
import { sha256Hex } from "../security/tokens";
import { ManagedTelegramLinkOperationStore } from "../telegram/store";
import {
  InstallationLifecycleStore,
  type InstallationDeletionOperation,
} from "./store";

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_USER_DELETION_RECOVERY_MS = 7 * 24 * 60 * 60_000;

export type InstallationDeletionView = Pick<
  InstallationDeletionOperation,
  | "operationId"
  | "installationId"
  | "requestKind"
  | "state"
  | "recoverableUntil"
  | "createdAt"
  | "completedAt"
>;

export class InstallationLifecycleUnavailableError extends Error {}

export class InstallationLifecycleService {
  constructor(
    private readonly lifecycle: InstallationLifecycleStore,
    private readonly auth: Pick<
      PlatformAuthService,
      "authenticateSession" | "requireRecentPasskeySession"
    >,
    private readonly gateway: ManagedGatewayDataLifecycleInterface,
    private readonly inference: ManagedInferenceDataLifecycleInterface,
    private readonly telegram: ManagedTelegramDataLifecycleInterface,
    private readonly telegramOperations: ManagedTelegramLinkOperationStore,
    private readonly userDeletionRecoveryMs = DEFAULT_USER_DELETION_RECOVERY_MS,
  ) {}

  async requestUserDeletion(input: {
    sessionToken: string;
    installationId: string;
    confirmedHandle: string;
    idempotencyKey: string;
    now?: number;
  }): Promise<InstallationDeletionView> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const operationHash = await sha256Hex(
      `gsv-installation-deletion:${session.principal.id}:${installationId}:${idempotencyKey}`,
    );
    const operationId = `deletion_${operationHash}`;
    const existing = await this.lifecycle.get(operationId);
    const now = input.now ?? Date.now();
    const operation = await this.lifecycle.beginUserDeletion({
      operationId,
      principalId: session.principal.id,
      installationId,
      confirmedHandle: input.confirmedHandle,
      recoverableUntil: existing?.recoverableUntil
        ?? now + this.userDeletionRecoveryMs,
      now,
    });
    await this.resumePreparation(operation).catch(async () => {
      await this.lifecycle.recordFailure(operation.operationId, "preparation_unavailable");
    });
    return deletionView((await this.lifecycle.get(operationId)) ?? operation);
  }

  async get(input: {
    sessionToken: string;
    installationId: string;
  }): Promise<InstallationDeletionView | null> {
    const session = await this.auth.authenticateSession(input.sessionToken);
    if (!session) throw new Error("authentication required");
    const operation = await this.lifecycle.getActiveForInstallation(input.installationId);
    if (!operation || operation.requestedByPrincipalId !== session.principal.id) {
      return null;
    }
    return deletionView(operation);
  }

  async recoverUserDeletion(input: {
    sessionToken: string;
    installationId: string;
    now?: number;
  }): Promise<InstallationDeletionView> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const operation = await this.lifecycle.getActiveForInstallation(input.installationId);
    const now = input.now ?? Date.now();
    if (
      !operation
      || operation.requestKind !== "user"
      || operation.requestedByPrincipalId !== session.principal.id
    ) {
      throw new Error("installation deletion is unavailable");
    }
    if (operation.state === "deleting" || operation.recoverableUntil <= now) {
      throw new Error("installation deletion is no longer recoverable");
    }

    const peers = await this.telegramPeers(operation.installationId, operation.operationId);
    try {
      await this.inference.recoverManagedInferenceInstallation({
        installationId: operation.installationId,
        operationId: operation.operationId,
      });
      for (const peer of peers) {
        await this.telegram.recoverManagedTelegramInstallationRoute(peer);
      }
      await this.gateway.recoverManagedInstallation({
        installationId: operation.installationId,
        operationId: operation.operationId,
      });
      return deletionView(await this.lifecycle.recover(
        operation.operationId,
        session.principal.id,
        now,
      ));
    } catch {
      await this.compensateRecovery(operation, peers).catch(() => undefined);
      await this.lifecycle.recordFailure(operation.operationId, "recovery_unavailable");
      throw new InstallationLifecycleUnavailableError(
        "installation deletion recovery is temporarily unavailable",
      );
    }
  }

  async advanceActionable(now = Date.now()): Promise<number> {
    const operations = await this.lifecycle.listActionable(now);
    for (const candidate of operations) {
      await this.lifecycle.recordAttempt(candidate.operationId, now);
      let operation = (await this.lifecycle.get(candidate.operationId)) ?? candidate;
      try {
        if (operation.recoverableUntil <= now) {
          await this.lifecycle.advanceDue(operation.operationId, now);
          operation = (await this.lifecycle.get(operation.operationId)) ?? operation;
        } else if (operation.state === "preparing") {
          operation = await this.resumePreparation(operation);
        }
        if (operation.state === "deleting") {
          await this.resumeTeardown(operation, now);
        }
      } catch {
        await this.lifecycle.recordFailure(operation.operationId, "lifecycle_unavailable", now);
      }
    }
    return operations.length;
  }

  async startRetentionDeletion(input: {
    installationId: string;
    retentionEndsAt: number;
    now?: number;
  }): Promise<InstallationDeletionView> {
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const operationHash = await sha256Hex(
      `gsv-retention-deletion:${installationId}:${input.retentionEndsAt}`,
    );
    const operation = await this.lifecycle.beginRetentionDeletion({
      operationId: `deletion_${operationHash}`,
      installationId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return deletionView(operation);
  }

  private async resumePreparation(
    initial: InstallationDeletionOperation,
  ): Promise<InstallationDeletionOperation> {
    let operation = initial;
    const input = {
      installationId: operation.installationId,
      operationId: operation.operationId,
      recoverableUntil: operation.recoverableUntil,
    };
    if (!operation.inferenceSuspended) {
      await this.inference.suspendManagedInferenceInstallation(input);
      operation = await this.lifecycle.markPreparationComponent(
        operation.operationId,
        "inference",
      );
    }
    if (!operation.telegramSuspended) {
      for (const peer of await this.telegramPeers(
        operation.installationId,
        operation.operationId,
      )) {
        await this.telegram.suspendManagedTelegramInstallationRoute(peer);
      }
      operation = await this.lifecycle.markPreparationComponent(
        operation.operationId,
        "telegram",
      );
    }
    if (!operation.gatewayPrepared) {
      const prepared = await this.gateway.prepareManagedInstallationDeletion(input);
      if (
        prepared.installationId !== operation.installationId
        || prepared.operationId !== operation.operationId
        || prepared.recoverableUntil !== operation.recoverableUntil
      ) {
        throw new Error("Gateway returned mismatched deletion preparation state");
      }
      if (prepared.prepared) {
        operation = await this.lifecycle.markPreparationComponent(
          operation.operationId,
          "gateway",
        );
      }
    }
    return operation;
  }

  private async resumeTeardown(
    initial: InstallationDeletionOperation,
    now: number,
  ): Promise<void> {
    let operation = initial;
    if (!operation.telegramDeleted) {
      for (const peer of await this.telegramPeers(
        operation.installationId,
        operation.operationId,
      )) {
        await this.telegram.deleteManagedTelegramInstallationRoute(peer);
      }
      operation = await this.lifecycle.markDeletionComponent(
        operation.operationId,
        "telegram",
        now,
      );
    }
    if (!operation.inferenceDeleted) {
      await this.inference.deleteManagedInferenceInstallation({
        installationId: operation.installationId,
        operationId: operation.operationId,
      });
      operation = await this.lifecycle.markDeletionComponent(
        operation.operationId,
        "inference",
        now,
      );
    }
    if (!operation.gatewayDeleted) {
      const result = await this.gateway.deleteManagedInstallationResourceBatch({
        installationId: operation.installationId,
        operationId: operation.operationId,
        recoverableUntil: operation.recoverableUntil,
      });
      if (
        result.installationId !== operation.installationId
        || result.operationId !== operation.operationId
      ) {
        throw new Error("Gateway returned mismatched deletion state");
      }
      if (result.complete) {
        operation = await this.lifecycle.markDeletionComponent(
          operation.operationId,
          "gateway",
          now,
        );
      }
    }
    if (
      operation.gatewayDeleted
      && operation.inferenceDeleted
      && operation.telegramDeleted
    ) {
      await this.lifecycle.finalize(operation.operationId, now);
    }
  }

  private async compensateRecovery(
    operation: InstallationDeletionOperation,
    peers: ManagedTelegramInstallationRouteLifecycleInput[],
  ): Promise<void> {
    const input = {
      installationId: operation.installationId,
      operationId: operation.operationId,
      recoverableUntil: operation.recoverableUntil,
    };
    await Promise.allSettled([
      this.inference.suspendManagedInferenceInstallation(input),
      this.gateway.prepareManagedInstallationDeletion(input),
      ...peers.map((peer) => (
        this.telegram.suspendManagedTelegramInstallationRoute(peer)
      )),
    ]);
  }

  private async telegramPeers(
    installationId: string,
    operationId: string,
  ): Promise<ManagedTelegramInstallationRouteLifecycleInput[]> {
    return (await this.telegramOperations.listInstallationPeers(installationId)).map((peer) => ({
      installationId,
      operationId,
      ...peer,
    }));
  }
}

function deletionView(
  operation: InstallationDeletionOperation,
): InstallationDeletionView {
  return {
    operationId: operation.operationId,
    installationId: operation.installationId,
    requestKind: operation.requestKind,
    state: operation.state,
    recoverableUntil: operation.recoverableUntil,
    createdAt: operation.createdAt,
    completedAt: operation.completedAt,
  };
}

function parseIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("idempotencyKey is invalid");
  }
  return value.toLowerCase();
}
