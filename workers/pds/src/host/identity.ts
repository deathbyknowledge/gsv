import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { parseDidKey, Secp256k1PrivateKey, Secp256k1PrivateKeyExportable, type DidKeyString } from "@atcute/crypto";
import {
  deriveDidFromGenesisOp,
  normalizeOp,
  PlcClient,
  PlcClientError,
  processIndexedEntryLog,
  signOperation,
  signTombstone,
  validateIncomingOp,
  type CompatibleOperationOrTombstone,
  type DidPlcString,
  type Operation,
  type Service,
  type UnsignedOperation,
} from "@atcute/did-plc";
import { fromBase16 } from "@atcute/multibase";
import type { HostEnv } from "./env";

/** PLC's limit on an identity's rotation keys; the validator the host uses allows ten, so the host checks five itself. */
export const MAX_ROTATION_KEYS = 5;

/**
 * Where an owner's recovery key ranks among an identity's rotation keys: first,
 * above the operator's paper key and the host's key. Neither can then undo what
 * the owner's key signs, and for 72 hours it can undo what either of them signs.
 */
const OWNER_RECOVERY_KEY_RANK = 0;

/** A hosted account's did:plc, handle and repository signing key. */
export type RepoIdentity = {
  did: DidPlcString;
  handle: string;
  /** Hex secp256k1 key that signs repository commits. */
  signingKey: string;
  /** Public form of the signing key, published as the DID's atproto verification method. */
  signingDidKey: DidKeyString;
  /** Signed genesis operation the DID derives from. */
  genesis: Operation;
};

/** A DID's operation in force at the head of its log, with the CID the operation after it names as `prev`. */
export type IdentityHead = { cid: string; operation: Operation };

/** What an operation states about an identity: every field an update carries forward or changes. */
export type IdentityState = Omit<UnsignedOperation, "type" | "prev">;

/**
 * Why a host steps aside for a change to its identity: its own key signed an
 * operation the host never submitted, a key it doesn't trust signed one, or
 * the identity no longer names this host as its PDS with the account's signing key.
 */
export type StepAside = "leaked-key" | "untrusted-key" | "moved";

/** What a host makes of the head of its DID's log. */
export type HeadCheck =
  /** The head is an operation the host signed or adopted. */
  | { outcome: "own" }
  /** Keys the host trusts signed every operation since its own, and the identity still names this host: the host follows the head. */
  | { outcome: "adopted"; head: IdentityHead; signedBy: DidKeyString }
  /** The host steps aside for the head, because of `operation`. */
  | { outcome: StepAside; head: string; operation: string; signedBy: DidKeyString };

/** The directory's log has moved past the head the host recorded, so someone else changed the identity. */
export class IdentityChangedError extends Error {
  constructor(did: string) {
    super(`IdentityChanged: ${did} has changed in its directory since this host last signed for it`);
  }
}

/** The DID document a did:plc directory serves for a hosted account. */
export type DidDocument = {
  "@context": string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: Array<{ id: string; type: string; controller: string; publicKeyMultibase: string }>;
  service: Array<{ id: string; type: string; serviceEndpoint: string }>;
};

/**
 * Creates a did:plc that names this host as its PDS, plus any other services
 * the account offers. The host's rotation key signs it; a configured recovery
 * key outranks the rotation key, so its holder can reverse a host operation
 * during PLC's recovery window.
 */
export async function mintIdentity(env: HostEnv, handle: string, services: Record<string, Service> = {}): Promise<RepoIdentity> {
  const signing = await Secp256k1PrivateKeyExportable.createKeypair();
  const rotation = await hostRotationKey(env);
  const hostKey = await rotation.exportPublicKey("did");
  const signingDidKey = await signing.exportPublicKey("did");
  const genesis = await signOperation({
    type: "plc_operation",
    prev: null,
    rotationKeys: env.PLC_RECOVERY_KEY ? [recoveryKey(env.PLC_RECOVERY_KEY), hostKey] : [hostKey],
    verificationMethods: { atproto: signingDidKey },
    alsoKnownAs: [`at://${handle}`],
    services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: env.PDS_ORIGIN }, ...services },
  }, rotation);
  validateIncomingOp(genesis);
  return {
    did: await deriveDidFromGenesisOp(genesis),
    handle,
    signingKey: await signing.exportPrivateKey("rawHex"),
    signingDidKey,
    genesis,
  };
}

/**
 * Submits an identity's genesis operation. A retry after a submission whose
 * response was lost finds the same operation already logged, and succeeds.
 */
export async function registerGenesis(env: HostEnv, identity: RepoIdentity): Promise<void> {
  const plc = new PlcClient({ serviceUrl: env.PLC_URL });
  try {
    await plc.submitOperation(identity.did, identity.genesis);
  } catch (error) {
    if (!(error instanceof PlcClientError)) throw error;
    const logged = await plc.getOperationLog(identity.did).catch(() => null);
    if (logged?.at(0)?.sig !== identity.genesis.sig) throw error;
  }
}

/** The head an identity's genesis operation makes. */
export async function genesisHead(genesis: Operation): Promise<IdentityHead> {
  return { cid: await operationCid(genesis), operation: genesis };
}

/**
 * Signs, with the host's rotation key, the operation that follows `known`,
 * the head the host recorded for the DID. `change` receives every field
 * `known` states and returns the next state. Rotation keys follow PLC's rules:
 * one to five did:keys of the kinds it verifies, none listed twice. A log that
 * has moved past `known` means someone else changed the identity, and the host
 * builds nothing on it.
 */
export async function signNextOperation(
  env: HostEnv,
  did: DidPlcString,
  known: IdentityHead,
  change: (state: IdentityState) => IdentityState,
): Promise<IdentityHead> {
  const head = await lastEntry(new PlcClient({ serviceUrl: env.PLC_URL }), did);
  if (head?.cid !== known.cid) throw new IdentityChangedError(did);
  const { type: _type, prev: _prev, sig: _sig, ...state } = known.operation;
  const next = change(state);
  checkRotationKeys(next.rotationKeys);
  const operation = await signOperation({ ...next, type: "plc_operation", prev: known.cid }, await hostRotationKey(env));
  validateIncomingOp(operation);
  return { cid: await operationCid(operation), operation };
}

/**
 * Submits an operation `signNextOperation` signed, and returns once the
 * directory has it in force. A retry after a submission whose response was
 * lost finds it there and succeeds. A log that has moved past the operation it
 * follows to anything else means someone else changed the identity.
 */
export async function submitNextOperation(env: HostEnv, did: DidPlcString, next: IdentityHead): Promise<void> {
  const plc = new PlcClient({ serviceUrl: env.PLC_URL });
  const inForce = await entriesInForce(plc, did);
  if (inForce.some((entry) => entry.cid === next.cid)) return;
  if (inForce.at(-1)?.cid !== next.operation.prev) throw new IdentityChangedError(did);
  try {
    await plc.submitOperation(did, next.operation);
  } catch (error) {
    if (!(error instanceof PlcClientError)) throw error;
    if (!(await entriesInForce(plc, did)).some((entry) => entry.cid === next.cid)) throw error;
  }
}

/**
 * The rotation keys with the owner's recovery key `next` at its rank in place
 * of `previous`. A null `previous` adds `next`, and a null `next` removes
 * `previous`. The operator's keys keep their order.
 */
export function withOwnerRecoveryKey(rotationKeys: readonly DidKeyString[], previous: DidKeyString | null, next: DidKeyString | null): DidKeyString[] {
  const operators = rotationKeys.filter((key) => key !== previous);
  return next === null ? operators : operators.toSpliced(OWNER_RECOVERY_KEY_RANK, 0, next);
}

/** An owner's recovery key: a did:key of a kind PLC verifies, P-256 or secp256k1. */
export function parseOwnerRecoveryKey(value: string): DidKeyString {
  if (!isDidKey(value) || !isVerifiable(value)) throw new Error("InvalidRecoveryKey: a recovery key is a P-256 or secp256k1 did:key");
  return value;
}

/** The owner's recovery key that rotation keys list at its rank, unless the key there is one of the operator's. */
export function ownerRecoveryKeyOf(rotationKeys: readonly DidKeyString[], operatorKeys: readonly string[]): DidKeyString | null {
  const key = rotationKeys[OWNER_RECOVERY_KEY_RANK];
  return key !== undefined && !operatorKeys.includes(key) ? key : null;
}

/**
 * Reads the DID's log and judges its head by every operation in force since
 * the newest of `known`, the CIDs of the operations the host signed or
 * adopted, genesis first; an undo can nullify the latest. The host trusts the
 * keys that operation ranks above its own key. Each later operation must be
 * signed by one of them, and the host then trusts the keys that operation
 * ranks above its own, or all of them once its key is gone. An operation the
 * host's key signed is one this host never submitted, so the key has leaked.
 */
export async function checkHead(env: HostEnv, did: DidPlcString, known: readonly string[], signingKey: DidKeyString): Promise<HeadCheck> {
  const { canonical } = await processIndexedEntryLog(did, await new PlcClient({ serviceUrl: env.PLC_URL }).getAuditLog(did));
  const start = canonical.findLastIndex((entry) => known.includes(entry.cid));
  const base = canonical[start];
  const head = canonical.at(-1);
  if (!base || !head) throw new Error(`The directory's log for ${did} doesn't begin with this host's genesis`);
  if (base === head) return { outcome: "own" };
  const hostKey = await (await hostRotationKey(env)).exportPublicKey("did");
  let trusted = keysAboveHost(base.operation, hostKey);
  for (const entry of canonical.slice(start + 1)) {
    if (!trusted.includes(entry.signedBy)) {
      const outcome = entry.signedBy === hostKey ? "leaked-key" : "untrusted-key";
      return { outcome, head: head.cid, operation: entry.cid, signedBy: entry.signedBy };
    }
    trusted = keysAboveHost(entry.operation, hostKey);
  }
  const state = head.operation;
  if (state.type !== "plc_operation" || !namesHost(state, env.PDS_ORIGIN) || state.verificationMethods.atproto !== signingKey) {
    return { outcome: "moved", head: head.cid, operation: head.cid, signedBy: head.signedBy };
  }
  return { outcome: "adopted", head: { cid: head.cid, operation: state }, signedBy: head.signedBy };
}

/**
 * Tombstones a DID so the directory stops resolving it. The directory keeps
 * the DID's operation log, which names its handle and host. A DID the
 * directory never logged, one already tombstoned, and one whose rotation keys
 * no longer include the host's need nothing. Nor does one that names another
 * host as its PDS: it has moved there, and a tombstone would end it.
 */
export async function tombstoneIdentity(env: HostEnv, did: DidPlcString): Promise<void> {
  const plc = new PlcClient({ serviceUrl: env.PLC_URL });
  const last = await lastEntry(plc, did);
  if (!last || last.operation.type === "plc_tombstone") return;
  const rotation = await hostRotationKey(env);
  const hostKey = await rotation.exportPublicKey("did");
  if (last.operation.type !== "plc_operation" || !last.operation.rotationKeys.includes(hostKey)) return;
  if (!namesHost(last.operation, env.PDS_ORIGIN)) return;
  const tombstone = await signTombstone({ type: "plc_tombstone", prev: last.cid }, rotation);
  try {
    await plc.submitOperation(did, tombstone);
  } catch (error) {
    if (!(error instanceof PlcClientError)) throw error;
    if ((await lastEntry(plc, did))?.operation.type !== "plc_tombstone") throw error;
  }
}

/** The DID's latest operation that is still in force, or null if the directory never logged the DID. */
async function lastEntry(plc: PlcClient, did: DidPlcString) {
  return (await entriesInForce(plc, did)).at(-1) ?? null;
}

/** The DID's operations that are still in force, genesis first; none if the directory never logged the DID. */
async function entriesInForce(plc: PlcClient, did: DidPlcString) {
  try {
    return (await plc.getAuditLog(did)).filter((entry) => !entry.nullified);
  } catch (error) {
    if (error instanceof PlcClientError && error.status === 404) return [];
    throw error;
  }
}

/** The CID a directory names an operation by, which the operation after it gives as `prev`. */
async function operationCid(operation: Operation): Promise<string> {
  return toString(await create(CODEC_DCBOR, encode(operation)));
}

function hostRotationKey(env: HostEnv): Promise<Secp256k1PrivateKey> {
  return Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
}

/** The keys an operation ranks above the host's, which the host trusts to change the identity next: all of them once the host's key is gone. */
function keysAboveHost(operation: CompatibleOperationOrTombstone, hostKey: DidKeyString): DidKeyString[] {
  if (operation.type === "plc_tombstone") return [];
  const { rotationKeys } = normalizeOp(operation);
  const rank = rotationKeys.indexOf(hostKey);
  return rank === -1 ? rotationKeys : rotationKeys.slice(0, rank);
}

/** Whether an operation names this host as the identity's PDS. */
function namesHost(operation: Operation, origin: string): boolean {
  const endpoint = operation.services.atproto_pds?.endpoint;
  return endpoint !== undefined && URL.parse(endpoint)?.origin === new URL(origin).origin;
}

function checkRotationKeys(keys: readonly string[]): void {
  if (keys.length === 0 || keys.length > MAX_ROTATION_KEYS) {
    throw new Error(`InvalidRotationKeys: an identity lists one to ${MAX_ROTATION_KEYS} rotation keys`);
  }
  if (new Set(keys).size !== keys.length) throw new Error("InvalidRotationKeys: an identity lists each rotation key once");
  for (const key of keys) {
    if (!isDidKey(key) || !isVerifiable(key)) throw new Error(`InvalidRotationKeys: PLC can't verify ${key}`);
  }
}

/** The DID document a directory derives from the identity's genesis operation. */
export function didDocument(identity: RepoIdentity): DidDocument {
  const { alsoKnownAs, verificationMethods, services } = identity.genesis;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      "https://w3id.org/security/suites/secp256k1-2019/v1",
    ],
    id: identity.did,
    alsoKnownAs,
    verificationMethod: Object.entries(verificationMethods).map(([id, key]) => ({
      id: `${identity.did}#${id}`,
      type: "Multikey",
      controller: identity.did,
      publicKeyMultibase: key.slice("did:key:".length),
    })),
    service: Object.entries(services).map(([id, service]) => ({ id: `#${id}`, type: service.type, serviceEndpoint: service.endpoint })),
  };
}

function recoveryKey(value: string): DidKeyString {
  if (!isDidKey(value)) throw new Error("PLC_RECOVERY_KEY must be a did:key");
  parseDidKey(value);
  return value;
}

function isDidKey(value: string): value is DidKeyString {
  return value.startsWith("did:key:");
}

/** Whether a did:key is one of the kinds PLC verifies: P-256 or secp256k1. */
function isVerifiable(key: DidKeyString): boolean {
  try {
    parseDidKey(key);
    return true;
  } catch {
    return false;
  }
}
