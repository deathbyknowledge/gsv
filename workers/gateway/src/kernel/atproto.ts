import type {
  AtprotoBlobReadArgs,
  AtprotoBlobReadResult,
  AtprotoBlobUploadArgs,
  AtprotoBlobUploadResult,
  AtprotoIdentityResult,
  AtprotoWriteArgs,
  AtprotoWriteResult,
  BinaryBody,
  JsonValue,
  ShipProfileRecord,
} from "@humansandmachines/gsv/protocol";
import { jsonObjectSchema, SHIP_PROFILE_COLLECTION, SHIP_PROFILE_RKEY } from "@humansandmachines/gsv/protocol";
import { deploymentPresentation } from "@humansandmachines/gsv/services/deployment";
import {
  PUBLIC_BLOB_MAX_BYTES,
  type PublicRecordWrite,
  type PublicRepository,
  type PublicRepositoryAccount,
  type ShipServiceAuthRequest,
} from "@humansandmachines/gsv/services/pds";
import * as z from "zod/mini";
import { shipAddress } from "../installation/identity";
import { raceWithAbort } from "../shared/abort";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";
import type { ProfileAvatarFile } from "./profile-store";
import { authorizeNestedOperation, nestedToolOwner } from "./tool-approval";

/** Collections a Ship feature publishes itself, and where the person changes them instead. */
const FEATURE_COLLECTIONS = new Map([
  ["space.ship.profile", "space.ship.profile is your profile; change it in People"],
]);

/** One approval covers the whole batch, so it stays small enough to show in full. */
const MAX_WRITES_BYTES = 64 * 1024;
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\.[a-zA-Z]([a-zA-Z0-9]{0,62})?)$/;
const collection = z.string().check(z.maxLength(317), z.regex(NSID, "must be a collection NSID, such as space.ship.note"));
const rkey = z.string().check(
  z.regex(/^[a-zA-Z0-9_~.:-]{1,512}$/, "must be a record key of letters, digits and _~.:-"),
  z.refine((value) => value !== "." && value !== "..", "must be a record key of letters, digits and _~.:-"),
);
const writesSchema = z.array(z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), collection, rkey: z.optional(rkey), record: jsonObjectSchema }),
  z.strictObject({ action: z.literal("put"), collection, rkey, record: jsonObjectSchema }),
  z.strictObject({ action: z.literal("delete"), collection, rkey }),
])).check(z.minLength(1), z.maxLength(10));
const mimeTypeSchema = z.string().check(z.minLength(3), z.maxLength(255));
const cidSchema = z.string().check(z.minLength(1), z.maxLength(128));

/** Validates writes from any caller; the PDS checks each record again as it commits. */
export function parseAtprotoWrites(value: JsonValue): PublicRecordWrite[] {
  const parsed = writesSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid writes: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function handleAtprotoIdentity(ctx: KernelContext): Promise<AtprotoIdentityResult> {
  requirePublisher(ctx);
  return { identity: await withRepository(ctx, (repository) => raceWithAbort(repository.account(), ctx.requestSignal)) };
}

/** Commits the writes to the Ship's public repository once the person approves what their Ship publishes. */
export async function handleAtprotoWrite(args: AtprotoWriteArgs, ctx: KernelContext): Promise<AtprotoWriteResult> {
  const ownerUid = requirePublisher(ctx);
  const writes = parseAtprotoWrites(args?.writes);
  if (new TextEncoder().encode(JSON.stringify(writes)).byteLength > MAX_WRITES_BYTES) {
    throw new Error(`These writes exceed ${MAX_WRITES_BYTES / 1024} KiB; publish them in smaller batches`);
  }
  for (const write of writes) {
    const feature = FEATURE_COLLECTIONS.get(featureKey(write.collection));
    if (feature) throw new Error(feature);
  }
  const address = publishingAddress(ownerUid, ctx);
  // A direct process syscall carries no tool owner yet; derive it so the Ship's run policy
  // applies however the write arrives. A signed-in human has none and is not asked.
  await authorizeNestedOperation({ ...ctx, toolOwner: nestedToolOwner(ctx) }, "atproto.write",
    jsonObjectSchema.parse({ handle: address.handle, address: address.hostname, writes }), "ask");
  // The person may have made their profile private while deciding.
  publishingAddress(ownerUid, ctx);
  return await withRepository(ctx, async (repository) => {
    await ensureIdentity(repository, address.hostname, ctx);
    // A commit already sent completes, so its outcome is reported rather than raced.
    ctx.requestSignal?.throwIfAborted();
    return await repository.applyWrites(writes);
  });
}

/** Streams a file into the Ship's repository, where nothing serves it until a record references it. */
export async function handleAtprotoBlobUpload(
  args: AtprotoBlobUploadArgs,
  ctx: KernelContext,
  body: BinaryBody | undefined,
): Promise<AtprotoBlobUploadResult> {
  const ownerUid = requirePublisher(ctx);
  if (!body) throw new Error("atproto.blob.upload requires the file as its request body");
  const size = body.length;
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("atproto.blob.upload requires a request body of declared length");
  }
  if (size === 0) throw new Error("The file is empty");
  if (size > PUBLIC_BLOB_MAX_BYTES) throw new Error(`Files on the open network are limited to ${PUBLIC_BLOB_MAX_BYTES / 1024 / 1024} MiB`);
  const mimeType = mimeTypeSchema.safeParse(args?.mimeType);
  if (!mimeType.success) throw new Error("atproto.blob.upload requires the file's MIME type");
  const address = publishingAddress(ownerUid, ctx);
  return await withRepository(ctx, async (repository) => {
    await ensureIdentity(repository, address.hostname, ctx);
    const fixed = new FixedLengthStream(size);
    // The handler, not the pipe, cancels a body the repository stopped reading; a pipe that
    // cancels a script-backed source into a native stream leaves the cancellation unobserved.
    const [uploaded, piped] = await Promise.allSettled([
      repository.uploadBlob(fixed.readable, size, mimeType.data),
      body.stream.pipeTo(fixed.writable, { signal: ctx.requestSignal, preventCancel: true }),
    ]);
    if (piped.status === "rejected") await body.stream.cancel(piped.reason).catch(() => {});
    if (uploaded.status === "rejected") throw uploaded.reason;
    if (piped.status === "rejected") throw piped.reason;
    return { blob: uploaded.value };
  });
}

/** Reads back one of the Ship's files, including one no record references yet. */
export async function handleAtprotoBlobRead(
  args: AtprotoBlobReadArgs,
  ctx: KernelContext,
): Promise<{ data: AtprotoBlobReadResult; body: BinaryBody }> {
  requirePublisher(ctx);
  const cid = cidSchema.safeParse(args?.cid);
  if (!cid.success) throw new Error("atproto.blob.read requires a blob CID");
  const blob = await withRepository(ctx, (repository) => raceWithAbort(repository.readBlob(cid.data), ctx.requestSignal, {
    onLateResolve: (late) => void late?.body.cancel("Request was cancelled").catch(() => {}),
  }));
  if (!blob) throw new Error(`No file with CID ${cid.data} on this Ship`);
  return { data: { mimeType: blob.mimeType, size: blob.size }, body: { stream: blob.body, length: blob.size } };
}

/**
 * Writes the person's profile record, after its picture, to the Ship's
 * repository and returns the record's CID. People decides what to publish and
 * the Kernel's profile rules who may; this is the profile's own write, so it
 * waits for no published profile and asks no approval. A first publish
 * creates the Ship's DID.
 */
export async function putProfileRecord(ctx: KernelContext, record: ShipProfileRecord, avatar: ProfileAvatarFile | null): Promise<string> {
  return await withRepository(ctx, async (repository) => {
    await ensureIdentity(repository, shipHostname(ctx), ctx);
    if (avatar) {
      const blob = await raceWithAbort(repository.uploadBlob(new Blob([avatar.bytes.slice()]).stream(), avatar.size, avatar.mimeType), ctx.requestSignal);
      if (blob.ref.$link !== avatar.cid) throw new Error("The open-network host named the profile picture differently");
    }
    // A commit already sent completes, so its outcome is reported rather than raced.
    ctx.requestSignal?.throwIfAborted();
    const commit = await repository.applyWrites([
      { action: "put", collection: SHIP_PROFILE_COLLECTION, rkey: SHIP_PROFILE_RKEY, record: jsonObjectSchema.parse(record) },
    ]);
    const cid = commit.results[0]?.cid;
    if (!cid) throw new Error("The open-network host didn't name the profile record it stored");
    return cid;
  });
}

/** Deletes the profile record from the Ship's repository; a record already gone stays gone. */
export async function deleteProfileRecord(ctx: KernelContext): Promise<void> {
  await withRepository(ctx, async (repository) => {
    ctx.requestSignal?.throwIfAborted();
    try {
      await repository.applyWrites([{ action: "delete", collection: SHIP_PROFILE_COLLECTION, rkey: SHIP_PROFILE_RKEY }]);
    } catch (error) {
      // The repository refuses to delete a record it doesn't hold, which an interrupted unpublish leaves behind.
      if (!(error instanceof Error && error.message.includes(`Could not find a record with key: ${SHIP_PROFILE_COLLECTION}/${SHIP_PROFILE_RKEY}`))) throw error;
    }
  });
}

/** The Ship's account on the open network: its DID and the handle that names it; its first outward act creates them. */
export async function ensureShipAccount(ctx: KernelContext): Promise<PublicRepositoryAccount> {
  return await withRepository(ctx, async (repository) => await ensureIdentity(repository, shipHostname(ctx), ctx));
}

/** The Ship's DID, created under its address by the first outward act: a publish, an invitation or a message request. */
export async function ensureShipDid(ctx: KernelContext): Promise<string> {
  return ctx.shipIdentity.current() ?? await withRepository(ctx, async (repository) => (await ensureIdentity(repository, shipHostname(ctx), ctx)).did);
}

/** Signs a service-auth token for one call to another Ship, creating the Ship's DID if this is its first outward act. */
export async function signShipCall(ctx: KernelContext, request: ShipServiceAuthRequest): Promise<string> {
  return await withRepository(ctx, async (repository) => {
    if (!ctx.shipIdentity.current()) await ensureIdentity(repository, shipHostname(ctx), ctx);
    return await raceWithAbort(repository.serviceAuth(request), ctx.requestSignal);
  });
}

/** What the caller still needs before it can publish, as the shell manual names it; without a host nothing else helps. */
export function atprotoMissingRequirements(ctx: KernelContext): string[] {
  if (!ctx.env.PDS) return ["configured open-network host"];
  const ownerUid = publisherUid(ctx);
  if (ownerUid === null) return ["the signed-in person or their Ship"];
  return profilePublished(ownerUid, ctx) ? [] : ["published profile"];
}

/** The space's person, signed in or through their own Ship: the public repository speaks for them. */
function publisherUid(ctx: KernelContext): number | null {
  const ownerUid = principalOf(ctx)?.kind === "human" ? resolveCallerOwnerUid(ctx) : null;
  const process = ctx.processId ? ctx.procs.get(ctx.processId) : null;
  const caller = ctx.processId
    ? process?.isPersonalController === true && process.ownerUid === ownerUid
    : Boolean(ctx.connection);
  return ownerUid !== null && caller && ctx.auth.getHumanAccount()?.uid === ownerUid ? ownerUid : null;
}

function requirePublisher(ctx: KernelContext): number {
  const ownerUid = publisherUid(ctx);
  if (ownerUid === null) throw new Error("Publishing to the open network requires the signed-in person or their Ship");
  return ownerUid;
}

function profilePublished(ownerUid: number, ctx: KernelContext): boolean {
  return ctx.profiles.published(ownerUid) !== null;
}

/** The Ship's address to publish under; the public identity comes with the person's published profile. */
function publishingAddress(ownerUid: number, ctx: KernelContext) {
  const address = shipAddress(ctx.installationIdentity, deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG).primaryDomain);
  if (!address) throw new Error("This Ship has no address to publish under");
  if (!profilePublished(ownerUid, ctx)) {
    throw new Error("Your profile is private, so your Ship can't publish to the open network. Publish your profile in People first.");
  }
  return { handle: address.handle, hostname: new URL(address.origin).hostname };
}

/** The hostname the Ship's DID is created under; its handle on the open network. */
function shipHostname(ctx: KernelContext): string {
  const address = shipAddress(ctx.installationIdentity, deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG).primaryDomain);
  if (!address) throw new Error("This Ship has no address to create its identity under");
  return new URL(address.origin).hostname;
}

/** An NSID's authority is a domain, so only its name keeps its case. */
function featureKey(nsid: string): string {
  const name = nsid.lastIndexOf(".");
  return `${nsid.slice(0, name).toLowerCase()}${nsid.slice(name)}`;
}

/** The Ship's public identity; its first outward act creates it, and the Kernel keeps its DID. */
async function ensureIdentity(repository: PublicRepository, hostname: string, ctx: KernelContext): Promise<PublicRepositoryAccount> {
  const account = await raceWithAbort(repository.account(), ctx.requestSignal)
    ?? await raceWithAbort(repository.ensureAccount(hostname), ctx.requestSignal);
  ctx.shipIdentity.remember(account.did);
  return account;
}

async function withRepository<T>(ctx: KernelContext, use: (repository: PublicRepository) => Promise<T>): Promise<T> {
  const pds = ctx.env.PDS;
  if (!pds) throw new Error("Publishing to the open network isn't available on this deployment");
  const repository = await raceWithAbort(pds.getInstallation(ctx.installationId), ctx.requestSignal, {
    onLateResolve: (late) => late[Symbol.dispose]?.(),
  });
  try {
    return await use(repository);
  } finally {
    repository[Symbol.dispose]?.();
  }
}
