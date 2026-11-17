import { AdapterRetirement, type AdapterDataOwner } from "./retirement";
import type { PairingOwnership } from "./pairing-retirement";
import type {
  AdapterPairingActivateInput, AdapterPairingCandidate, AdapterPairingPreparation, AdapterPairingPrepareInput,
} from "./types";
import type { AdapterGatewayService } from "../../../../packages/gsv/src/services/adapters.js";

type Stage = "prepared" | "active" | "finalized";
/** Who a Kernel-minted link code connects its sender to. */
export type AdapterPairingLinkOffer = { installationId: string; localUid: number; canonicalOrigin: string };
/** A minted code as the sender who claimed it may redeem it. */
export type AdapterPairingLinkBinding = AdapterPairingLinkOffer & { claimId: string; expiresAt: number };
export type AdapterPairingClaimState = PairingOwnership & {
  version: 1; claimId: string; expiresAt: number;
  /** The peer the code belongs to: the sender it was issued to, or the first sender of a minted link. */
  surfaceId?: string;
  /** Set when the Kernel minted the code into a link; the claim has no peer until a sender sends it. */
  link?: AdapterPairingLinkOffer;
  operationId?: string; stage?: Stage; retainUntil?: number;
  cleanup?: { operationId: string; accountId?: string; actorId: string; surfaceId: string; installationId: string; localUid: number; generation: string };
  cleanupComplete?: boolean;
};
export type AdapterPairingClaimRecord = AdapterPairingClaimState & { peerName: string };
export interface AdapterPairingPeer {
  inspectPairing(claimId: string, expiresAt: number): Promise<AdapterPairingCandidate>;
  preparePairing(claimId: string, expiresAt: number, input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation>;
  activatePairing(claimId: string, expiresAt: number, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  finalizePairing(claimId: string, expiresAt: number, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  sendPairingConfirmation(operationId: string, canonicalOrigin: string): Promise<void>;
}
const RETENTION_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30_000;
const STAGES = { prepared: 0, active: 1, finalized: 2 };

/** The claim reserves an operation; the peer remains the sole owner of route authority. */
export class AdapterPairingClaim<Record extends AdapterPairingClaimState = AdapterPairingClaimRecord> {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly key: string,
    private readonly peerName: (record: Record) => string,
    private readonly peer: (name: string) => AdapterPairingPeer,
    private readonly gateway: AdapterGatewayService,
    private readonly waitUntil: (task: Promise<void>) => void,
    private readonly retirement?: AdapterRetirement,
    private readonly legacyAccountId?: string,
  ) {}

  async initialize(input: Record): Promise<{ created: boolean }> {
    if (input.version !== 1 || !input.claimId || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
      throw new Error("Pairing claim is invalid");
    }
    return await this.storage.transaction(async (txn) => {
      const current = await txn.get<Record>(this.key);
      if (current) return { created: current.claimId === input.claimId && this.peerName(current) === this.peerName(input) && current.expiresAt === input.expiresAt };
      await txn.put(this.key, input);
      await txn.setAlarm(input.expiresAt);
      return { created: true };
    });
  }

  /** Keeps a code the Kernel minted until it expires; a code already in use is refused. */
  async offer(input: Record & { link: AdapterPairingLinkOffer }): Promise<void> {
    if (input.version !== 1 || !input.claimId || input.surfaceId !== undefined || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
      throw new Error("Pairing claim is invalid");
    }
    this.retirement?.requireLive(input.owner);
    await this.storage.transaction(async (txn) => {
      if (await txn.get<Record>(this.key)) throw new Error("Pairing code is in use");
      await txn.put(this.key, input);
      await txn.setAlarm(input.expiresAt);
    });
  }

  /**
   * Gives a minted code to the first sender who sends it, and to that sender again when they
   * retry. Null when the code is no live link or another sender has it.
   */
  async bind(surfaceId: string): Promise<AdapterPairingLinkBinding | null> {
    return await this.storage.transaction(async (txn) => {
      const record = await txn.get<Record>(this.key);
      if (!record?.link || record.retired || this.retirement?.retired(record.owner)) return null;
      if (record.surfaceId === undefined) {
        if (record.expiresAt <= Date.now()) return null;
        await txn.put(this.key, { ...record, surfaceId });
      } else if (record.surfaceId !== surfaceId) {
        return null;
      }
      return { ...record.link, claimId: record.claimId, expiresAt: record.expiresAt };
    });
  }

  async inspect(): Promise<AdapterPairingCandidate> {
    const record = await this.record();
    return await this.peer(this.peerName(record)).inspectPairing(record.claimId, record.expiresAt);
  }

  async prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation> {
    const record = await this.reserve(input.operationId, { installationId: input.installationId, generation: input.operationId });
    if (record.link && (record.link.installationId !== input.installationId || record.link.localUid !== input.localUid)) {
      throw new Error("Pairing operation identity changed");
    }
    const result = await this.peer(this.peerName(record)).preparePairing(record.claimId, record.expiresAt, input);
    await this.advance(record, "prepared");
    return result;
  }

  async activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    const record = await this.reserve(input.operationId, input.route);
    const result = await this.peer(this.peerName(record)).activatePairing(record.claimId, record.expiresAt, input);
    await this.advance(record, "active");
    return result;
  }

  async finalize(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    const record = await this.reserve(input.operationId, input.route);
    const peer = this.peer(this.peerName(record));
    const result = await peer.finalizePairing(record.claimId, record.expiresAt, input);
    const previous = result.previousRoute;
    const cleanup = previous && previous.generation !== result.route.generation ? {
      ...previous, operationId: input.operationId, accountId: result.candidate.accountId,
      actorId: result.candidate.actorId, surfaceId: result.candidate.surfaceId,
    } : undefined;
    await this.advance(record, "finalized", cleanup);
    this.waitUntil(Promise.all([
      this.completeCleanup(),
      peer.sendPairingConfirmation(input.operationId, input.canonicalOrigin).catch(() => undefined),
    ]).then(() => undefined));
    return result;
  }

  async alarm(): Promise<void> {
    const record = await this.storage.get<Record>(this.key);
    if (!record) return;
    if (record.cleanup && !record.cleanupComplete) { await this.completeCleanup(); return; }
    if ((record.retainUntil ?? record.expiresAt) <= Date.now()) await this.storage.delete(this.key);
  }

  private async record(): Promise<Record> {
    const record = await this.storage.get<Record>(this.key);
    if (!record || record.retired || this.retirement?.retired(record.owner) || unclaimedLink(record)) throw new Error("Pairing code is invalid");
    if ((record.retainUntil ?? record.expiresAt) <= Date.now()) throw new Error("Pairing code expired");
    return record;
  }

  private async reserve(operationId: string, owner: AdapterDataOwner): Promise<Record> {
    if (!operationId.trim()) throw new Error("Pairing operation is invalid");
    return await this.storage.transaction(async (txn) => {
      const record = await txn.get<Record>(this.key);
      this.retirement?.requireLive(owner);
      if (!record || record.retired || (record.retainUntil ?? record.expiresAt) <= Date.now()) throw new Error("Pairing code expired");
      if (unclaimedLink(record)) throw new Error("Pairing code is invalid");
      if (record.owner && record.owner.installationId !== owner.installationId) throw new Error("Pairing operation identity changed");
      if (record.operationId && record.operationId !== operationId) throw new Error("Pairing code is owned by another operation");
      const next = { ...record, owner, operationId, retainUntil: record.retainUntil ?? Date.now() + RETENTION_MS };
      await txn.put(this.key, next);
      await txn.setAlarm(next.retainUntil);
      return next;
    });
  }

  private async advance(record: Record, stage: Stage, cleanup?: AdapterPairingClaimState["cleanup"]): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const current = await txn.get<Record>(this.key);
      if (!current || current.retired || this.retirement?.retired(current.owner) || current.claimId !== record.claimId || current.operationId !== record.operationId) throw new Error("Pairing claim changed");
      if (current.stage && STAGES[current.stage] >= STAGES[stage]) return;
      const next = { ...current, stage };
      if (stage === "finalized") { next.cleanup = cleanup; next.cleanupComplete = !cleanup; }
      await txn.put(this.key, next);
      if (cleanup) await txn.setAlarm(Date.now() + RETRY_MS);
    });
  }

  private async completeCleanup(): Promise<void> {
    const record = await this.storage.get<Record>(this.key);
    if (!record?.cleanup || record.cleanupComplete || this.retirement?.retired(record.cleanup)) return;
    await this.storage.setAlarm(Date.now() + RETRY_MS);
    const cleanup = record.cleanup;
    if (!cleanup.accountId && !this.legacyAccountId) throw new Error("Pairing cleanup account is unavailable");
    const release = this.retirement?.start(cleanup);
    try {
      await this.gateway.unlinkAdapterIdentity({ installationId: cleanup.installationId }, {
        operationId: `${cleanup.operationId}:previous`, accountId: cleanup.accountId ?? this.legacyAccountId!, actorId: cleanup.actorId,
        surfaceId: cleanup.surfaceId, expectedLocalUid: cleanup.localUid, expectedGeneration: cleanup.generation,
      });
      await this.storage.transaction(async (txn) => {
        const current = await txn.get<Record>(this.key);
        if (!current || this.retirement?.retired(current.owner) || current.claimId !== record.claimId || current.operationId !== record.operationId || current.cleanup?.installationId !== cleanup.installationId) return;
        await txn.put(this.key, { ...current, cleanupComplete: true });
        await txn.setAlarm(Math.max(Date.now() + 1, current.retainUntil ?? current.expiresAt));
      });
    } catch { /* The durable alarm owns retry after transport failure. */ }
    finally { release?.(); }
  }
}

/** A minted code nobody has sent yet names no peer, so no route can be prepared from it. */
function unclaimedLink(record: AdapterPairingClaimState): boolean {
  return record.link !== undefined && record.surfaceId === undefined;
}
