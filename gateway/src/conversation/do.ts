import { DurableObject } from "cloudflare:workers";
import type {
  ConversationKind,
  ConversationMessage,
  ProcMediaInput,
} from "@humansandmachines/gsv/protocol";
import { createInstallationStorage } from "../installation/storage";
import { parseConversationDurableObjectName } from "../installation/routing";
import {
  agentArchiveMediaPath,
  isValidAgentArchiveMediaObject,
  parseProcessMediaPath,
} from "../shared/process-media-path";
import { runConversationSqlMigrations } from "./schema/migrations";
import {
  ConversationStore,
  type ConversationAppendInput,
  type ConversationAppendResult,
  type ConversationArchiveSegment,
} from "./store";

const HOT_MESSAGE_LIMIT = 1_000;
const ARCHIVE_SEGMENT_SIZE = 500;
const MAX_HISTORY_LIMIT = 200;

export type ConversationInitializeInput = {
  ownerUid: number;
  kind: ConversationKind;
};

export type ConversationHistoryInput = {
  beforeSequence?: number;
  limit?: number;
};

export type ConversationMediaOwner = {
  pid: string;
  uid: number;
  gid: number;
  home: string;
};

export type ConversationAppendRequest = Omit<ConversationAppendInput, "payloadHash" | "media"> & {
  media?: ProcMediaInput[];
  mediaOwner?: ConversationMediaOwner;
};

export type ConversationMediaRead = {
  conversationId: string;
  key: string;
  mimeType: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
};

export class Conversation extends DurableObject<Env> {
  readonly installationId: string;
  readonly conversationId: string;
  private readonly store: ConversationStore;
  private readonly storage: R2Bucket;
  private archiveTransition: Promise<void> = Promise.resolve();
  private appendTransition: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const identity = parseConversationDurableObjectName(ctx.id.name);
    this.installationId = identity.installationId;
    this.conversationId = identity.conversationId;
    this.storage = createInstallationStorage(env.STORAGE, this.installationId);
    runConversationSqlMigrations(ctx.storage);
    this.store = new ConversationStore(ctx.storage.sql);
  }

  initialize(input: ConversationInitializeInput): void {
    requireOwnerUid(input.ownerUid);
    requireConversationKind(input.kind);
    this.store.initialize(this.conversationId, input.ownerUid, input.kind);
  }

  async append(input: ConversationAppendRequest): Promise<ConversationAppendResult> {
    requireAppendInput(input);
    return this.withAppendLock(async () => {
      const media = await this.persistMessageMedia(input);
      const { mediaOwner: _mediaOwner, ...messageInput } = input;
      const canonical = {
        ...messageInput,
        ...(media.length > 0 ? { media } : { media: undefined }),
      };
      const payloadHash = await hashAppendInput(canonical);
      const normalized: ConversationAppendInput = { ...canonical, payloadHash };
      const stored = this.ctx.storage.transactionSync(() => this.store.append(normalized));
      if (stored) {
        this.ctx.waitUntil(this.scheduleArchive());
        return stored;
      }
      const receipt = this.store.receipt(input.idempotencyKey);
      if (!receipt || receipt.messageId !== input.messageId || receipt.payloadHash !== payloadHash) {
        throw new Error("Conversation message idempotency receipt is invalid");
      }
      const segment = this.store.archiveSegmentsBefore(receipt.sequence + 1)
        .find((candidate) => (
          candidate.fromSequence <= receipt.sequence
          && candidate.toSequence >= receipt.sequence
        ));
      if (!segment) throw new Error("Archived conversation message is missing");
      const message = (await this.readArchive(segment))
        .find((candidate) => candidate.sequence === receipt.sequence);
      if (!message || message.id !== input.messageId) {
        throw new Error("Archived conversation receipt does not match its message");
      }
      return { message, created: false };
    });
  }

  async readMedia(input: { key: string }): Promise<ConversationMediaRead> {
    const key = normalizeConversationMediaKey(input?.key, this.conversationId);
    const object = await this.storage.get(key);
    if (!object || !isConversationMediaObject(object, this.conversationId)) {
      await object?.body.cancel("Conversation media is invalid").catch(() => undefined);
      throw new Error("Conversation media not found");
    }
    return {
      conversationId: this.conversationId,
      key,
      mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
      stream: object.body,
    };
  }

  async history(input: ConversationHistoryInput = {}): Promise<{
    messages: ConversationMessage[];
    hasMore: boolean;
    latestSequence: number;
  }> {
    const limit = normalizeLimit(input.limit);
    const latestSequence = this.store.latestSequence();
    const beforeSequence = normalizeBeforeSequence(input.beforeSequence, latestSequence + 1);
    const selected = new Map<number, ConversationMessage>();
    for (const message of this.store.listHot(beforeSequence, limit)) {
      selected.set(message.sequence, message);
    }
    if (selected.size < limit) {
      for (const segment of this.store.archiveSegmentsBefore(beforeSequence)) {
        const messages = await this.readArchive(segment);
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message.sequence < beforeSequence) {
            selected.set(message.sequence, message);
          }
          if (selected.size >= limit) break;
        }
        if (selected.size >= limit) break;
      }
    }
    const messages = [...selected.values()]
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit)
      .sort((left, right) => left.sequence - right.sequence);
    const firstSequence = messages[0]?.sequence ?? beforeSequence;
    return {
      messages,
      hasMore: messages.length > 0 && this.store.hasSequenceBefore(firstSequence),
      latestSequence,
    };
  }

  async compact(): Promise<void> {
    await this.scheduleArchive();
  }

  private scheduleArchive(): Promise<void> {
    const next = this.archiveTransition.then(() => this.archiveIfNeeded());
    this.archiveTransition = next.catch(() => undefined);
    return next;
  }

  private async withAppendLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.appendTransition;
    let release!: () => void;
    this.appendTransition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async archiveIfNeeded(): Promise<void> {
    while (this.store.hotCount() > HOT_MESSAGE_LIMIT) {
      const messages = this.store.oldestHot(ARCHIVE_SEGMENT_SIZE);
      if (messages.length === 0) return;
      const bytes = new TextEncoder().encode(JSON.stringify(messages));
      const checksum = await sha256(bytes);
      const fromSequence = messages[0].sequence;
      const toSequence = messages[messages.length - 1].sequence;
      const segmentId = `${fromSequence}-${toSequence}-${checksum.slice(0, 16)}`;
      const objectKey = `conversations/${encodeURIComponent(this.conversationId)}/segments/${segmentId}.json.gz`;
      const compressed = await gzip(bytes);
      await this.storage.put(objectKey, compressed, {
        httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
        customMetadata: { checksum },
      });
      const stored = await this.storage.head(objectKey);
      if (!stored || stored.customMetadata?.checksum !== checksum) {
        throw new Error("Conversation archive verification failed");
      }
      const segment: ConversationArchiveSegment = {
        segmentId,
        fromSequence,
        toSequence,
        messageCount: messages.length,
        objectKey,
        checksum,
        createdAt: Date.now(),
      };
      this.ctx.storage.transactionSync(() => this.store.commitArchive(segment, messages));
    }
  }

  private async persistMessageMedia(input: ConversationAppendRequest): Promise<ProcMediaInput[]> {
    const items = input.media ?? [];
    if (items.length === 0) return [];
    const owner = input.mediaOwner;
    if (!owner) throw new Error("Conversation media owner is required");
    requireMediaOwner(owner, input.processId);
    const persisted: ProcMediaInput[] = [];
    for (let index = 0; index < items.length; index += 1) {
      persisted.push(await this.persistMessageMediaItem(items[index], input.messageId, index, owner));
    }
    return persisted;
  }

  private async persistMessageMediaItem(
    item: ProcMediaInput,
    messageId: string,
    index: number,
    owner: ConversationMediaOwner,
  ): Promise<ProcMediaInput> {
    if (!item || typeof item !== "object") throw new Error("Conversation media is invalid");
    const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim() : "";
    if (!mimeType) throw new Error("Conversation media mimeType is required");
    const sourceKey = typeof item.key === "string" ? item.key.trim() : "";
    if (!sourceKey) {
      if (typeof item.url !== "string" || !item.url.trim()) {
        throw new Error("Conversation media requires a stored key or URL");
      }
      return { ...item, mimeType };
    }

    const key = conversationMediaKey(this.conversationId, messageId, index);
    const existing = await this.storage.get(key);
    if (existing) {
      const matches = isConversationMediaObject(existing, this.conversationId)
        && existing.customMetadata?.sourceKey === sourceKey
        && existing.httpMetadata?.contentType === mimeType;
      await existing.body.cancel("Conversation media already persisted").catch(() => undefined);
      if (!matches) throw new Error("Conversation media idempotency payload changed");
      return canonicalConversationMedia(item, this.conversationId, key, existing.size, mimeType);
    }

    const source = await this.storage.get(sourceKey);
    if (!source) throw new Error(`Conversation media source not found: ${sourceKey}`);
    const active = parseProcessMediaPath(`/${sourceKey}`);
    const activeOwned = active?.kind === "file"
      && active.pid === owner.pid
      && active.uid === owner.uid;
    const archiveOwned = agentArchiveMediaPath(owner.home, sourceKey) !== null
      && isValidAgentArchiveMediaObject({
        home: owner.home,
        key: sourceKey,
        uid: owner.uid,
        gid: owner.gid,
        object: source,
        expectedContentType: mimeType,
      });
    if ((!activeOwned && !archiveOwned) || source.httpMetadata?.contentType !== mimeType) {
      await source.body.cancel("Conversation media source ownership mismatch").catch(() => undefined);
      throw new Error("Conversation media source is outside the handling process");
    }
    const stored = await this.storage.put(key, source.body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        purpose: "conversation-media",
        conversationId: this.conversationId,
        messageId,
        sourceKey,
        sourceEtag: source.etag,
      },
    });
    return canonicalConversationMedia(item, this.conversationId, key, stored.size, mimeType);
  }

  private async readArchive(segment: ConversationArchiveSegment): Promise<ConversationMessage[]> {
    const object = await this.storage.get(segment.objectKey);
    if (!object) throw new Error("Conversation archive is missing");
    const bytes = new Uint8Array(await new Response(
      object.body.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer());
    if (await sha256(bytes) !== segment.checksum) {
      throw new Error("Conversation archive checksum does not match");
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== segment.messageCount) {
      throw new Error("Conversation archive payload is invalid");
    }
    return parsed as ConversationMessage[];
  }
}

function requireAppendInput(input: ConversationAppendRequest): void {
  if (!input || typeof input !== "object") throw new Error("Conversation message is required");
  requireNonempty(input.messageId, "messageId");
  requireNonempty(input.idempotencyKey, "idempotencyKey");
  if (typeof input.text !== "string") throw new Error("Conversation message text is invalid");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw new Error("Conversation message timestamp is invalid");
  }
  if (!input.author || typeof input.author !== "object") {
    throw new Error("Conversation message author is invalid");
  }
  if (!input.origin || typeof input.origin !== "object") {
    throw new Error("Conversation message origin is invalid");
  }
}

async function hashAppendInput(
  input: Omit<ConversationAppendInput, "payloadHash">,
): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify({
    messageId: input.messageId,
    author: input.author,
    text: input.text,
    media: input.media ?? [],
    origin: input.origin,
    processId: input.processId ?? null,
    runId: input.runId ?? null,
  })));
}

function requireMediaOwner(owner: ConversationMediaOwner, processId: string | undefined): void {
  requireNonempty(owner.pid, "mediaOwner.pid");
  if (processId !== owner.pid) throw new Error("Conversation media owner does not match processId");
  requireOwnerUid(owner.uid);
  requireOwnerUid(owner.gid);
  requireNonempty(owner.home, "mediaOwner.home");
}

function conversationMediaPrefix(conversationId: string): string {
  return `conversations/${encodeURIComponent(conversationId)}/media/`;
}

function conversationMediaKey(conversationId: string, messageId: string, index: number): string {
  return `${conversationMediaPrefix(conversationId)}${encodeURIComponent(messageId)}/${index}`;
}

function normalizeConversationMediaKey(value: unknown, conversationId: string): string {
  if (typeof value !== "string" || !value.startsWith(conversationMediaPrefix(conversationId))) {
    throw new Error("Conversation media key is invalid");
  }
  return value;
}

function isConversationMediaObject(
  object: Pick<R2Object, "customMetadata">,
  conversationId: string,
): boolean {
  return object.customMetadata?.purpose === "conversation-media"
    && object.customMetadata.conversationId === conversationId;
}

function canonicalConversationMedia(
  item: ProcMediaInput,
  conversationId: string,
  key: string,
  size: number,
  mimeType: string,
): ProcMediaInput {
  const { path: _path, url: _url, ...metadata } = item;
  return { ...metadata, mimeType, key, conversationId, size };
}

function requireNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
}

function requireOwnerUid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("ownerUid is invalid");
}

function requireConversationKind(value: ConversationKind): void {
  if (value !== "home" && value !== "work" && value !== "group") {
    throw new Error("Conversation kind is invalid");
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new Error(`Conversation history limit must be between 1 and ${MAX_HISTORY_LIMIT}`);
  }
  return value;
}

function normalizeBeforeSequence(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Conversation history cursor is invalid");
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
