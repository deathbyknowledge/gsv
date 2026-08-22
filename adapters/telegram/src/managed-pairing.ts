import { DurableObject } from "cloudflare:workers";
import type {
  AdapterPairingActivateInput,
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingPrepareInput,
} from "./types";
import type { ManagedTelegramGatewayService } from "../../../packages/gsv/src/protocol/managed.js";

export type ManagedTelegramPairingRecord = {
  version: 1;
  claimId: string;
  surfaceId: string;
  expiresAt: number;
  operationId?: string;
  stage?: "prepared" | "active" | "finalized";
  retainUntil?: number;
  cleanup?: {
    operationId: string;
    actorId: string;
    surfaceId: string;
    installationId: string;
    localUid: number;
    generation: string;
  };
  cleanupComplete?: boolean;
};

export interface ManagedTelegramPairingEnv {
  MANAGED_TELEGRAM_PEER: DurableObjectNamespace;
  GATEWAY: Fetcher & ManagedTelegramGatewayService;
}

type ManagedTelegramPeerStub = DurableObjectStub & {
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
  sendPairingConfirmation(
    operationId: string,
    canonicalOrigin: string,
  ): Promise<void>;
};

const RECORD_KEY = "managed_telegram_pairing:v1";
const CLEANUP_RETRY_MS = 30_000;
const OPERATION_RECOVERY_MS = 24 * 60 * 60 * 1000;

export class ManagedTelegramPairing extends DurableObject<ManagedTelegramPairingEnv> {
  async initialize(input: ManagedTelegramPairingRecord): Promise<{ created: boolean }> {
    return await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<ManagedTelegramPairingRecord>(RECORD_KEY);
      if (existing) {
        if (
          existing.claimId !== input.claimId
          || existing.surfaceId !== input.surfaceId
          || existing.expiresAt !== input.expiresAt
        ) {
          return { created: false };
        }
        return { created: true };
      }
      await txn.put(RECORD_KEY, input);
      await txn.setAlarm(input.expiresAt);
      return { created: true };
    });
  }

  async inspect(): Promise<AdapterPairingCandidate> {
    const record = await this.requireRecord();
    if (pairingDeadline(record) <= Date.now()) throw new Error("Pairing code expired");
    return await this.peer(record.surfaceId).inspectPairing(record.claimId, record.expiresAt);
  }

  async prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation> {
    const record = await this.requireRecord();
    assertOperation(record, input.operationId);
    const preparation = await this.peer(record.surfaceId).preparePairing(
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
    const preparation = await this.peer(record.surfaceId).activatePairing(
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
    const preparation = await this.peer(record.surfaceId).finalizePairing(
      record.claimId,
      record.expiresAt,
      input,
    );
    const previous = preparation.previousRoute;
    const cleanup = previous && previous.generation !== preparation.route.generation
      ? {
          operationId: input.operationId,
          actorId: preparation.candidate.actorId,
          surfaceId: preparation.candidate.surfaceId,
          installationId: previous.installationId,
          localUid: previous.localUid,
          generation: previous.generation,
        }
      : undefined;
    await this.ctx.storage.put(RECORD_KEY, {
      ...record,
      operationId: input.operationId,
      stage: "finalized",
      retainUntil: operationRetentionDeadline(record),
      ...(cleanup ? { cleanup, cleanupComplete: false } : { cleanupComplete: true }),
    } satisfies ManagedTelegramPairingRecord);
    this.ctx.waitUntil(Promise.all([
      this.peer(record.surfaceId).sendPairingConfirmation(
        input.operationId,
        input.canonicalOrigin,
      ).catch(() => undefined),
      this.completeCleanup(),
    ]).then(() => undefined));
    return preparation;
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<ManagedTelegramPairingRecord>(RECORD_KEY);
    if (!record) return;
    if (record.cleanup && !record.cleanupComplete) {
      await this.completeCleanup();
      return;
    }
    if (pairingDeadline(record) <= Date.now()) {
      await this.ctx.storage.deleteAll();
    }
  }

  private async completeCleanup(): Promise<void> {
    const record = await this.ctx.storage.get<ManagedTelegramPairingRecord>(RECORD_KEY);
    if (!record?.cleanup || record.cleanupComplete) return;
    try {
      await this.env.GATEWAY.unlinkManagedTelegramIdentity({
        installationId: record.cleanup.installationId,
        operationId: `${record.cleanup.operationId}:previous`,
        actorId: record.cleanup.actorId,
        surfaceId: record.cleanup.surfaceId,
        expectedLocalUid: record.cleanup.localUid,
        expectedGeneration: record.cleanup.generation,
      });
      await this.ctx.storage.put(RECORD_KEY, {
        ...record,
        cleanupComplete: true,
      } satisfies ManagedTelegramPairingRecord);
      await this.ctx.storage.setAlarm(Math.max(pairingDeadline(record), Date.now() + 1));
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  private async requireRecord(): Promise<ManagedTelegramPairingRecord> {
    const record = await this.ctx.storage.get<ManagedTelegramPairingRecord>(RECORD_KEY);
    if (!record) throw new Error("Pairing code is invalid");
    return record;
  }

  private async persistOperation(
    record: ManagedTelegramPairingRecord,
    operationId: string,
    stage: NonNullable<ManagedTelegramPairingRecord["stage"]>,
  ): Promise<void> {
    const next = {
      ...record,
      operationId,
      stage,
      retainUntil: operationRetentionDeadline(record),
    } satisfies ManagedTelegramPairingRecord;
    await this.ctx.storage.put(RECORD_KEY, next);
    await this.ctx.storage.setAlarm(next.retainUntil);
  }

  private peer(surfaceId: string): ManagedTelegramPeerStub {
    const id = this.env.MANAGED_TELEGRAM_PEER.idFromName(`managed:${surfaceId}`);
    // SAFETY: the managed peer namespace is owned by this worker and exposes the pairing RPCs.
    return this.env.MANAGED_TELEGRAM_PEER.get(id) as ManagedTelegramPeerStub;
  }
}

function assertOperation(record: ManagedTelegramPairingRecord, operationId: string): void {
  if (record.operationId && record.operationId !== operationId) {
    throw new Error("Pairing code is owned by another operation");
  }
}

function operationRetentionDeadline(record: ManagedTelegramPairingRecord): number {
  return record.retainUntil ?? Math.max(
    record.expiresAt,
    Date.now() + OPERATION_RECOVERY_MS,
  );
}

function pairingDeadline(record: ManagedTelegramPairingRecord): number {
  return record.operationId ? operationRetentionDeadline(record) : record.expiresAt;
}
