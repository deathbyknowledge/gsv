import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

export const PROCESS_CONVERSATION_ARCHIVE_ROOT = "process-conversation-archives";
export const PROCESS_CONVERSATION_ARCHIVE_STORAGE_CLASS = "process-conversation-archive-v1";

export function processConversationArchiveMetadata(
  owner: Pick<ProcessIdentity, "uid" | "gid">,
): Record<string, string> {
  return {
    uid: String(owner.uid),
    gid: String(owner.gid),
    mode: "000",
    storageClass: PROCESS_CONVERSATION_ARCHIVE_STORAGE_CLASS,
  };
}

export function assertProcessConversationArchiveOwnership(
  object: Pick<R2Object, "customMetadata">,
  owner: Pick<ProcessIdentity, "uid" | "gid">,
): void {
  const expected = processConversationArchiveMetadata(owner);
  const metadata = object.customMetadata;
  if (
    metadata?.uid !== expected.uid
    || metadata.gid !== expected.gid
    || metadata.mode !== expected.mode
    || metadata.storageClass !== expected.storageClass
  ) {
    throw new Error("Conversation archive ownership metadata is invalid");
  }
}

export function conversationArchiveBase(
  ownerUid: number,
  agentUid: number,
  conversationId: string,
): string {
  assertUnixId(ownerUid, "owner uid");
  assertUnixId(agentUid, "agent uid");
  return `/${PROCESS_CONVERSATION_ARCHIVE_ROOT}/${ownerUid}/${agentUid}/${encodeURIComponent(conversationId)}`;
}

/**
 * Narrow owner-authorized store for private conversation transcript blobs.
 * Keys and ownership metadata are derived from Kernel-issued identities; a
 * persisted archive pointer can select only an object in that exact scope.
 */
export class ProcessArchiveStore {
  private readonly scopePrefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly owner: ProcessIdentity,
    private readonly agent: ProcessIdentity,
  ) {
    assertUnixId(owner.uid, "owner uid");
    assertUnixId(owner.gid, "owner gid");
    assertUnixId(agent.uid, "agent uid");
    this.scopePrefix = `${PROCESS_CONVERSATION_ARCHIVE_ROOT}/${owner.uid}/${agent.uid}/`;
  }

  rootPath(): string {
    return `/${this.scopePrefix}`;
  }

  directory(conversationId: string): string {
    return conversationArchiveBase(this.owner.uid, this.agent.uid, conversationId).replace(/^\/+/, "");
  }

  key(conversationId: string, filename: string): string {
    if (!filename || filename === "." || filename === ".." || filename.includes("/")) {
      throw new Error("Invalid conversation archive filename");
    }
    return `${this.directory(conversationId)}/${filename}`;
  }

  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.assertOwnedKey(key);
    const stored = await this.bucket.put(key, value, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: processConversationArchiveMetadata(this.owner),
    });
    if (!stored) {
      throw new Error("Conversation archive key already exists");
    }
  }

  async get(path: string): Promise<R2ObjectBody | null> {
    const key = this.normalizeAndAssertPath(path);
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    this.assertOwnedMetadata(object);
    return object;
  }

  async delete(path: string): Promise<void> {
    const key = this.normalizeAndAssertPath(path);
    const object = await this.bucket.head(key);
    if (!object) {
      return;
    }
    this.assertOwnedMetadata(object);
    await this.bucket.delete(key);
  }

  private normalizeAndAssertPath(path: string): string {
    const key = path.replace(/^\/+/, "");
    this.assertOwnedKey(key);
    return key;
  }

  private assertOwnedKey(key: string): void {
    if (!key.startsWith(this.scopePrefix) || key.endsWith("/") || key.includes("/../")) {
      throw new Error("Conversation archive is outside this process owner scope");
    }
  }

  private assertOwnedMetadata(object: Pick<R2Object, "customMetadata">): void {
    assertProcessConversationArchiveOwnership(object, this.owner);
  }
}

function assertUnixId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}
