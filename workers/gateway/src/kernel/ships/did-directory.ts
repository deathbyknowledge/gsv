import { getPublicKeyFromDidController, type FoundPublicKey } from "@atcute/crypto";
import { defs as plcDefs, normalizeOp, processIndexedEntryLog } from "@atcute/did-plc";
import {
  defs as identityDefs,
  getAtprotoHandle,
  getAtprotoServiceEndpoint,
  getAtprotoVerificationMaterial,
  getPdsEndpoint,
  isAtprotoWebDid,
  isPlcDid,
  webDidToDocumentUrl,
  type DidDocument,
} from "@atcute/identity";
import { isHandle } from "@atcute/lexicons/syntax";
import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { assertFederationTarget, fetchFederation } from "../federation/http";

/** What a Ship needs from an account's DID document. */
export type ResolvedDid = {
  did: string;
  /** The handle the document claims; only `resolveHandle` has checked that the handle names the DID back. */
  handle: string | null;
  /** The `#atproto` key, which signs the account's repository commits and its service-auth tokens. */
  signingKey: { type: string; publicKeyMultibase: string };
  /** Where the account takes Ship-to-Ship calls, from its `#ship` service; absent when it isn't a Ship. */
  shipEndpoint: string | null;
  /** Where the account's public repository is read, from its `#atproto_pds` service. */
  pdsEndpoint: string | null;
};

/** A DID that does not exist, was deactivated, or whose history or document doesn't verify. */
export class DidNotResolvedError extends Error {}

/** A did:plc whose verified history ends in a tombstone, which deactivates it for good. */
export class DidDeactivatedError extends DidNotResolvedError {}

/** The directory could not be reached or answered with an error; a cached document, if any, still stands. */
export class DidDirectoryUnavailableError extends Error {}

export const DEFAULT_PLC_URL = "https://plc.directory";
/** A cached document is served as is for a day, then refreshed in the background. */
const REFRESH_AFTER_MS = 24 * 60 * 60_000;
/** The most documents the Kernel remembers; the least recently used go first. */
const MAX_CACHED_DOCUMENTS = 5_000;
/** An audit log holds every operation, each at most a few kilobytes. */
const MAX_AUDIT_LOG_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_DID_BYTES = 2_048;
const LOOKUP_TIMEOUT_MS = 10_000;
const SHIP_SERVICE = { id: "#ship", type: "ShipService" } as const;

/** A cached document, or null for a DID whose verified history ended in a tombstone. */
type CachedDid = { resolved: ResolvedDid | null; resolvedAtMs: number };

/** The Kernel's cache of other accounts' DID documents, and of the tombstones that deactivated DIDs. */
export class DidDocumentStore {
  constructor(private readonly sql: SqlStorage) {}

  get(did: string, now: number): CachedDid | null {
    const row = this.sql.exec<{ resolved_json: string | null; resolved_at: number }>(
      "UPDATE did_documents SET used_at = ? WHERE did = ? RETURNING resolved_json, resolved_at",
      now,
      did,
    ).toArray()[0];
    if (!row) return null;
    // SAFETY: rows are written only by put(), from a ResolvedDid, and by deactivate(), without one.
    return { resolved: row.resolved_json === null ? null : JSON.parse(row.resolved_json) as ResolvedDid, resolvedAtMs: row.resolved_at };
  }

  put(resolved: ResolvedDid, now: number): void {
    this.write(resolved.did, JSON.stringify(resolved), now);
  }

  /** Keeps the tombstone a lookup found in place of the DID's document. */
  deactivate(did: string, now: number): void {
    this.write(did, null, now);
  }

  /** Which of the DIDs the cache knows were deactivated; it reads nothing from the directory. */
  deactivated(dids: readonly string[]): Set<string> {
    if (dids.length === 0) return new Set();
    return new Set(this.sql.exec<{ did: string }>(
      "SELECT did FROM did_documents WHERE resolved_json IS NULL AND did IN (SELECT value FROM json_each(?))",
      JSON.stringify(dids),
    ).toArray().map(({ did }) => did));
  }

  delete(did: string): void {
    this.sql.exec("DELETE FROM did_documents WHERE did = ?", did);
  }

  private write(did: string, resolvedJson: string | null, now: number): void {
    this.sql.exec(
      `INSERT INTO did_documents (did, resolved_json, resolved_at, used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (did) DO UPDATE SET resolved_json = excluded.resolved_json, resolved_at = excluded.resolved_at, used_at = excluded.used_at`,
      did,
      resolvedJson,
      now,
      now,
    );
    this.sql.exec(
      `DELETE FROM did_documents WHERE did IN (
         SELECT did FROM did_documents ORDER BY used_at DESC, did LIMIT -1 OFFSET ?
       )`,
      MAX_CACHED_DOCUMENTS,
    );
  }
}

/**
 * Resolves a DID to what a Ship needs from its document. A did:plc is read from
 * its directory's audit log, whose every operation must verify back to the
 * genesis operation the DID hashes, so the directory can withhold an update but
 * not forge one. A cached document, or tombstone, answers first; `refresh`
 * reads the directory again, as a failed signature check does once, and
 * `maxAgeMs` does when the cached copy is at least that old.
 */
export async function resolveDid(did: string, ctx: KernelContext, options: { refresh?: boolean; maxAgeMs?: number } = {}): Promise<ResolvedDid> {
  const now = Date.now();
  const cached = ctx.didDocuments.get(did, now);
  if (cached && !options.refresh && (options.maxAgeMs === undefined || now - cached.resolvedAtMs < options.maxAgeMs)) {
    if (cached.resolvedAtMs + REFRESH_AFTER_MS <= now) {
      // A failed refresh keeps the copy this answer used; the next lookup tries again.
      ctx.defer(lookUpDid(did, ctx).catch((cause: unknown) => {
        console.warn("[Kernel] DID document refresh failed", cause instanceof Error ? cause.message : String(cause));
      }));
    }
    if (!cached.resolved) throw new DidDeactivatedError(`${did} was deactivated`);
    return cached.resolved;
  }
  return await lookUpDid(did, ctx);
}

/** Whether a DID's document, or its tombstone, is already cached, so resolving it costs no lookup. */
export function isDidCached(did: string, ctx: KernelContext): boolean {
  return ctx.didDocuments.get(did, Date.now()) !== null;
}

/**
 * Resolves a handle to the DID it names, checked both ways: the handle's host
 * answers with the DID, and the DID's document claims the handle.
 */
export async function resolveHandle(handleValue: string, ctx: KernelContext): Promise<ResolvedDid> {
  const handle = handleValue.trim().toLowerCase();
  if (!isHandle(handle)) throw new DidNotResolvedError(`${handleValue} is not a handle`);
  const url = reachable(`https://${handle}/.well-known/atproto-did`, `@${handle}`, ctx);
  const response = await lookUp(() => fetchFederation(url, {
    headers: { accept: "text/plain" },
    signal: ctx.requestSignal,
  }, ctx, LOOKUP_TIMEOUT_MS), `@${handle}`, ctx);
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new DidNotResolvedError(`@${handle} names no account`);
  }
  const did = new TextDecoder().decode(await readOk(response, MAX_DID_BYTES, `@${handle}`, ctx)).trim();
  if (!isPlcDid(did) && !isAtprotoWebDid(did)) throw new DidNotResolvedError(`@${handle} names no account`);
  const resolved = await resolveDid(did, ctx);
  if (resolved.handle === handle) return resolved;
  // The handle may be newer than the cached document.
  const current = await resolveDid(did, ctx, { refresh: true });
  if (current.handle !== handle) throw new DidNotResolvedError(`@${handle}'s account doesn't claim that handle`);
  return current;
}

/** A DID's handle, kept only when it names the DID back. */
export async function verifiedHandle(did: string, ctx: KernelContext): Promise<string | undefined> {
  const { handle } = await resolveDid(did, ctx);
  if (!handle) return undefined;
  try {
    return (await resolveHandle(handle, ctx)).did === did ? handle : undefined;
  } catch (error) {
    if (error instanceof DidNotResolvedError || error instanceof DidDirectoryUnavailableError) return undefined;
    throw error;
  }
}

/** The public key a resolved account signs with. */
export function signingKeyOf(resolved: ResolvedDid): FoundPublicKey {
  return getPublicKeyFromDidController(resolved.signingKey);
}

async function lookUpDid(did: string, ctx: KernelContext): Promise<ResolvedDid> {
  let document: DidDocument;
  try {
    document = isPlcDid(did) ? await plcDocument(did, ctx) : await webDocument(did, ctx);
  } catch (error) {
    if (error instanceof DidDeactivatedError) ctx.didDocuments.deactivate(did, Date.now());
    else if (error instanceof DidNotResolvedError) ctx.didDocuments.delete(did);
    throw error;
  }
  const resolved = resolvedDid(did, document);
  ctx.didDocuments.put(resolved, Date.now());
  return resolved;
}

async function plcDocument(did: `did:plc:${string}`, ctx: KernelContext): Promise<DidDocument> {
  const directory = new URL(ctx.env.PLC_URL ?? DEFAULT_PLC_URL);
  // The timer ends with the lookup; one left pending would hold the Kernel awake.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("The directory took too long to answer")), LOOKUP_TIMEOUT_MS);
  let entries: Uint8Array;
  try {
    const response = await lookUp(() => fetch(new URL(`/${did}/log/audit`, directory), {
      headers: { accept: "application/json" },
      // The directory answers directly; a redirect is a failed lookup.
      redirect: "manual",
      signal: ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout.signal]) : timeout.signal,
    }), did, ctx);
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      throw new DidNotResolvedError(`${did} isn't registered`);
    }
    entries = await readOk(response, MAX_AUDIT_LOG_BYTES, did, ctx);
  } finally {
    clearTimeout(timer);
  }
  const log = parsed(plcDefs.indexedEntryLog, entries, did);
  let canonical: Awaited<ReturnType<typeof processIndexedEntryLog>>["canonical"];
  try {
    ({ canonical } = await processIndexedEntryLog(did, log));
  } catch (error) {
    throw new DidNotResolvedError(`${did}'s history doesn't verify: ${error instanceof Error ? error.message : String(error)}`);
  }
  const head = canonical.at(-1)?.operation;
  if (head?.type === "plc_tombstone") throw new DidDeactivatedError(`${did} was deactivated`);
  if (!head) throw new DidNotResolvedError(`${did} has no operations`);
  const { alsoKnownAs, verificationMethods, services } = normalizeOp(head);
  return {
    id: did,
    alsoKnownAs,
    verificationMethod: Object.entries(verificationMethods).map(([id, key]) => ({
      id: `${did}#${id}`,
      type: "Multikey",
      controller: did,
      publicKeyMultibase: key.slice("did:key:".length),
    })),
    service: Object.entries(services).map(([id, service]) => ({ id: `#${id}`, type: service.type, serviceEndpoint: service.endpoint })),
  };
}

async function webDocument(did: string, ctx: KernelContext): Promise<DidDocument> {
  if (!isAtprotoWebDid(did)) throw new DidNotResolvedError(`${did} isn't a DID a Ship can call`);
  const url = reachable(webDidToDocumentUrl(did).href, did, ctx);
  const response = await lookUp(() => fetchFederation(url, {
    headers: { accept: "application/json" },
    signal: ctx.requestSignal,
  }, ctx, LOOKUP_TIMEOUT_MS), did, ctx);
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {});
    throw new DidNotResolvedError(`${did} has no document`);
  }
  const document = parsed(identityDefs.didDocument, await readOk(response, MAX_DOCUMENT_BYTES, did, ctx), did);
  if (document.id !== did) throw new DidNotResolvedError(`${did}'s document names another DID`);
  return document;
}

function resolvedDid(did: string, document: DidDocument): ResolvedDid {
  const signingKey = getAtprotoVerificationMaterial(document);
  if (!signingKey) throw new DidNotResolvedError(`${did} has no signing key`);
  try {
    getPublicKeyFromDidController(signingKey);
  } catch {
    throw new DidNotResolvedError(`${did}'s signing key isn't one a Ship can check`);
  }
  return {
    did,
    handle: getAtprotoHandle(document)?.toLowerCase() ?? null,
    signingKey: { type: signingKey.type, publicKeyMultibase: signingKey.publicKeyMultibase },
    shipEndpoint: getAtprotoServiceEndpoint(document, SHIP_SERVICE) ?? null,
    pdsEndpoint: getPdsEndpoint(document) ?? null,
  };
}

/** A host a Ship may not reach names no account it can use, rather than one that is down. */
function reachable(url: string, subject: string, ctx: KernelContext): string {
  try {
    assertFederationTarget(url, ctx);
  } catch (error) {
    throw new DidNotResolvedError(`${subject} isn't publicly reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return url;
}

/** Network failures and directory errors are transient; the caller retries or keeps its cached copy. A cancelled caller gets its own reason back. */
async function lookUp(request: () => Promise<Response>, subject: string, ctx: KernelContext): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    ctx.requestSignal?.throwIfAborted();
    throw new DidDirectoryUnavailableError(`Couldn't look up ${subject}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readOk(response: Response, limit: number, subject: string, ctx: KernelContext): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DidDirectoryUnavailableError(`Looking up ${subject} failed (${response.status})`);
  }
  if (!response.body) throw new DidNotResolvedError(`Looking up ${subject} returned nothing`);
  try {
    const length = response.headers.get("content-length");
    return await bodyToBytes({ stream: response.body, length: length ? Number(length) : undefined }, limit, ctx.requestSignal);
  } catch (error) {
    throw new DidNotResolvedError(`Looking up ${subject} returned an unusable answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A Standard Schema validator, as the atcute schemas expose. */
type Validator<T> = {
  readonly "~standard": {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A Standard Schema validator is the parser that takes arbitrary input.
    validate(value: unknown): { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string }[] } | Promise<object>;
  };
};

/** Parses an answer's JSON with the atcute schema for what it should hold. */
function parsed<T>(schema: Validator<T>, bytes: Uint8Array, subject: string): T {
  let result: ReturnType<Validator<T>["~standard"]["validate"]>;
  try {
    result = schema["~standard"].validate(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new DidNotResolvedError(`Looking up ${subject} returned malformed JSON`);
  }
  if (result instanceof Promise) throw new Error("DID schemas validate synchronously");
  if (result.issues) throw new DidNotResolvedError(`${subject}'s document is invalid: ${result.issues[0]?.message ?? "unknown issue"}`);
  return result.value;
}
