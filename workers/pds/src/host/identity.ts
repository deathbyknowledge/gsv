import { parseDidKey, Secp256k1PrivateKey, Secp256k1PrivateKeyExportable, type DidKeyString } from "@atcute/crypto";
import {
  deriveDidFromGenesisOp,
  PlcClient,
  PlcClientError,
  signOperation,
  signTombstone,
  validateIncomingOp,
  type DidPlcString,
  type Operation,
  type Service,
} from "@atcute/did-plc";
import { fromBase16 } from "@atcute/multibase";
import type { HostEnv } from "./env";

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
  const rotation = await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
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

/**
 * Tombstones a DID so the directory stops resolving it. The directory keeps
 * the DID's operation log, which names its handle and host. A DID the
 * directory never logged, one already tombstoned, and one whose rotation keys
 * no longer include the host's need nothing.
 */
export async function tombstoneIdentity(env: HostEnv, did: DidPlcString): Promise<void> {
  const plc = new PlcClient({ serviceUrl: env.PLC_URL });
  const last = await lastEntry(plc, did);
  if (!last || last.operation.type === "plc_tombstone") return;
  const rotation = await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
  const hostKey = await rotation.exportPublicKey("did");
  if (last.operation.type !== "plc_operation" || !last.operation.rotationKeys.includes(hostKey)) return;
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
  try {
    return (await plc.getAuditLog(did)).filter((entry) => !entry.nullified).at(-1) ?? null;
  } catch (error) {
    if (error instanceof PlcClientError && error.status === 404) return null;
    throw error;
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
