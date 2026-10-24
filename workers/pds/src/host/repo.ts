import { DurableObject } from "cloudflare:workers";
import { CODEC_RAW, fromDigest, fromString as parseCid, toString as formatCid } from "@atcute/cid";
import type { Service } from "@atcute/did-plc";
import { isHandle, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import { BlockMap } from "@atproto/repo";
import * as z from "zod/mini";
import { BlobStore, extractJsonBlobCids, type BlobRef } from "../cirrus/repo/blobs";
import { RepoEngine } from "../cirrus/repo/engine";
import { Sequencer } from "../cirrus/repo/sequencer";
import { SqliteRepoStorage } from "../cirrus/repo/storage";
import { getBlocksCar, getRecordProofCar, getRepoCar } from "../cirrus/repo/sync";
import { validator } from "../cirrus/validation";
import type { HostEnv } from "./env";
import { FIREHOSE_NAME, type OutboxEvent, type RepoState } from "./firehose";
import { didDocument, mintIdentity, registerGenesis, tombstoneIdentity, type RepoIdentity } from "./identity";
import { migrate } from "./schema";
import { signServiceAuth, type ServiceAuthRequest } from "./service-auth";
import { parseQuery, repositoryParameter, XRPC_PREFIX, XrpcError } from "./xrpc";

/** A JSON value inside a repository record. */
export type LexValue = string | number | boolean | null | LexValue[] | LexObject;

/** A JSON object inside a repository record. */
export type LexObject = { [key: string]: LexValue };

/** One change to a repository; every write in a call lands in one signed commit. */
export type RepoWrite =
  | { action: "create"; collection: string; rkey?: string; record: LexObject }
  | { action: "put"; collection: string; rkey: string; record: LexObject }
  | { action: "delete"; collection: string; rkey: string };

export type CommitResult = {
  commit: { cid: string; rev: string };
  /** One entry per write, in order; a delete has no record CID. */
  results: Array<{ uri: string; cid: string | null }>;
};

export type HostedAccount = { did: string; handle: string };

/** A deletion of this repository. It stays after erasure, so the object never holds another account. */
export type Retirement = {
  /** The deletion that retired the repository; it never changes. */
  operation: string;
  /** The object's name, which the host directory and deletion discovery know it by. */
  name: string;
  phase: "quiescing" | "quiesced" | "erasing" | "erased";
  /** When the phase last changed. */
  updatedAt: number;
  /** Whether the host firehose has the account's deletion event. */
  announced: boolean;
  /** The DID still to tombstone in the directory, if any. */
  did: RepoIdentity["did"] | null;
};

/** What a deletion has left to do in this repository. */
export type RetirementStatus = {
  retirement: Retirement | null;
  /** Whether the object still holds the account's repository, files and host entries. */
  account: boolean;
  /** Whether the directory still resolves the account's DID. */
  identity: boolean;
};

/** Largest blob the host stages. */
export const MAX_BLOB_BYTES = 48 * 1024 * 1024;

const ACCOUNT_KEY = "account";
const RETIREMENT_KEY = "retirement";
const DELIVERED_KEY = "firehose.delivered";
const FAILURES_KEY = "firehose.failures";
const DELIVERY_BATCH = 100;
/** Delivered events kept locally so the wake check can read the last announced head. */
const KEEP_DELIVERED = 100;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
const STAGED_BLOB_TTL_MS = 6 * 60 * 60_000;
/** Files one erasure call deletes, the most one R2 delete takes. */
const ERASE_BATCH = 1_000;
/** Stored values one delete call removes. */
const DELETE_BATCH = 128;
const EVENT_TYPES = ["commit", "identity", "sync", "account"] as const;

const MIGRATIONS = [{
  id: 1,
  statements: [
    // An upload streams into a staged copy named before its CID is known; the CID is set once every byte arrives.
    "CREATE TABLE staged_blobs (name TEXT PRIMARY KEY, cid TEXT UNIQUE, expires_at INTEGER NOT NULL)",
    "CREATE INDEX staged_blobs_expiry ON staged_blobs(expires_at)",
  ],
}];

const collection = z.string().check(z.refine((value) => isNsid(value), "must be a collection NSID"));
const recordKey = z.string().check(z.refine((value) => isRecordKey(value), "must be a record key"));
const blobCid = z.string().check(z.refine((value) => isCanonicalCid(value, CODEC_RAW), "must be a blob CID"));
const recordQuery = z.object({ collection, rkey: recordKey, cid: z.optional(z.string()) });
const listRecordsQuery = z.object({
  collection,
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(100)), 50),
  cursor: z.optional(recordKey),
  reverse: z._default(z.stringbool(), false),
});
const blobQuery = z.object({ cid: blobCid });
const listBlobsQuery = z.object({
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(1000)), 500),
  cursor: z.optional(z.string()),
});

type StoredAccount = RepoIdentity & {
  /** This object's name; the host directory addresses the repository by it. */
  name: string;
  blobPrefix: string;
  /** Whether the PLC directory accepted the genesis operation. */
  registered: boolean;
};

type OpenRepo = {
  account: StoredAccount;
  storage: SqliteRepoStorage;
  sequencer: Sequencer;
  engine: RepoEngine;
  blobs: BlobStore;
  /** Whether this instance has compared the repository head with its last announced event. */
  checked: boolean;
};

type EngineWrite = Parameters<RepoEngine["applyWrites"]>[0][number];

type PreparedWrite = {
  write: EngineWrite;
  /** Blob CIDs the record references; null for a delete. */
  blobs: string[] | null;
};

/**
 * One hosted account: its did:plc, signed repository, blobs and firehose outbox.
 *
 * Writes run one at a time. A write waits on blob storage before and after its
 * commit, and the object accepts other requests meanwhile; a write admitted
 * then would choose between creating and updating a record, and decide which
 * blobs are still referenced, from the repository as it was before the earlier
 * commit. The engine itself has no write lock.
 *
 * The engine's event log is the outbox. An alarm sends the events the host
 * firehose has not acknowledged, oldest first, and retries with backoff.
 */
export class HostedRepo extends DurableObject<HostEnv> {
  private opened: OpenRepo | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Uploads this instance is still storing; a deletion waits for them. */
  private uploads = 0;

  /**
   * Creates the account's DID, naming any other services it offers, and its
   * empty repository, or returns the account this object already holds.
   */
  async create(handle: string, blobPrefix: string, services: Record<string, Service> = {}): Promise<HostedAccount> {
    if (!isHandle(handle)) throw new Error(`InvalidHandle: ${handle} is not a handle`);
    return this.serialize(async () => {
      await this.requireLive();
      // Handles compare without case; the host keeps the lowercase form.
      const repo = this.open(await this.provision(handle.toLowerCase(), blobPrefix, services));
      // The first access commits the empty repository; activation then announces
      // #account, #identity and #sync, and does nothing once the account is active.
      await repo.engine.getStatus();
      await repo.engine.activateAccount();
      return { did: repo.account.did, handle: repo.account.handle };
    });
  }

  async account(): Promise<HostedAccount | null> {
    const account = await this.storedAccount();
    return account ? { did: account.did, handle: account.handle } : null;
  }

  /** Signs a service-auth token for one call from this account to another service. */
  async serviceAuth(request: ServiceAuthRequest): Promise<string> {
    await this.requireLive();
    const repo = await this.requireRepo();
    if (!await repo.storage.getActive()) throw new Error(`RepoDeactivated: ${repo.account.did} cannot sign calls`);
    return signServiceAuth(repo.account.did, repo.account.signingKey, request);
  }

  /** Applies writes in one signed commit after validating records and the blobs they reference. */
  async applyWrites(writes: RepoWrite[]): Promise<CommitResult> {
    return this.write(async (repo) => {
      await this.requireLive();
      const prepared = await this.prepare(repo, writes);
      const promoted = await this.promote(repo, prepared);
      const before = await repo.storage.getRev();
      let committed: Awaited<ReturnType<RepoEngine["applyWrites"]>>;
      try {
        committed = await repo.engine.applyWrites(prepared.map((entry) => entry.write));
      } catch (error) {
        // A commit saved before the failure references these blobs, so they stay public.
        if ((await repo.storage.getRev()) === before) await unpublish(repo, promoted);
        throw error;
      }
      const results = prepared.map((entry, index) => {
        const result = committed.results[index];
        return entry.blobs === null || !result?.uri || !result.cid
          ? { uri: `at://${repo.account.did}/${entry.write.collection}/${entry.write.rkey ?? ""}`, cid: null }
          : { uri: result.uri, cid: result.cid };
      });
      await this.updateBlobReferences(repo, prepared, results);
      await this.unstage(repo, promoted.flatMap((cid) => this.stagedName(cid) ?? []));
      return { commit: committed.commit, results };
    });
  }

  /**
   * Streams an upload of the declared size into staging and names it by its CID
   * once every byte has arrived. Nothing serves the upload until a record
   * references it; an upload no record references expires.
   */
  async uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<BlobRef> {
    try {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("InvalidRequest: an upload must declare its size");
      if (size > MAX_BLOB_BYTES) throw new Error(`BlobTooLarge: blobs are limited to ${MAX_BLOB_BYTES} bytes`);
      if (!MIME_TYPE.test(mimeType)) throw new Error(`InvalidRequest: ${mimeType} is not a MIME type`);
    } catch (error) {
      await body.cancel(error).catch(() => {});
      throw error;
    }
    // The staged copy is recorded before any byte is stored, so it expires even if the upload never finishes.
    let name: string;
    try {
      name = await this.write(async () => {
        await this.requireLive();
        const staged = `upload-${crypto.randomUUID()}`;
        const expiresAt = Date.now() + STAGED_BLOB_TTL_MS;
        this.ctx.storage.sql.exec("INSERT INTO staged_blobs (name, cid, expires_at) VALUES (?, NULL, ?)", staged, expiresAt);
        await this.alarmBy(expiresAt);
        // Counted within the write, so a deletion queued behind it waits for these bytes.
        this.uploads += 1;
        return staged;
      });
    } catch (error) {
      await body.cancel(error).catch(() => {});
      throw error;
    }
    try {
      const repo = await this.requireRepo();
      const hashing = hashed(body, size);
      await repo.blobs.putStaged(name, hashing.stream, mimeType);
      const cid = formatCid(fromDigest(CODEC_RAW, new Uint8Array(await hashing.digest)));
      return await this.write(async (repo) => {
        await this.requireLive();
        const expiresAt = Date.now() + STAGED_BLOB_TTL_MS;
        if (this.stagedName(cid) !== null || await repo.blobs.hasBlob(cid)) {
          // The same bytes are already staged or public; that copy serves this upload too.
          await this.unstage(repo, [name]);
          this.ctx.storage.sql.exec("UPDATE staged_blobs SET expires_at = MAX(expires_at, ?) WHERE cid = ?", expiresAt, cid);
        } else {
          this.ctx.storage.sql.exec("UPDATE staged_blobs SET cid = ?, expires_at = ? WHERE name = ?", cid, expiresAt, name);
        }
        await this.alarmBy(expiresAt);
        return { $type: "blob", ref: { $link: cid }, mimeType, size };
      });
    } finally {
      this.uploads -= 1;
    }
  }

  /** One of this repository's blobs, public or still staged, for its owner to look at before publishing. */
  async readBlob(cid: string): Promise<{ body: ReadableStream<Uint8Array>; mimeType: string; size: number } | null> {
    if (!isCanonicalCid(cid, CODEC_RAW)) throw new Error(`InvalidRequest: ${cid} is not a blob CID`);
    const repo = await this.requireRepo();
    const staged = this.stagedName(cid);
    const object = (await repo.blobs.getBlob(cid)) ?? (staged === null ? null : await repo.blobs.getStagedBlob(staged));
    if (!object) return null;
    return { body: object.body, mimeType: object.httpMetadata?.contentType ?? "application/octet-stream", size: object.size };
  }

  async state(): Promise<RepoState | null> {
    const repo = await this.readable();
    return repo ? repoState(repo, await this.retired()) : null;
  }

  /**
   * Starts deleting this repository: it refuses every later write, tells the
   * host firehose the account is deleted, and waits for uploads already
   * storing their bytes. Repeating it continues the same deletion.
   */
  async retire(operation: string): Promise<RetirementStatus> {
    return this.serialize(async () => {
      await this.quiesce(operation);
      return this.retirementStatus(operation);
    });
  }

  /**
   * Erases a retired repository's files, host entries and storage, then
   * tombstones its DID. A call that leaves files makes progress and returns;
   * the next continues. The deletion's record stays.
   */
  async erase(operation: string): Promise<RetirementStatus> {
    return this.serialize(async () => {
      let retirement = await this.storedRetirement(operation);
      if (!retirement) throw new Error("RepoNotRetired: a repository's deletion must quiesce first");
      if (retirement.phase === "quiescing") retirement = await this.quiesce(operation);
      if (retirement.phase === "quiescing" || retirement.phase === "erased") return this.retirementStatus(operation);
      if (retirement.phase === "quiesced") retirement = await this.saveRetirement({ ...retirement, phase: "erasing", updatedAt: Date.now() });
      const account = await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY);
      if (account) {
        // Public and staged copies both sit under the account's own prefix.
        const listed = await this.env.BLOBS.list({ prefix: `${account.blobPrefix}${account.did}/`, limit: ERASE_BATCH });
        if (listed.objects.length > 0) await this.env.BLOBS.delete(listed.objects.map((object) => object.key));
        if (listed.truncated) return this.retirementStatus(operation);
        await this.env.FIREHOSE.getByName(FIREHOSE_NAME).eraseRepository(account.name);
        await this.eraseStorage();
      }
      if (retirement.did) {
        await tombstoneIdentity(this.env, retirement.did);
        retirement = await this.saveRetirement({ ...retirement, did: null });
      }
      await this.saveRetirement({ ...retirement, phase: "erased", updatedAt: Date.now() });
      return this.retirementStatus(operation);
    });
  }

  /** What the named deletion has left to do here; another deletion is refused. */
  async retirementStatus(operation: string): Promise<RetirementStatus> {
    const retirement = await this.storedRetirement(operation);
    const account = (await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY)) !== undefined;
    return { retirement, account, identity: retirement ? retirement.did !== null : account };
  }

  /**
   * For deletion discovery: the name of the installation this object belongs
   * to, and whether it holds anything more than a deletion's record. An object
   * holding something it cannot name has no name.
   */
  async holding(): Promise<{ name: string | null; holds: boolean }> {
    const account = await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY);
    if (account) return { name: account.name, holds: true };
    const retirement = await this.ctx.storage.get<Retirement>(RETIREMENT_KEY);
    if (retirement) return { name: retirement.name, holds: (await this.ctx.storage.list({ limit: 2 })).size > 1 || this.tables().length > 0 };
    return { name: null, holds: (await this.ctx.storage.list({ limit: 1 })).size > 0 || this.tables().length > 0 };
  }

  /** Serves this repository's XRPC reads; the host front door routes each one to the object holding the repository. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.slice(XRPC_PREFIX.length);
    const parameter = repositoryParameter(method);
    if (!parameter) return new XrpcError("MethodNotImplemented", `Method not implemented: ${method}`, 501).response();
    const repo = await this.readable();
    const identifier = url.searchParams.get(parameter);
    if (!repo || !identifier || !identifies(repo.account, identifier)) {
      return new XrpcError("RepoNotFound", `Could not find repo: ${identifier ?? ""}`).response();
    }
    try {
      return await this.read(repo, method, url);
    } catch (error) {
      if (error instanceof XrpcError) return error.response();
      throw error;
    }
  }

  override async alarm(): Promise<void> {
    const account = await this.storedAccount();
    if (!account) return;
    // A quiesced deletion has delivered the account's last event, and erasure removes its files.
    const retirement = await this.ctx.storage.get<Retirement>(RETIREMENT_KEY);
    if (retirement && retirement.phase !== "quiescing") return;
    const repo = this.open(account);
    await this.write(async () => this.expireStagedBlobs(repo, Date.now()));
    let retryAt: number | null = null;
    try {
      await this.deliver(repo);
      await this.ctx.storage.delete(FAILURES_KEY);
    } catch (error) {
      const failures = ((await this.ctx.storage.get<number>(FAILURES_KEY)) ?? 0) + 1;
      await this.ctx.storage.put(FAILURES_KEY, failures);
      retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
      console.error("Firehose delivery failed; retrying", error);
    }
    const expiry = this.nextStagedExpiry();
    const next = retryAt === null ? expiry : Math.min(retryAt, expiry ?? retryAt);
    if (next !== null) await this.alarmBy(next);
  }

  private async read(repo: OpenRepo, method: string, url: URL): Promise<Response> {
    const { did, handle } = repo.account;
    const active = await repo.storage.getActive();
    if (method === "com.atproto.sync.getRepoStatus") {
      const rev = await repo.storage.getRev();
      return Response.json({ did, active, status: active ? undefined : "deactivated", rev: rev ?? undefined });
    }
    if (!active) throw new XrpcError("RepoDeactivated", `Repo has been deactivated: ${did}`);
    switch (method) {
      case "com.atproto.repo.describeRepo": {
        const { collections } = await repo.engine.describeRepo();
        const didDoc = didDocument(repo.account);
        return Response.json({ handle, did, didDoc, collections, handleIsCorrect: true });
      }
      case "com.atproto.repo.getRecord": {
        const query = parseQuery(recordQuery, url);
        const found = await repo.engine.getRecord(query.collection, query.rkey);
        const uri = `at://${did}/${query.collection}/${query.rkey}`;
        if (!found || (query.cid !== undefined && query.cid !== found.cid)) {
          throw new XrpcError("RecordNotFound", `Could not locate record: ${uri}`);
        }
        return Response.json({ uri, cid: found.cid, value: found.record });
      }
      case "com.atproto.repo.listRecords":
        return Response.json(await this.listRecords(repo, parseQuery(listRecordsQuery, url)));
      case "com.atproto.sync.getRepo":
        return getRepoCar(this.ctx.storage.sql, repo.storage);
      case "com.atproto.sync.getLatestCommit": {
        const status = await repo.engine.getStatus();
        return Response.json({ cid: status.head, rev: status.rev });
      }
      case "com.atproto.sync.getBlocks": {
        const cids = url.searchParams.getAll("cids");
        if (cids.length === 0 || !cids.every((cid) => isCanonicalCid(cid))) {
          throw new XrpcError("InvalidRequest", "cids must list one or more CIDs");
        }
        return car(await getBlocksCar(repo.storage, cids));
      }
      case "com.atproto.sync.getRecord": {
        const query = parseQuery(recordQuery, url);
        return car(await getRecordProofCar(repo.storage, query.collection, query.rkey));
      }
      case "com.atproto.sync.getBlob": {
        const { cid } = parseQuery(blobQuery, url);
        const blob = await repo.blobs.getBlob(cid);
        if (!blob) throw new XrpcError("BlobNotFound", `Blob not found: ${cid}`);
        return new Response(blob.body, {
          headers: {
            "Content-Type": blob.httpMetadata?.contentType ?? "application/octet-stream",
            "Content-Length": String(blob.size),
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      case "com.atproto.sync.listBlobs": {
        const query = parseQuery(listBlobsQuery, url);
        const prefix = `${repo.account.blobPrefix}${did}/`;
        // Staged uploads sit under staged/, which the delimiter keeps out of the listing.
        const listed = await this.env.BLOBS.list({ prefix, delimiter: "/", limit: query.limit, cursor: query.cursor });
        return Response.json({
          cids: listed.objects.map((object) => object.key.slice(prefix.length)),
          cursor: listed.truncated ? listed.cursor : undefined,
        });
      }
    }
    throw new XrpcError("MethodNotImplemented", `Method not implemented: ${method}`, 501);
  }

  /**
   * Lists a collection newest record key first, as the reference PDS does, or
   * oldest first when reversed; the cursor is the last record key returned.
   */
  private async listRecords(repo: OpenRepo, query: z.output<typeof listRecordsQuery>) {
    const tree = (await repo.engine.getRepo()).data;
    const prefix = `${query.collection}/`;
    const bound = query.cursor === undefined ? null : `${prefix}${query.cursor}`;
    const start = query.reverse && bound !== null ? bound : prefix;
    const keys: string[] = [];
    let previous: string | null = null;
    for await (const leaf of tree.walkLeavesFrom(start)) {
      if (leaf.key < start || (previous !== null && leaf.key <= previous)) continue;
      if (!leaf.key.startsWith(prefix)) break;
      previous = leaf.key;
      if (query.reverse) {
        if (leaf.key === bound) continue;
        keys.push(leaf.key);
        if (keys.length === query.limit) break;
      } else {
        if (bound !== null && leaf.key >= bound) break;
        keys.push(leaf.key);
        if (keys.length > query.limit) keys.shift();
      }
    }
    if (!query.reverse) keys.reverse();
    const records = [];
    for (const key of keys) {
      const rkey = key.slice(prefix.length);
      const found = await repo.engine.getRecord(query.collection, rkey);
      if (found) records.push({ uri: `at://${repo.account.did}/${key}`, cid: found.cid, value: found.record });
    }
    const last = keys.at(-1);
    return { records, cursor: keys.length === query.limit && last ? last.slice(prefix.length) : undefined };
  }

  private async provision(handle: string, blobPrefix: string, services: Record<string, Service>): Promise<StoredAccount> {
    const name = this.ctx.id.name;
    if (!name) throw new Error("A hosted repository must be addressed by name");
    let account = await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY);
    if (account && (account.handle !== handle || account.blobPrefix !== blobPrefix)) {
      throw new Error("RepoConflict: this repository already belongs to another account");
    }
    if (!account) {
      account = { ...(await mintIdentity(this.env, handle, services)), name, blobPrefix, registered: false };
      await this.ctx.storage.put(ACCOUNT_KEY, account);
    }
    if (!account.registered) {
      await registerGenesis(this.env, account);
      account = { ...account, registered: true };
      await this.ctx.storage.put(ACCOUNT_KEY, account);
    }
    return account;
  }

  private async storedAccount(): Promise<StoredAccount | null> {
    const account = await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY);
    return account?.registered ? account : null;
  }

  private async retired(): Promise<boolean> {
    return (await this.ctx.storage.get<Retirement>(RETIREMENT_KEY)) !== undefined;
  }

  private async requireLive(): Promise<void> {
    if (await this.retired()) throw new Error("RepoDeleted: this repository's installation is being deleted");
  }

  /** The deletion under way, which must be the one asked for. */
  private async storedRetirement(operation: string): Promise<Retirement | null> {
    const retirement = (await this.ctx.storage.get<Retirement>(RETIREMENT_KEY)) ?? null;
    if (retirement && retirement.operation !== operation) {
      throw new Error("RepoConflict: another deletion of this repository is under way, and a deletion's operation is immutable");
    }
    return retirement;
  }

  private async saveRetirement(retirement: Retirement): Promise<Retirement> {
    await this.ctx.storage.put(RETIREMENT_KEY, retirement);
    return retirement;
  }

  /** Records the deletion, then announces it once no upload is still storing bytes. */
  private async quiesce(operation: string): Promise<Retirement> {
    let retirement = await this.storedRetirement(operation);
    if (!retirement) {
      const name = this.ctx.id.name;
      if (!name) throw new Error("A hosted repository must be addressed by name");
      const account = await this.ctx.storage.get<StoredAccount>(ACCOUNT_KEY);
      retirement = await this.saveRetirement({
        operation, name, phase: "quiescing", updatedAt: Date.now(), announced: false, did: account?.did ?? null,
      });
    }
    if (retirement.phase !== "quiescing" || this.uploads > 0) return retirement;
    const account = await this.storedAccount();
    if (account) {
      const repo = this.open(account);
      if (!retirement.announced) {
        await repo.storage.setActive(false);
        await repo.sequencer.sequenceAccount({ did: account.did, active: false, status: "deleted" });
        retirement = await this.saveRetirement({ ...retirement, announced: true });
      }
      // Relays hear of the deletion before anything is erased.
      await this.deliver(repo);
    }
    return this.saveRetirement({ ...retirement, phase: "quiesced", updatedAt: Date.now() });
  }

  /** Drops the repository's tables and every stored value but the deletion's record. */
  private async eraseStorage(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(() => {
      for (const name of this.tables()) this.ctx.storage.sql.exec(`DROP TABLE "${name}"`);
    });
    const keys = [...(await this.ctx.storage.list()).keys()].filter((key) => key !== RETIREMENT_KEY);
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      await this.ctx.storage.delete(keys.slice(start, start + DELETE_BATCH));
    }
    this.opened = null;
  }

  /** Tables the repository created; the platform's own begin with an underscore or sqlite_. */
  private tables(): string[] {
    return this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
      .map((table) => table.name).filter((name) => !name.startsWith("_") && !name.startsWith("sqlite_"));
  }

  private open(account: StoredAccount): OpenRepo {
    if (this.opened) return this.opened;
    const storage = new SqliteRepoStorage(this.ctx.storage.sql);
    // Repositories start inactive so the first activation announces the account.
    storage.initSchema(false);
    migrate(this.ctx.storage, "hosted_repo", MIGRATIONS);
    const sequencer = new Sequencer(this.ctx.storage.sql);
    this.opened = {
      account,
      storage,
      sequencer,
      engine: new RepoEngine({
        storage,
        sequencer,
        did: account.did,
        signingKey: account.signingKey,
        lock: (fn) => this.ctx.blockConcurrencyWhile(fn),
        broadcast: () => this.alarmBy(Date.now()),
      }),
      blobs: new BlobStore(this.env.BLOBS, account.did, account.blobPrefix),
      checked: false,
    };
    return this.opened;
  }

  private async readable(): Promise<OpenRepo | null> {
    const account = await this.storedAccount();
    if (!account) return null;
    const repo = this.open(account);
    return (await repo.storage.getRoot()) ? repo : null;
  }

  private async requireRepo(): Promise<OpenRepo> {
    const account = await this.storedAccount();
    if (!account) throw new Error("RepoNotFound: this repository has no account");
    return this.open(account);
  }

  /** Runs a write after earlier ones finish, checking the head before the first and after any failure. */
  private write<T>(fn: (repo: OpenRepo) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const repo = await this.requireRepo();
      if (!repo.checked) {
        await this.announceUnsequencedHead(repo);
        repo.checked = true;
      }
      try {
        return await fn(repo);
      } catch (error) {
        await this.announceUnsequencedHead(repo);
        throw error;
      }
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The engine saves a commit before it sequences the commit's event, so a
   * failure between the two leaves a head that no event announced. Announce the
   * head with #sync so relays resynchronise instead of rejecting the next commit.
   */
  private async announceUnsequencedHead(repo: OpenRepo): Promise<void> {
    if (!(await repo.storage.getActive())) return;
    const root = await repo.storage.getRoot();
    const rev = await repo.storage.getRev();
    if (!root || !rev || (await this.lastAnnouncedRev(repo)) === rev) return;
    const bytes = await repo.storage.getBytes(root);
    if (!bytes) throw new Error(`Repository head block ${root.toString()} is missing`);
    const blocks = new BlockMap();
    blocks.set(root, bytes);
    await repo.sequencer.sequenceSync({ did: repo.account.did, rev, cid: root, blocks });
    await this.alarmBy(Date.now());
  }

  private async lastAnnouncedRev(repo: OpenRepo): Promise<string | null> {
    const row = this.ctx.storage.sql.exec<{ seq: number }>(
      "SELECT seq FROM firehose_events WHERE event_type IN ('commit', 'sync') ORDER BY seq DESC LIMIT 1",
    ).toArray()[0];
    if (!row) return null;
    const [event] = await repo.sequencer.getEventsSince(row.seq - 1, 1);
    return event?.type === "commit" || event?.type === "sync" ? event.event.rev : null;
  }

  private async prepare(repo: OpenRepo, writes: RepoWrite[]): Promise<PreparedWrite[]> {
    const prepared: PreparedWrite[] = [];
    for (const write of writes) {
      if (!isNsid(write.collection)) {
        throw new Error(`InvalidRequest: ${write.collection} is not a collection NSID`);
      }
      if (write.action === "delete") {
        prepared.push({
          write: { $type: "com.atproto.repo.applyWrites#delete", collection: write.collection, rkey: write.rkey },
          blobs: null,
        });
        continue;
      }
      const { record, status } = validator.validate({ collection: write.collection, rkey: write.rkey, record: write.record });
      const replaces = write.action === "put" && (await repo.engine.getRecord(write.collection, write.rkey)) !== null;
      prepared.push({
        write: {
          $type: replaces ? "com.atproto.repo.applyWrites#update" : "com.atproto.repo.applyWrites#create",
          collection: write.collection,
          rkey: write.rkey,
          value: record,
          validationStatus: status,
        },
        blobs: extractJsonBlobCids(record),
      });
    }
    return prepared;
  }

  /**
   * Makes every referenced blob public and returns the ones this write promoted
   * from staging; a missing blob unpublishes those again.
   */
  private async promote(repo: OpenRepo, prepared: PreparedWrite[]): Promise<string[]> {
    const promoted: string[] = [];
    for (const cid of new Set(prepared.flatMap((entry) => entry.blobs ?? []))) {
      if (await repo.blobs.hasBlob(cid)) continue;
      const staged = this.stagedName(cid);
      if (staged !== null) await repo.blobs.promoteBlob(cid, staged);
      if (!(await repo.blobs.hasBlob(cid))) {
        await unpublish(repo, promoted);
        throw new Error(`BlobNotFound: no uploaded blob has CID ${cid}`);
      }
      promoted.push(cid);
    }
    return promoted;
  }

  /** Records which blobs each written record references and deletes blobs no record references any more. */
  private async updateBlobReferences(
    repo: OpenRepo,
    prepared: PreparedWrite[],
    results: CommitResult["results"],
  ): Promise<void> {
    const released = new Set<string>();
    for (const [index, entry] of prepared.entries()) {
      const uri = results[index]?.uri;
      if (!uri) continue;
      for (const row of this.ctx.storage.sql.exec<{ blobCid: string }>(
        "SELECT blobCid FROM record_blob WHERE recordUri = ?",
        uri,
      )) {
        released.add(row.blobCid);
      }
      repo.storage.removeRecordBlobs(uri);
      repo.storage.addRecordBlobs(uri, entry.blobs ?? []);
    }
    for (const cid of released) {
      if (!repo.storage.isBlobReferenced(cid)) await repo.blobs.deleteBlob(cid);
    }
  }

  /** The staged copy holding a CID's bytes, once its upload has finished. */
  private stagedName(cid: string): string | null {
    return this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM staged_blobs WHERE cid = ?", cid).toArray()[0]?.name ?? null;
  }

  /** Deletes staged copies by name, after promotion or once an upload expires. */
  private async unstage(repo: OpenRepo, names: string[]): Promise<void> {
    for (const name of names) {
      await repo.blobs.deleteStagedBlob(name);
      this.ctx.storage.sql.exec("DELETE FROM staged_blobs WHERE name = ?", name);
    }
  }

  private async expireStagedBlobs(repo: OpenRepo, now: number): Promise<void> {
    const expired = this.ctx.storage.sql.exec<{ name: string }>(
      "SELECT name FROM staged_blobs WHERE expires_at <= ?",
      now,
    ).toArray();
    await this.unstage(repo, expired.map((row) => row.name));
  }

  private nextStagedExpiry(): number | null {
    return this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM staged_blobs").one().at;
  }

  private async deliver(repo: OpenRepo): Promise<void> {
    const firehose = this.env.FIREHOSE.getByName(FIREHOSE_NAME);
    let delivered = (await this.ctx.storage.get<number>(DELIVERED_KEY)) ?? 0;
    for (;;) {
      const events = this.ctx.storage.sql.exec<{ seq: number; event_type: string; payload: ArrayBuffer }>(
        "SELECT seq, event_type, payload FROM firehose_events WHERE seq > ? ORDER BY seq LIMIT ?",
        delivered,
        DELIVERY_BATCH,
      ).toArray().map((row): OutboxEvent => ({ seq: row.seq, type: eventType(row.event_type), payload: new Uint8Array(row.payload) }));
      if (events.length === 0) return;
      delivered = await firehose.append(repo.account.name, await repoState(repo, await this.retired()), events);
      await this.ctx.storage.put(DELIVERED_KEY, delivered);
      this.ctx.storage.sql.exec("DELETE FROM firehose_events WHERE seq <= ?", delivered - KEEP_DELIVERED);
    }
  }

  private async alarmBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}

async function repoState(repo: OpenRepo, retired: boolean): Promise<RepoState> {
  const active = await repo.storage.getActive();
  const head = await repo.storage.getRoot();
  return {
    did: repo.account.did,
    handle: repo.account.handle,
    active,
    status: active ? null : retired ? "deleted" : "deactivated",
    rev: await repo.storage.getRev(),
    head: head ? head.toString() : null,
  };
}

/** Deletes the public copies of blobs a failed write promoted; their staged uploads remain until they expire. */
async function unpublish(repo: OpenRepo, cids: string[]): Promise<void> {
  await Promise.all(cids.map((cid) => repo.blobs.deleteBlob(cid)));
}

function eventType(value: string): OutboxEvent["type"] {
  const type = EVENT_TYPES.find((candidate) => candidate === value);
  if (!type) throw new Error(`Unknown firehose event type ${value}`);
  return type;
}

/** Whether an at-identifier names this account: its DID, or its handle in any case. */
function identifies(account: StoredAccount, identifier: string): boolean {
  return identifier === account.did || identifier.toLowerCase() === account.handle;
}

/** Whether a string is a CID in its canonical form, optionally of one codec. */
function isCanonicalCid(value: string, codec?: number): boolean {
  try {
    const cid = parseCid(value);
    return formatCid(cid) === value && (codec === undefined || cid.codec === codec);
  } catch {
    return false;
  }
}

/** A MIME type without parameters, which a blob is served with. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/**
 * Passes a body of the declared size through unchanged while hashing it. The
 * stream fails if the body is longer or shorter than declared, and has the
 * fixed length R2 needs.
 */
function hashed(body: ReadableStream<Uint8Array>, size: number) {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  let received = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > size) throw new Error(`InvalidRequest: the upload is longer than its declared ${size} bytes`);
      // The digest gets a copy, so the stored stream keeps its own bytes whatever the digest does with them.
      await writer.write(chunk.slice());
      controller.enqueue(chunk);
    },
    async flush() {
      if (received !== size) throw new Error(`InvalidRequest: the upload ended after ${received} of its declared ${size} bytes`);
      await writer.close();
    },
  });
  return { stream: body.pipeThrough(counted).pipeThrough(new FixedLengthStream(size)), digest: digest.digest };
}

function car(bytes: Uint8Array): Response {
  return new Response(bytes, { headers: { "Content-Type": "application/vnd.ipld.car" } });
}
