import { DurableObject } from "cloudflare:workers";
import type { ManagedAdapterGatewayService } from "../../../packages/gsv/src/protocol/managed.js";
import type {
  AdapterPairingActivateInput,
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingPrepareInput,
} from "./types";
import { requireSlackId } from "./slack-api";
import {
  managedSlackPeerObjectName,
  requireWorkspaceAccountId,
} from "./managed-identity";

export type ManagedSlackPairingRecord = {
  version: 1;
  claimId: string;
  accountId: string;
  actorId: string;
  expiresAt: number;
  operationId?: string;
  stage?: "prepared" | "active" | "finalized";
  retainUntil?: number;
  cleanup?: {
    operationId: string;
    accountId: string;
    actorId: string;
    surfaceId: string;
    installationId: string;
    localUid: number;
    generation: string;
  };
  cleanupComplete?: boolean;
};

export interface ManagedSlackPairingEnv {
  MANAGED_SLACK_PEER: DurableObjectNamespace;
  GATEWAY: Fetcher & ManagedAdapterGatewayService;
}

type ManagedSlackPeerStub = DurableObjectStub & {
  inspectPairing(claimId: string, expiresAt: number): Promise<AdapterPairingCandidate>;
  preparePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation>;
  activatePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation>;
  finalizePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation>;
  sendPairingConfirmation(operationId: string, canonicalOrigin: string): Promise<void>;
};

const RECORD_KEY = "managed_slack_pairing:v1";
const CLEANUP_RETRY_MS = 30_000;
const OPERATION_RECOVERY_MS = 24 * 60 * 60 * 1000;

export class ManagedSlackPairing extends DurableObject<ManagedSlackPairingEnv> {
  async initialize(input: ManagedSlackPairingRecord): Promise<{ created: boolean }> {
    const normalized = normalizeRecord(input);
    return await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<ManagedSlackPairingRecord>(RECORD_KEY);
      if (existing) {
        if (
          existing.claimId !== normalized.claimId
          || existing.accountId !== normalized.accountId
          || existing.actorId !== normalized.actorId
          || existing.expiresAt !== normalized.expiresAt
        ) {
          return { created: false };
        }
        return { created: true };
      }
      await txn.put(RECORD_KEY, normalized);
      await txn.setAlarm(normalized.expiresAt);
      return { created: true };
    });
  }

  async inspect(): Promise<AdapterPairingCandidate> {
    const record = await this.requireRecord();
    if (pairingDeadline(record) <= Date.now()) throw new Error("Pairing code expired");
    return await this.peer(record).inspectPairing(record.claimId, record.expiresAt);
  }

  async prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation> {
    const record = await this.requireRecord();
    assertOperation(record, input.operationId);
    const preparation = await this.peer(record).preparePairing(
      record.claimId,
      record.expiresAt,
      input,
    );
    await this.persistOperation(record, input.operationId, "prepared");
    return preparation;
  }

  async activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    const record = await this.requireRecord();
    assertOperation(record, input.operationId);
    const preparation = await this.peer(record).activatePairing(
      record.claimId,
      record.expiresAt,
      input,
    );
    await this.persistOperation(record, input.operationId, "active");
    return preparation;
  }

  async finalize(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    const record = await this.requireRecord();
    assertOperation(record, input.operationId);
    const peer = this.peer(record);
    const preparation = await peer.finalizePairing(
      record.claimId,
      record.expiresAt,
      input,
    );
    const previous = preparation.previousRoute;
    const cleanup = previous && previous.generation !== preparation.route.generation
      ? {
          operationId: input.operationId,
          accountId: preparation.candidate.accountId,
          actorId: preparation.candidate.actorId,
          surfaceId: preparation.candidate.surfaceId,
          installationId: previous.installationId,
          localUid: previous.localUid,
          generation: previous.generation,
        }
      : undefined;
    const next: ManagedSlackPairingRecord = {
      ...record,
      operationId: input.operationId,
      stage: "finalized",
      retainUntil: operationRetentionDeadline(record),
      cleanupComplete: cleanup ? false : true,
    };
    if (cleanup) next.cleanup = cleanup;
    await this.ctx.storage.put(RECORD_KEY, next);
    this.ctx.waitUntil(Promise.all([
      peer.sendPairingConfirmation(input.operationId, input.canonicalOrigin)
        .catch(() => undefined),
      this.completeCleanup(),
    ]).then(() => undefined));
    return preparation;
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<ManagedSlackPairingRecord>(RECORD_KEY);
    if (!record) return;
    if (record.cleanup && !record.cleanupComplete) {
      await this.completeCleanup();
      return;
    }
    if (pairingDeadline(record) <= Date.now()) await this.ctx.storage.deleteAll();
  }

  private async completeCleanup(): Promise<void> {
    const record = await this.ctx.storage.get<ManagedSlackPairingRecord>(RECORD_KEY);
    if (!record?.cleanup || record.cleanupComplete) return;
    try {
      await this.env.GATEWAY.unlinkManagedAdapterIdentity({
        installationId: record.cleanup.installationId,
      }, {
        operationId: `${record.cleanup.operationId}:previous`,
        accountId: record.cleanup.accountId,
        actorId: record.cleanup.actorId,
        surfaceId: record.cleanup.surfaceId,
        expectedLocalUid: record.cleanup.localUid,
        expectedGeneration: record.cleanup.generation,
      });
      await this.ctx.storage.put(RECORD_KEY, {
        ...record,
        cleanupComplete: true,
      } satisfies ManagedSlackPairingRecord);
      await this.ctx.storage.setAlarm(Math.max(pairingDeadline(record), Date.now() + 1));
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  private async requireRecord(): Promise<ManagedSlackPairingRecord> {
    const record = await this.ctx.storage.get<ManagedSlackPairingRecord>(RECORD_KEY);
    if (!record) throw new Error("Pairing code is invalid");
    return normalizeRecord(record);
  }

  private async persistOperation(
    record: ManagedSlackPairingRecord,
    operationId: string,
    stage: NonNullable<ManagedSlackPairingRecord["stage"]>,
  ): Promise<void> {
    const next = {
      ...record,
      operationId,
      stage,
      retainUntil: operationRetentionDeadline(record),
    } satisfies ManagedSlackPairingRecord;
    await this.ctx.storage.put(RECORD_KEY, next);
    await this.ctx.storage.setAlarm(next.retainUntil);
  }

  private peer(record: ManagedSlackPairingRecord): ManagedSlackPeerStub {
    const id = this.env.MANAGED_SLACK_PEER.idFromName(
      managedSlackPeerObjectName(record.accountId, record.actorId),
    );
    return typedStub<ManagedSlackPeerStub>(this.env.MANAGED_SLACK_PEER.get(id));
  }
}

function typedStub<T>(value: DurableObjectStub): T & DurableObjectStub {
  // SAFETY: the managed peer namespace is owned by this worker and exposes the pairing RPCs.
  return value as T & DurableObjectStub;
}

function normalizeRecord(input: ManagedSlackPairingRecord): ManagedSlackPairingRecord {
  if (input.version !== 1 || !input.claimId || input.claimId.length > 200) {
    throw new Error("Slack pairing record is invalid");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("Slack pairing record is invalid");
  }
  return {
    ...input,
    accountId: requireWorkspaceAccountId(input.accountId),
    actorId: requireSlackId(input.actorId, "Slack actor"),
  };
}

function assertOperation(record: ManagedSlackPairingRecord, operationId: string): void {
  if (record.operationId && record.operationId !== operationId) {
    throw new Error("Pairing code is owned by another operation");
  }
}

function operationRetentionDeadline(record: ManagedSlackPairingRecord): number {
  return record.retainUntil ?? Math.max(record.expiresAt, Date.now() + OPERATION_RECOVERY_MS);
}

function pairingDeadline(record: ManagedSlackPairingRecord): number {
  return record.operationId ? operationRetentionDeadline(record) : record.expiresAt;
}
