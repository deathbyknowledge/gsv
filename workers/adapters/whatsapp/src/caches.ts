import {
  proto,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { normalizeWhatsAppJid } from "./identity";

const MESSAGE_PREFIX = "recent_message:v1:";
const MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_MESSAGES = 256;
const STORAGE_BATCH_SIZE = 128;

type RecentMessageRecord = {
  storedAt: number;
  expiresAt: number;
  encoded: Uint8Array;
};

export class RecentWhatsAppMessageStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const record = await this.storage.get<RecentMessageRecord>(recordKey(key));
    if (!record || record.expiresAt <= Date.now()) return undefined;
    try {
      return proto.WebMessageInfo.decode(record.encoded).message ?? undefined;
    } catch {
      return undefined;
    }
  }

  async put(message: WAMessage): Promise<void> {
    if (!message.key.id) return;
    const now = Date.now();
    const key = recordKey(message.key);
    const record: RecentMessageRecord = {
      storedAt: now,
      expiresAt: now + MESSAGE_RETENTION_MS,
      encoded: proto.WebMessageInfo.encode(message).finish(),
    };

    await this.storage.transaction(async (txn) => {
      await txn.put(key, record);
      const records = await txn.list<RecentMessageRecord>({ prefix: MESSAGE_PREFIX });
      const retained = [...records.entries()]
        .filter(([, value]) => value.expiresAt > now)
        .sort(([, left], [, right]) =>
          left.storedAt - right.storedAt
        );
      const remove = new Set(
        [...records.entries()]
          .filter(([, value]) => value.expiresAt <= now)
          .map(([recordKey]) => recordKey),
      );
      const overflow = Math.max(0, retained.length - MAX_RECENT_MESSAGES);
      for (const [recordKey] of retained.slice(0, overflow)) {
        remove.add(recordKey);
      }
      const keys = [...remove];
      for (let index = 0; index < keys.length; index += STORAGE_BATCH_SIZE) {
        await txn.delete(keys.slice(index, index + STORAGE_BATCH_SIZE));
      }
    });
  }

  async clear(): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const records = await txn.list({ prefix: MESSAGE_PREFIX });
      const keys = [...records.keys()];
      for (let index = 0; index < keys.length; index += STORAGE_BATCH_SIZE) {
        await txn.delete(keys.slice(index, index + STORAGE_BATCH_SIZE));
      }
    });
  }
}

export class GroupMetadataCache {
  private readonly entries = new Map<
    string,
    { value: GroupMetadata; expiresAt: number }
  >();

  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  get(jid: string): GroupMetadata | undefined {
    const entry = this.entries.get(jid);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(jid);
      return undefined;
    }
    this.entries.delete(jid);
    this.entries.set(jid, entry);
    return entry.value;
  }

  set(jid: string, value: GroupMetadata): void {
    this.entries.delete(jid);
    this.entries.set(jid, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      // SAFETY: Cache keys are strings and the iterator may be exhausted.
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

function recordKey(key: WAMessageKey): string {
  const identity = JSON.stringify({
    remoteJid: normalizeWhatsAppJid(key.remoteJid),
    participant: normalizeWhatsAppJid(key.participant),
    id: key.id ?? "",
    fromMe: key.fromMe === true,
  });
  return `${MESSAGE_PREFIX}${encodeURIComponent(identity)}`;
}
