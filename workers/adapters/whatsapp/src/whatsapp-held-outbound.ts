import { codePointLength } from "../../shared/src/paragraph-messages";
import {
  sameAdapterDataOwner,
  type AdapterDataOwner,
  type AdapterRetirement,
} from "../../shared/src/retirement";
import type { WhatsAppApprovalSource } from "./whatsapp-approval";

export const HELD_OUTBOUND_PREFIX = "managed_whatsapp_peer:v1:held:";
/** A held message waits this long for the person's reply before it is dropped. */
export const HELD_OUTBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Messages that may wait behind one template for one person. */
export const HELD_OUTBOUND_MAX_RECORDS = 64;
/**
 * Durable Object values are capped at 128 KiB. A reply this long in code
 * points stays under it in UTF-8 with room for the record around it.
 */
export const HELD_OUTBOUND_MAX_TEXT = 24_000;

export type HeldOutboundInput = {
  /** The Ship delivery id; a second hold of the same id is a no-op. */
  deliveryId: string;
  owner: AdapterDataOwner;
  markdown: string;
  replyToId?: string;
  /** Present when the held message is an approval prompt whose buttons must go out on release. */
  approval?: WhatsAppApprovalSource;
};

export type HeldOutboundRecord = HeldOutboundInput & {
  version: 1;
  sequence: number;
  heldAt: number;
  expiresAt: number;
};

export type HoldOutcome =
  | { held: true; record: HeldOutboundRecord }
  | { held: false; reason: "duplicate"; record: HeldOutboundRecord }
  | { held: false; reason: "full" | "too-long" };

type HeldOutboundOwnership = { installationIds: string[]; unattributed: number; ownedCount: number };

/**
 * Messages a person's WhatsApp number could not receive because Meta's
 * customer service window was closed. They wait, in order, for the reply that
 * reopens the window and are released through the ordinary free-form path.
 */
export class WhatsAppHeldOutbound {
  readonly prefix = HELD_OUTBOUND_PREFIX;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: {
      retirement?: AdapterRetirement;
      retentionMs?: number;
      maxRecords?: number;
      now?: () => number;
    } = {},
  ) {
    this.retentionMs = options.retentionMs ?? HELD_OUTBOUND_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? HELD_OUTBOUND_MAX_RECORDS;
    this.now = options.now ?? Date.now;
  }

  async hold(input: HeldOutboundInput): Promise<HoldOutcome> {
    if (codePointLength(input.markdown) > HELD_OUTBOUND_MAX_TEXT) return { held: false, reason: "too-long" };
    return await this.storage.transaction(async (txn) => {
      this.options.retirement?.requireLive(input.owner);
      const now = this.now();
      const records = await this.live(txn, now);
      const existing = records.find((record) => record.deliveryId === input.deliveryId);
      if (existing) return { held: false, reason: "duplicate", record: existing };
      if (records.length >= this.maxRecords) return { held: false, reason: "full" };
      const sequence = records.reduce((highest, record) => Math.max(highest, record.sequence), 0) + 1;
      const record: HeldOutboundRecord = {
        version: 1,
        deliveryId: input.deliveryId,
        owner: input.owner,
        markdown: input.markdown,
        sequence,
        heldAt: now,
        expiresAt: now + this.retentionMs,
      };
      if (input.replyToId) record.replyToId = input.replyToId;
      if (input.approval) record.approval = input.approval;
      await txn.put(this.key(input.deliveryId), record);
      return { held: true, record };
    });
  }

  /** Live held messages for one route, oldest first; expired ones are dropped on the way. */
  async list(owner: AdapterDataOwner): Promise<HeldOutboundRecord[]> {
    return await this.storage.transaction(async (txn) => {
      const records = await this.live(txn, this.now());
      return records
        .filter((record) => sameAdapterDataOwner(record.owner, owner))
        .sort((left, right) => left.sequence - right.sequence);
    });
  }

  async remove(deliveryId: string): Promise<void> {
    await this.storage.delete(this.key(deliveryId));
  }

  async inspectOwnership(installationId?: string): Promise<HeldOutboundOwnership> {
    const records = [...(await this.storage.list<HeldOutboundRecord>({ prefix: this.prefix })).values()];
    return {
      installationIds: [...new Set(records.map((record) => record.owner.installationId))],
      unattributed: 0,
      ownedCount: records.filter((record) => record.owner.installationId === installationId).length,
    };
  }

  async eraseInstallation(installationId: string, limit = 256): Promise<number> {
    return await this.storage.transaction(async (txn) => {
      const records = await txn.list<HeldOutboundRecord>({ prefix: this.prefix });
      const owned = [...records.entries()].filter(([, record]) => record.owner.installationId === installationId);
      const keys = owned.slice(0, limit).map(([key]) => key);
      if (keys.length) await txn.delete(keys);
      return owned.length - keys.length;
    });
  }

  private async live(txn: DurableObjectTransaction, now: number): Promise<HeldOutboundRecord[]> {
    const entries = await txn.list<HeldOutboundRecord>({ prefix: this.prefix });
    const expired = [...entries.entries()]
      .filter(([, record]) => !isHeldOutboundRecord(record) || record.expiresAt <= now)
      .map(([key]) => key);
    if (expired.length > 0) await txn.delete(expired);
    return [...entries.values()].filter((record) => isHeldOutboundRecord(record) && record.expiresAt > now);
  }

  private key(deliveryId: string): string {
    return `${this.prefix}${encodeURIComponent(deliveryId)}`;
  }
}

function isHeldOutboundRecord(value: HeldOutboundRecord | null | undefined): value is HeldOutboundRecord {
  if (!value) return false;
  // SAFETY: Durable Object storage data is parsed as the held record at this boundary.
  const record = value as Partial<HeldOutboundRecord>;
  return record.version === 1
    && isStringValue(record.deliveryId)
    && isStringValue(record.markdown)
    && isStringValue(record.owner?.installationId)
    && isStringValue(record.owner?.generation)
    && Number.isSafeInteger(record.sequence)
    && Number.isFinite(record.heldAt)
    && Number.isFinite(record.expiresAt);
}

function isStringValue(value: string | undefined): value is string {
  return value !== undefined && String(value) === value;
}
