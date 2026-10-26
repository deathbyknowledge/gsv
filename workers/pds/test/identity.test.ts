import { env } from "cloudflare:workers";
import {
  P256PrivateKeyExportable,
  Secp256k1PrivateKey,
  Secp256k1PrivateKeyExportable,
  type DidKeyString,
  type PrivateKey,
} from "@atcute/crypto";
import { PlcClient, signOperation, type CompatibleOperationOrTombstone, type DidPlcString } from "@atcute/did-plc";
import { fromBase16 } from "@atcute/multibase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  genesisHead,
  MAX_ROTATION_KEYS,
  mintIdentity,
  registerGenesis,
  signNextOperation,
  submitNextOperation,
  tombstoneIdentity,
  withOwnerRecoveryKey,
  type IdentityState,
  type RepoIdentity,
} from "../src/host/identity";
import { REPO_REF } from "../src/host/moderation";
import { FakePlcDirectory, isDidPlc } from "./plc";
import { installFakePlc, rejection } from "./support";

const HOUR_MS = 60 * 60_000;
const PAPER = "did:key:zQ3shPaperKeyOfTheOperator";
const HOST = "did:key:zQ3shHostKeyOfTheOperator";
const FIRST = "did:key:zDnaeFirstOwnerKey";
const SECOND = "did:key:zDnaeSecondOwnerKey";
const ELSEWHERE = { type: "AtprotoPersonalDataServer", endpoint: "https://pds.elsewhere.test" };

let plc: FakePlcDirectory;

beforeEach(() => {
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updating a hosted identity", () => {
  it("signs the operation that follows the head of the log and carries every field it doesn't change", async () => {
    const identity = await registered("carried.ship.test", { ship: { type: "GsvShip", endpoint: "https://carried.ship.test" } });
    const known = await genesisHead(identity.genesis);
    const owner = await ownerKey();
    const next = await signNextOperation(env, identity.did, known, (state) => ({ ...state, rotationKeys: [owner, ...state.rotationKeys] }));
    await submitNextOperation(env, identity.did, next);

    const { sig: _sig, rotationKeys, ...carried } = identity.genesis;
    expect(plc.operations(identity.did).at(-1)).toEqual(next.operation);
    expect(next.operation).toMatchObject({ ...carried, prev: known.cid, rotationKeys: [owner, ...rotationKeys] });
    // The head the host records is the one the directory logged.
    expect((await auditLog(identity.did)).at(-1)?.cid).toBe(next.cid);
  });

  it("builds nothing on a log that has moved past the head the host recorded", async () => {
    const identity = await registered("moved.ship.test");
    const known = await genesisHead(identity.genesis);
    const signed = await signNextOperation(env, identity.did, known, (state) => state);
    // Someone else's operation moves the head; here the host's own key signs it.
    await submitAs(identity.did, known, { ...stateOf(identity.genesis), alsoKnownAs: ["at://elsewhere.test"] }, await hostKeypair());

    expect(await rejection(signNextOperation(env, identity.did, known, (state) => state))).toContain("IdentityChanged");
    expect(await rejection(submitNextOperation(env, identity.did, signed))).toContain("IdentityChanged");
    expect(plc.operations(identity.did)).toHaveLength(2);
  });

  it("keeps an identity to PLC's five rotation keys, each listed once", async () => {
    const identity = await registered("limits.ship.test");
    const known = await genesisHead(identity.genesis);
    const owners = await Promise.all(Array.from({ length: MAX_ROTATION_KEYS }, () => ownerKey()));
    const listing = (keys: DidKeyString[]) => signNextOperation(env, identity.did, known, (state) => ({ ...state, rotationKeys: keys }));
    const host = await hostRotationKey();

    expect(MAX_ROTATION_KEYS).toBe(5);
    expect(await rejection(listing([...owners, host]))).toContain("InvalidRotationKeys");
    expect(await rejection(listing([owners[0]!, host, owners[0]!]))).toContain("InvalidRotationKeys");
    expect(await rejection(listing([]))).toContain("InvalidRotationKeys");
    expect((await listing([...owners.slice(1), host])).operation.rotationKeys).toHaveLength(5);
    expect(plc.operations(identity.did)).toHaveLength(1);
  });

  it("ranks the owner's recovery key first, above the operator's paper key and host key", () => {
    expect(withOwnerRecoveryKey([PAPER, HOST], null, FIRST)).toEqual([FIRST, PAPER, HOST]);
    expect(withOwnerRecoveryKey([FIRST, PAPER, HOST], FIRST, SECOND)).toEqual([SECOND, PAPER, HOST]);
    expect(withOwnerRecoveryKey([SECOND, PAPER, HOST], SECOND, null)).toEqual([PAPER, HOST]);
    expect(withOwnerRecoveryKey([HOST], null, FIRST)).toEqual([FIRST, HOST]);
  });
});

describe("an owner's recovery key", () => {
  it("goes above the host's key, and can be replaced and removed", async () => {
    const { repo, did } = await hostedAccount("owner.ship.test");
    const host = await hostRotationKey();
    const first = await ownerKey("p256");
    const second = await ownerKey("secp256k1");

    expect(await repo.setOwnerRecoveryKey(first)).toEqual({ ownerRecoveryKey: first });
    expect(lastRotationKeys(did)).toEqual([first, host]);
    expect(await repo.setOwnerRecoveryKey(second)).toEqual({ ownerRecoveryKey: second });
    expect(lastRotationKeys(did)).toEqual([second, host]);
    // Asking for the key the identity already lists signs nothing.
    expect(await repo.setOwnerRecoveryKey(second)).toEqual({ ownerRecoveryKey: second });
    expect(await repo.setOwnerRecoveryKey(null)).toEqual({ ownerRecoveryKey: null });
    expect(lastRotationKeys(did)).toEqual([host]);
    expect(plc.operations(did)).toHaveLength(4);
  });

  it("must be a P-256 or secp256k1 did:key the identity doesn't already list", async () => {
    const { repo, did } = await hostedAccount("refused.ship.test");
    for (const key of [
      "did:web:owner.example",
      "did:key:not-a-key",
      // An Ed25519 key, which PLC can't verify.
      "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      await hostRotationKey(),
    ]) {
      expect(await rejection(repo.setOwnerRecoveryKey(key))).toContain("InvalidRecoveryKey");
    }
    expect(plc.operations(did)).toHaveLength(1);
  });

  it("isn't changed while the host has the account taken down or is deleting it", async () => {
    const { repo, did } = await hostedAccount("held.ship.test");
    const subject = { $type: REPO_REF, did } as const;
    await repo.updateSubjectStatus({ subject, takedown: { applied: true, ref: "identity-test" } });
    expect(await rejection(repo.setOwnerRecoveryKey(await ownerKey()))).toContain("RepoTakendown");

    await repo.updateSubjectStatus({ subject, takedown: { applied: false } });
    await repo.retire("identity-test-deletion");
    expect(await rejection(repo.setOwnerRecoveryKey(await ownerKey()))).toContain("RepoDeleted");
    expect(plc.operations(did)).toHaveLength(1);
  });

  it("is set once when the directory's answer is lost, and the retry signs nothing more", async () => {
    const { repo, did } = await hostedAccount("retried.ship.test");
    const owner = await ownerKey();
    plc.loseNextResponse();
    expect(await rejection(repo.setOwnerRecoveryKey(owner))).toContain("Network connection lost");

    expect(await repo.setOwnerRecoveryKey(owner)).toEqual({ ownerRecoveryKey: owner });
    expect(plc.operations(did)).toHaveLength(2);
  });

  it("undoes, within 72 hours, what the host key signs after it, and the host builds nothing on that", async () => {
    const { repo, did } = await hostedAccount("undone.ship.test");
    const owner = await P256PrivateKeyExportable.createKeypair();
    const ownerDid = await owner.exportPublicKey("did");
    await repo.setOwnerRecoveryKey(ownerDid);
    const added = (await auditLog(did)).at(-1)!;
    plc.elapse(HOUR_MS);
    await repo.setOwnerRecoveryKey(null);

    // Building on the addition, where the owner's key outranks the host key that signed the removal, undoes it.
    plc.elapse(71 * HOUR_MS);
    await submitAs(did, added, stateOf(added.operation), owner);
    expect(lastRotationKeys(did)).toEqual([ownerDid, await hostRotationKey()]);
    expect(await rejection(repo.setOwnerRecoveryKey(await ownerKey()))).toContain("IdentityChanged");
    expect(plc.operations(did)).toHaveLength(3);
  });

  it("can't undo the host's change once 72 hours have passed", async () => {
    const { repo, did } = await hostedAccount("late.ship.test");
    const owner = await P256PrivateKeyExportable.createKeypair();
    await repo.setOwnerRecoveryKey(await owner.exportPublicKey("did"));
    const added = (await auditLog(did)).at(-1)!;
    await repo.setOwnerRecoveryKey(null);

    plc.elapse(73 * HOUR_MS);
    expect(await rejection(submitAs(did, added, stateOf(added.operation), owner))).toContain("dispute");
    expect(lastRotationKeys(did)).toEqual([await hostRotationKey()]);
  });

  it("can be undone, within 72 hours of its addition, by the operator's paper key", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const withPaper = { ...env, PLC_RECOVERY_KEY: await paper.exportPublicKey("did") };
    const identity = await mintIdentity(withPaper, "paper.ship.test");
    await registerGenesis(withPaper, identity);
    const known = await genesisHead(identity.genesis);
    const owner = await ownerKey();
    const added = await signNextOperation(withPaper, identity.did, known, (state) => ({
      ...state, rotationKeys: withOwnerRecoveryKey(state.rotationKeys, null, owner),
    }));
    await submitNextOperation(withPaper, identity.did, added);
    expect(added.operation.rotationKeys).toEqual([owner, withPaper.PLC_RECOVERY_KEY, await hostRotationKey()]);

    plc.elapse(24 * HOUR_MS);
    await submitAs(identity.did, known, stateOf(identity.genesis), paper);
    expect(plc.operations(identity.did).at(-1)).toMatchObject({ prev: known.cid, rotationKeys: identity.genesis.rotationKeys });
  });
});

describe("a log that keeps the operations an undo nullified", () => {
  it("no longer counts the host's latest operation once an undo nullifies it", async () => {
    const identity = await registered("forked.ship.test");
    const owner = await P256PrivateKeyExportable.createKeypair();
    const ownerDid = await owner.exportPublicKey("did");
    const added = await signNextOperation(env, identity.did, await genesisHead(identity.genesis), (state) => ({
      ...state, rotationKeys: withOwnerRecoveryKey(state.rotationKeys, null, ownerDid),
    }));
    await submitNextOperation(env, identity.did, added);
    const removed = await signNextOperation(env, identity.did, added, (state) => ({
      ...state, rotationKeys: withOwnerRecoveryKey(state.rotationKeys, ownerDid, null),
    }));
    plc.loseNextResponse();
    expect(await rejection(submitNextOperation(env, identity.did, removed))).toContain("Network connection lost");

    // The owner's key builds on the addition, which nullifies the removal the directory logged.
    plc.elapse(HOUR_MS);
    await submitAs(identity.did, added, stateOf(added.operation), owner);
    const undo = await head(identity.did);
    expect(await nullified(identity.did)).toEqual([removed.cid]);

    // The retry finds the removal no longer in force, and the tombstone follows the undo.
    expect(await rejection(submitNextOperation(env, identity.did, removed))).toContain("IdentityChanged");
    await tombstoneIdentity(env, identity.did);
    expect(plc.operations(identity.did).at(-1)).toMatchObject({ type: "plc_tombstone", prev: undo.cid });
  });

  it("tombstones the paper key's repair of a leaked key's move, and the paper key can undo that tombstone", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const withPaper = { ...env, PLC_RECOVERY_KEY: await paper.exportPublicKey("did") };
    const identity = await mintIdentity(withPaper, "repaired.ship.test");
    await registerGenesis(withPaper, identity);
    const known = await genesisHead(identity.genesis);
    const moved = { ...stateOf(identity.genesis), services: { ...identity.genesis.services, atproto_pds: ELSEWHERE } };
    await submitAs(identity.did, known, moved, await hostKeypair());
    const leaked = await head(identity.did);

    // Within 72 hours the paper key builds on the genesis, which nullifies the move.
    plc.elapse(HOUR_MS);
    await submitAs(identity.did, known, stateOf(identity.genesis), paper);
    const repair = await head(identity.did);
    expect(await nullified(identity.did)).toEqual([leaked.cid]);

    // The repair names this host again, so the tombstone follows it; the paper key still outranks the host's.
    await tombstoneIdentity(withPaper, identity.did);
    const tombstone = await head(identity.did);
    expect(tombstone.operation).toMatchObject({ type: "plc_tombstone", prev: repair.cid });
    await submitAs(identity.did, repair, stateOf(identity.genesis), paper);
    expect(await nullified(identity.did)).toEqual([leaked.cid, tombstone.cid]);
  });
});

async function registered(handle: string, services: Parameters<typeof mintIdentity>[2] = {}): Promise<RepoIdentity> {
  const identity = await mintIdentity(env, handle, services);
  await registerGenesis(env, identity);
  return identity;
}

async function hostedAccount(handle: string) {
  const name = crypto.randomUUID();
  const repo = env.REPOS.getByName(name);
  const { did } = await repo.create(handle, `installations/${name}/`);
  if (!isDidPlc(did)) throw new Error(`Expected a did:plc, not ${did}`);
  return { repo, did };
}

async function ownerKey(kind: "p256" | "secp256k1" = "p256"): Promise<DidKeyString> {
  const keypair = kind === "p256" ? await P256PrivateKeyExportable.createKeypair() : await Secp256k1PrivateKeyExportable.createKeypair();
  return keypair.exportPublicKey("did");
}

async function hostKeypair(): Promise<PrivateKey> {
  return Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
}

async function hostRotationKey(): Promise<DidKeyString> {
  return (await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY))).exportPublicKey("did");
}

function auditLog(did: DidPlcString) {
  return new PlcClient({ serviceUrl: env.PLC_URL }).getAuditLog(did);
}

/** The entry in force at the head of the DID's log. */
async function head(did: DidPlcString) {
  const entry = (await auditLog(did)).filter((logged) => !logged.nullified).at(-1);
  if (!entry) throw new Error(`Expected a log for ${did}`);
  return entry;
}

/** The CIDs of the operations in the DID's audit log that a later one nullified, oldest first. */
async function nullified(did: DidPlcString): Promise<string[]> {
  return (await auditLog(did)).filter((entry) => entry.nullified).map((entry) => entry.cid);
}

function lastRotationKeys(did: string): DidKeyString[] {
  const last = plc.operations(did).at(-1);
  if (last?.type !== "plc_operation") throw new Error("Expected the DID's last operation to be a plc_operation");
  return last.rotationKeys;
}

/** What an operation states about the identity, ready to sign again on another head. */
function stateOf(operation: CompatibleOperationOrTombstone): IdentityState {
  if (operation.type !== "plc_operation") throw new Error("Expected a plc_operation");
  const { sig: _sig, prev: _prev, type: _type, ...state } = operation;
  return state;
}

/** Signs and submits an operation on `base` with another key than the host's, as a sheet or the paper key would. */
async function submitAs(did: DidPlcString, base: { cid: string }, state: IdentityState, key: PrivateKey): Promise<void> {
  await new PlcClient({ serviceUrl: env.PLC_URL }).submitOperation(did, await signOperation({ type: "plc_operation", prev: base.cid, ...state }, key));
}
