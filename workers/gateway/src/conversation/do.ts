import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";
import { InstallationRetirement, durableResourceName, stateWithRetirementStorage, RESOURCE_IDENTITY_KEY, inspectResourceStorage, attachDurableResourceIdentity } from "../installation/retirement";
import { DurableObject } from "cloudflare:workers";
import type {
  ConversationKind,
  ConversationMessage,
  ResourceBlock,
  OriginMessageRef,
  ConversationSearchArgs,
  ConversationSearchResult,
} from "@humansandmachines/gsv/protocol";
import { resourceBlockSchema, socialMessageMetadataSchema, originMessageRefSchema } from "@humansandmachines/gsv/protocol";
import { createInstallationStorage } from "../installation/storage";
import { parseConversationDurableObjectName } from "../installation/routing";
import type { GatewayEnv } from "../runtime-env";
import {
  agentArchiveMediaPath,
  isValidAgentArchiveMediaObject,
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
  intakeId?: string;
};

type ConversationIntake = { id: string; ownerUid: number; promoted: boolean; discarded: boolean };
const INTAKE_KEY = "conversation:intake";

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
  media?: ResourceBlock[];
  mediaOwner?: ConversationMediaOwner;
  mediaAuthority?: { kind: "federation"; target: string };
};

export type ConversationMediaRead = {
  conversationId: string;
  key: string;
  mimeType: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
};

type ConversationInstallationRuntime = {
  retirement: InstallationRetirement;
  installationId: string;
  conversationId: string;
  store: ConversationStore;
  storage: R2Bucket;
};

export class Conversation extends DurableObject<GatewayEnv> {
  private readonly installationRuntime: ConversationInstallationRuntime | null;
  get retirement(): InstallationRetirement { return this.namedRuntime().retirement; }
  readonly ctx: DurableObjectState<{}>;
  get installationId(): string { return this.namedRuntime().installationId; }
  get conversationId(): string { return this.namedRuntime().conversationId; }
  private get store(): ConversationStore { return this.namedRuntime().store; }
  private get storage(): R2Bucket { return this.namedRuntime().storage; }
  private archiveTransition: Promise<void> = Promise.resolve();
  private appendTransition: Promise<void> = Promise.resolve();
  private searchTransition: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState<{}>, env: GatewayEnv) {
    super(state, env);
    this.ctx = state;
    if (!state.id.name && !state.storage.kv.get(RESOURCE_IDENTITY_KEY)) {
      this.installationRuntime = null;
      return;
    }
    const identity = parseConversationDurableObjectName(durableResourceName(state, env.CONVERSATION));
    const retirement = new InstallationRetirement(state.storage, identity.installationId);
    const ctx = stateWithRetirementStorage(state, retirement);
    this.ctx = ctx;
    if (!retirement.state) runConversationSqlMigrations(ctx.storage);
    this.installationRuntime = {
      ...identity, retirement,
      storage: createInstallationStorage(env.STORAGE, identity.installationId, retirement),
      store: new ConversationStore(ctx.storage.sql),
    };
  }

  async attachInstallationResourceIdentity(name: string): Promise<void> {
    parseConversationDurableObjectName(name);
    await attachDurableResourceIdentity(this.ctx, this.env.CONVERSATION, name);
  }

  inspectInstallationResource() {
    const storage = this.installationRuntime?.retirement.raw ?? this.ctx.storage;
    const hasMeta = storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_meta'").toArray().length > 0;
    const id = hasMeta ? storage.sql.exec<{ conversation_id: string }>("SELECT conversation_id FROM conversation_meta LIMIT 1").toArray()[0]?.conversation_id : undefined;
    return inspectResourceStorage(storage, id);
  }

  private namedRuntime(): ConversationInstallationRuntime {
    if (!this.installationRuntime) throw new Error("Historical resource identity requires operator discovery");
    return this.installationRuntime;
  }

  async quiesceInstallationResource(input: InstallationDeletionRequest) {
    const record = this.retirement.begin(input);
    if (record.phase !== "quiescing") return record;
    await Promise.allSettled([this.appendTransition, this.archiveTransition, this.searchTransition]);
    await this.retirement.drain();
    if (await this.retirement.abortMultipart(this.env.STORAGE)) return this.retirement.state!;
    return this.retirement.quiesced();
  }

  async eraseInstallationResource(input: InstallationDeletionRequest) {
    this.retirement.begin(input);
    return this.retirement.erase();
  }

  initialize(input: ConversationInitializeInput): void {
    this.assertAvailable();
    requireOwnerUid(input.ownerUid);
    requireConversationKind(input.kind);
    this.ctx.storage.transactionSync(() => {
      const existing = this.store.meta();
      this.store.initialize(this.conversationId, input.ownerUid, input.kind);
      const intake = this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY);
      if (!existing && input.intakeId) {
        if (input.kind !== "contact") throw new Error("Only a contact conversation can hold a message request");
        this.ctx.storage.kv.put(INTAKE_KEY, { id: input.intakeId, ownerUid: input.ownerUid, promoted: false, discarded: false });
      } else if (intake && !input.intakeId && !intake.promoted) {
        this.ctx.storage.kv.put(INTAKE_KEY, { ...intake, promoted: true });
      } else if (intake && input.intakeId && intake.id !== input.intakeId) {
        throw new Error("Conversation message request identity changed");
      }
    });
  }

  /** Only a never-accepted, single-message intake can be discarded. Keep its tombstone. */
  async discardIntake(input: { id: string; ownerUid: number }): Promise<void> {
    this.retirement.assertActive();
    const saved = this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY);
    const intake = saved ?? (!this.store.meta() ? { id: input.id, ownerUid: input.ownerUid, promoted: false, discarded: false } : null);
    if (!intake || intake.id !== input.id || intake.ownerUid !== input.ownerUid || intake.promoted) {
      throw new Error("Conversation is not an unaccepted message request");
    }
    if (this.store.latestSequence() > 1 || this.store.archiveSegmentsBefore(Number.MAX_SAFE_INTEGER, 1).length) {
      throw new Error("Message request conversation contains established history");
    }
    this.ctx.storage.kv.put(INTAKE_KEY, { ...intake, discarded: true });
    await Promise.allSettled([this.appendTransition, this.archiveTransition, this.searchTransition]);
    this.ctx.storage.transactionSync(() => {
      for (const table of ["messages", "message_receipts", "message_origins", "message_search", "message_search_state"]) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
    });
    await this.ctx.storage.deleteAlarm();
  }

  private assertAvailable(): void {
    this.retirement.assertActive();
    if (this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY)?.discarded) throw new Error("Message request history has expired");
  }

  async append(input: ConversationAppendRequest): Promise<ConversationAppendResult> {
    this.assertAvailable();
    requireAppendInput(input);
    return this.withAppendLock(async () => {
      const media = await this.validateMessageMedia(input);
      const {
        mediaOwner: _mediaOwner,
        mediaAuthority: _mediaAuthority,
        ...messageInput
      } = input;
      const canonical = {
        ...messageInput,
        ...(media.length > 0 ? { media } : { media: undefined }),
      };
      const payloadHash = await hashAppendInput(canonical);
      const normalized: ConversationAppendInput = { ...canonical, payloadHash };
      this.assertAvailable();
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

  resolveOrigin(reference: OriginMessageRef, threadId: string) {
    this.assertAvailable();
    return this.store.resolveOrigin(originMessageRefSchema.parse(reference), threadId);
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
    this.assertAvailable();
    await this.scheduleArchive();
  }

  async search(input: Omit<ConversationSearchArgs, "conversationId">): Promise<ConversationSearchResult> {
    this.assertAvailable();
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Conversation search limit must be between 1 and 50");
    const latest = this.store.latestSequence();
    const before = normalizeBeforeSequence(input.beforeSequence, latest + 1);
    const result = this.store.search.search(input.query, before, limit);
    if (this.store.search.needsBackfill() && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
    return { conversationId: this.conversationId, ...result, coverage: this.store.search.coverage(latest) };
  }

  async alarm(): Promise<void> {
    if (this.retirement.state || this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY)?.discarded) return;
    this.searchTransition = this.backfillSearch();
    await this.searchTransition;
  }

  private async backfillSearch(): Promise<void> {
    if (!this.store.search.needsBackfill()) return;
    try {
      const before = this.store.search.state().backfill_before;
      let messages = this.store.listHot(before, 100);
      if (!messages.length) {
        const segment = this.store.archiveSegmentsBefore(before, 1)[0];
        if (segment) messages = (await this.readArchive(segment))
          .filter((message) => message.sequence < before).slice(-100).reverse();
      }
      this.assertAvailable();
      this.ctx.storage.transactionSync(() => {
        for (const message of messages) this.store.search.index(message);
        this.store.search.finishBatch(messages.length ? Math.min(...messages.map((message) => message.sequence)) : 1);
      });
      if (this.store.search.needsBackfill()) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } catch (error) {
      if (!this.retirement.state && !this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY)?.discarded) this.store.search.failBackfill();
      throw error;
    }
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
      this.assertAvailable();
      return await operation();
    } finally {
      release();
    }
  }

  private async archiveIfNeeded(): Promise<void> {
    if (this.retirement.state || this.ctx.storage.kv.get<ConversationIntake>(INTAKE_KEY)?.discarded) return;
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

  private async validateMessageMedia(input: ConversationAppendRequest): Promise<ResourceBlock[]> {
    const items = input.media ?? [];
    if (items.length === 0) return [];
    if (input.mediaAuthority?.kind === "federation") {
      return items.map((item) => validateFederationResource(
        item,
        input.mediaAuthority!.target,
      ));
    }
    const owner = input.mediaOwner;
    if (!owner) throw new Error("Conversation media owner is required");
    requireMediaOwner(owner, input.processId);
    const persisted: ResourceBlock[] = [];
    for (const item of items) {
      persisted.push(await this.validateMessageResource(item, owner));
    }
    return persisted;
  }

  private async validateMessageResource(
    input: ResourceBlock,
    owner: ConversationMediaOwner,
  ): Promise<ResourceBlock> {
    const resource = resourceBlockSchema.parse(input);
    const { ref } = resource;
    const key = ref.path.replace(/^\/+/, "");
    if (
      ref.target !== "gsv"
      || ref.expiresAt !== undefined
      || agentArchiveMediaPath(owner.home, key) !== ref.path
    ) {
      throw new Error("Conversation resource is outside the handling process");
    }
    const object = await this.storage.head(key);
    if (
      !object
      || object.httpEtag !== ref.revision
      || object.size !== ref.size
      || !isValidAgentArchiveMediaObject({
        home: owner.home,
        key,
        uid: owner.uid,
        gid: owner.gid,
        object,
        expectedContentType: ref.contentType,
      })
    ) {
      throw new Error("Conversation resource does not match retained data");
    }
    return resource;
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
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== segment.messageCount) {
      throw new Error("Conversation archive payload is invalid");
    }
    // SAFETY: archive rows are written from ConversationMessage values and the count was verified above.
    return parsed as ConversationMessage[];
  }
}

function validateFederationResource(input: ResourceBlock, target: string): ResourceBlock {
  const resource = resourceBlockSchema.parse(input);
  if (
    resource.ref.target !== target
    || !resource.ref.path.startsWith("/resources/resource%3A")
  ) {
    throw new Error("Federation resource is outside the delivering contact");
  }
  return resource;
}

function requireAppendInput(input: ConversationAppendRequest): void {
  requireNonempty(input.messageId, "messageId");
  requireNonempty(input.idempotencyKey, "idempotencyKey");
  if (input.social) socialMessageMetadataSchema.parse(input.social);
  if (!input.text.trim() && !input.media?.length) {
    throw new Error("Conversation message requires text or media");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw new Error("Conversation message timestamp is invalid");
  }
}

async function hashAppendInput(
  input: Omit<ConversationAppendInput, "payloadHash">,
): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify({
    messageId: input.messageId,
    author: input.author,
    text: input.text,
    selectedTarget: input.selectedTarget,
    ...(input.social ? { social: input.social } : undefined),
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

function normalizeConversationMediaKey(value: string, conversationId: string): string {
  if (!value.startsWith(conversationMediaPrefix(conversationId))) {
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

function requireNonempty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is required`);
}

function requireOwnerUid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("ownerUid is invalid");
}

function requireConversationKind(value: ConversationKind): void {
  if (value !== "ship" && value !== "work" && value !== "group" && value !== "contact") {
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
