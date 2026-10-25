import { runInDurableObject } from "cloudflare:test";
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
import { z } from "zod";
import type { PdsEnv } from "../src/gsv/env";
import { AUDIT_PAGE } from "../src/gsv/identity-audit";
import { signOperatorToken, type OperatorRequest } from "../src/gsv/operator-token";
import type { IdentityState } from "../src/host/identity";
import { HostedRepo } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory, isDidPlc } from "./plc";
import { deliver, errorOf, installFakePlc, rejection } from "./support";

const HOUR_MS = 60 * 60_000;
const NOTE = "com.example.note";
const SHIP_CALL = { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" };
const ELSEWHERE = { type: "AtprotoPersonalDataServer", endpoint: "https://pds.elsewhere.test" };

// What the audit may say of an identity: nothing but its public DID, handle and log.
const stepAside = z.strictObject({
  did: z.string(),
  handle: z.string(),
  at: z.number(),
  outcome: z.enum(["leaked-key", "untrusted-key", "moved"]),
  head: z.string(),
  operation: z.string(),
  signedBy: z.string(),
});
const report = z.strictObject({
  checked: z.number(),
  steppedAside: z.array(stepAside),
  undoneLeaks: z.array(z.strictObject({ did: z.string(), handle: z.string(), nullifiedAt: z.string() })),
  unread: z.array(z.string()),
  cursor: z.optional(z.string()),
  retryAfter: z.optional(z.nullable(z.number())),
});

let plc: FakePlcDirectory;
let notes = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a hosted identity someone else changes", () => {
  it("is refused once the host's own key signs an operation the host never submitted", async () => {
    const { repo, did } = await hostedAccount("leaked.ship.test");
    const owner = await sheet();
    await repo.setOwnerRecoveryKey(owner.did);
    const known = await head(did);
    const host = await hostKey();

    // The leaked key moves the host's key above the person's sheet and leaves the PDS and signing key as they were.
    await submitAs(did, known, { ...stateOf(known.operation), rotationKeys: [host, owner.did] }, await hostKeypair());
    const leaked = await head(did);
    anHourPasses();

    expect(await rejection(write(repo))).toContain("IdentityChanged");
    expect(await rejection(repo.serviceAuth(SHIP_CALL))).toContain("IdentityChanged");
    expect(await rejection(repo.setOwnerRecoveryKey((await sheet()).did))).toContain("IdentityChanged");
    expect((await repo.identityCheck())?.steppedAside).toMatchObject({
      outcome: "leaked-key", head: leaked.cid, operation: leaked.cid, signedBy: host,
    });
  });

  it("is refused after a leaked key's two steps: one ranks another key above the host's, which then signs", async () => {
    const { repo, did } = await hostedAccount("two-step.ship.test");
    const owner = await sheet();
    await repo.setOwnerRecoveryKey(owner.did);
    const known = await head(did);
    const host = await hostKey();
    const attacker = await Secp256k1PrivateKeyExportable.createKeypair();
    const attackerKey = await attacker.exportPublicKey("did");

    await submitAs(did, known, { ...stateOf(known.operation), rotationKeys: [attackerKey, owner.did, host] }, await hostKeypair());
    const first = await head(did);
    // The head is now signed by a key the operation before it ranks above the host's.
    await submitAs(did, first, { ...stateOf(first.operation), rotationKeys: [attackerKey, host] }, attacker);
    const second = await head(did);
    anHourPasses();

    expect(await rejection(write(repo))).toContain("IdentityChanged");
    expect((await repo.identityCheck())?.steppedAside).toMatchObject({
      outcome: "leaked-key", head: second.cid, operation: first.cid, signedBy: host,
    });
  });

  it("is refused once the person's sheet moves it to another PDS or replaces its signing key", async () => {
    const signingKey = await (await Secp256k1PrivateKeyExportable.createKeypair()).exportPublicKey("did");
    for (const [index, change] of [
      (state: IdentityState) => ({ ...state, services: { ...state.services, atproto_pds: ELSEWHERE } }),
      (state: IdentityState) => ({ ...state, verificationMethods: { atproto: signingKey } }),
    ].entries()) {
      const { repo, did } = await hostedAccount(`moved-${index}.ship.test`);
      const owner = await sheet();
      await repo.setOwnerRecoveryKey(owner.did);
      const known = await head(did);
      await submitAs(did, known, change(stateOf(known.operation)), owner.key);
      const moved = await head(did);
      anHourPasses();

      expect(await rejection(write(repo))).toContain("IdentityChanged");
      expect((await repo.identityCheck())?.steppedAside).toMatchObject({
        outcome: "moved", head: moved.cid, operation: moved.cid, signedBy: owner.did,
      });
    }
  });

  it("is followed after the person's old sheet undoes a swap the host signed", async () => {
    const { repo, did } = await hostedAccount("undone-swap.ship.test");
    const old = await sheet();
    await repo.setOwnerRecoveryKey(old.did);
    const before = await head(did);
    await repo.setOwnerRecoveryKey((await sheet()).did);
    const swap = await head(did);

    // Building on the operation before the swap, the old sheet nullifies it; the log keeps the swap, flagged.
    await submitAs(did, before, stateOf(before.operation), old.key);
    const undone = await head(did);
    expect(await nullified(did)).toEqual([swap.cid]);
    anHourPasses();

    await write(repo);
    expect(await repo.identityCheck()).toMatchObject({
      steppedAside: null, events: [{ outcome: "adopted", head: undone.cid, operation: undone.cid, signedBy: old.did }],
    });
    // The host builds on what it adopted, and replaces the old sheet rather than keeping it.
    const next = await sheet();
    expect(await repo.setOwnerRecoveryKey(next.did)).toEqual({ ownerRecoveryKey: next.did });
    expect(lastRotationKeys(did)).toEqual([next.did, await hostKey()]);
    expect((await head(did)).operation).toMatchObject({ prev: undone.cid });
  });

  it("is followed from the host's newest operation still in force when an undo nullifies its latest", async () => {
    const { repo, did } = await hostedAccount("surviving.ship.test");
    const first = await sheet();
    await repo.setOwnerRecoveryKey(first.did);
    const surviving = await head(did);
    await repo.setOwnerRecoveryKey((await sheet()).did);
    const firstSwap = await head(did);
    await repo.setOwnerRecoveryKey((await sheet()).did);
    const secondSwap = await head(did);

    // The first sheet undoes both of the host's later swaps at once.
    await submitAs(did, surviving, stateOf(surviving.operation), first.key);
    const undone = await head(did);
    expect(await nullified(did)).toEqual([firstSwap.cid, secondSwap.cid]);
    anHourPasses();

    await write(repo);
    expect(await repo.identityCheck()).toMatchObject({
      steppedAside: null, events: [{ outcome: "adopted", head: undone.cid, signedBy: first.did }],
    });
  });

  it("is followed after the person rotates their own sheet and then uses the new one", async () => {
    const { repo, did } = await hostedAccount("rotated.ship.test");
    const first = await sheet();
    await repo.setOwnerRecoveryKey(first.did);
    const known = await head(did);
    const host = await hostKey();
    const second = await sheet();
    const backup = await sheet();

    await submitAs(did, known, { ...stateOf(known.operation), rotationKeys: [second.did, host] }, first.key);
    const rotated = await head(did);
    // Only the new sheet now ranks above the host's key; it adds a backup key.
    await submitAs(did, rotated, { ...stateOf(rotated.operation), rotationKeys: [second.did, backup.did, host] }, second.key);
    const latest = await head(did);
    anHourPasses();

    await write(repo);
    expect(await repo.identityCheck()).toMatchObject({
      steppedAside: null, events: [{ outcome: "adopted", head: latest.cid, signedBy: second.did }],
    });
  });

  it("is followed after the operator's paper key undoes a leaked key's operation", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const { repo, did } = await hostedAccount("repaired.ship.test", await paper.exportPublicKey("did"));
    const genesis = await head(did);
    await submitAs(did, genesis, { ...stateOf(genesis.operation), alsoKnownAs: ["at://taken.example"] }, await hostKeypair());
    const leaked = await head(did);
    anHourPasses();
    expect(await rejection(write(repo))).toContain("IdentityChanged");

    // Within 72 hours the paper key, which ranks above the host's, builds on the genesis and nullifies the leak.
    await submitAs(did, genesis, stateOf(genesis.operation), paper);
    const repaired = await head(did);
    expect(await nullified(did)).toEqual([leaked.cid]);
    anHourPasses();

    await write(repo);
    const check = await repo.identityCheck();
    expect(check?.steppedAside).toBeNull();
    expect(check?.events.map(({ outcome }) => outcome)).toEqual(["leaked-key", "adopted"]);
    expect(check?.events.at(-1)).toMatchObject({ head: repaired.cid, signedBy: await paper.exportPublicKey("did") });
    // The host's next operation follows the repair, not the leak it nullified.
    await repo.setOwnerRecoveryKey((await sheet()).did);
    expect((await head(did)).operation).toMatchObject({ prev: repaired.cid });
  });
});

describe("the host's reads of its DID's log", () => {
  it("happen at most once an hour, before a write or a Ship call", async () => {
    const { repo, did } = await hostedAccount("hourly.ship.test");
    const reads = plc.reads(did);
    await write(repo);
    await write(repo);
    await repo.serviceAuth(SHIP_CALL);
    expect(plc.reads(did)).toBe(reads + 1);

    anHourPasses();
    await repo.serviceAuth(SHIP_CALL);
    await write(repo);
    expect(plc.reads(did)).toBe(reads + 2);
  });

  it("leave the host serving when the directory can't be read, and try again an hour later", async () => {
    const { repo, did } = await hostedAccount("unreadable.ship.test");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network connection lost."));

    await write(repo);
    expect(logged).toHaveBeenCalledExactlyOnceWith("Identity check failed; the host reads its DID's log again in an hour", expect.any(TypeError));
    const reads = plc.reads(did);
    await write(repo);
    expect(plc.reads(did)).toBe(reads);
    anHourPasses();
    await write(repo);
    expect(plc.reads(did)).toBe(reads + 1);
  });
});

describe("the operator's identity audit", () => {
  beforeEach(() => {
    // The audit's pause before each read passes at once; the pacing test reads how long each asked for.
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });

  it("reads every hosted identity's log again and reports only those the host steps aside for", async () => {
    const clean = await hostedAccount("clean.ship.test");
    const leaked = await hostedAccount("audited.ship.test");
    await deliver(clean.repo);
    await deliver(leaked.repo);
    await write(clean.repo);
    await write(leaked.repo);
    const known = await head(leaked.did);
    await submitAs(leaked.did, known, { ...stateOf(known.operation), alsoKnownAs: ["at://taken.example"] }, await hostKeypair());
    const changed = await head(leaked.did);

    // No hour has passed: the audit reads each log again, a page at a time.
    const pages = [report.parse(await (await audit({ limit: 1 })).json())];
    while (pages.at(-1)?.cursor) pages.push(report.parse(await (await audit({ limit: 1, cursor: pages.at(-1)?.cursor })).json()));
    const ours = ({ did }: { did: string }) => did === clean.did || did === leaked.did;
    const reported = pages.flatMap((page) => page.steppedAside).filter(ours);

    expect(pages.every((page) => page.checked <= 1)).toBe(true);
    expect(pages.flatMap((page) => page.unread).filter((did) => ours({ did }))).toEqual([]);
    expect(reported).toEqual([{
      did: leaked.did, handle: "audited.ship.test", at: Date.now(), outcome: "leaked-key",
      head: changed.cid, operation: changed.cid, signedBy: await hostKey(),
    }]);
    expect(await rejection(write(leaked.repo))).toContain("IdentityChanged");
    await write(clean.repo);
  });

  it("reads one identity a second unless the operator asks for up to ten", async () => {
    await deliver((await hostedAccount("paced.ship.test")).repo);
    await audit({ limit: 1 });
    await audit({ limit: 1, readsPerSecond: 10 });
    expect(vi.mocked(scheduler.wait).mock.calls).toEqual([[1000], [100]]);
    expect(await errorOf(audit({ limit: 1, readsPerSecond: 11 }))).toBe("InvalidRequest");
  });

  it("ends a page where the directory answers 429, with the wait it asks for, and resumes there", async () => {
    await deliver((await hostedAccount("busy.ship.test")).repo);
    await deliver((await hostedAccount("busier.ship.test")).repo);
    const firstPage = report.parse(await (await audit({ limit: 1 })).json());

    // A refused first read leaves the page empty, and the next one starts where it did.
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
    expect(report.parse(await (await audit({ limit: 1 })).json())).toEqual({ checked: 0, steppedAside: [], undoneLeaks: [], unread: [], retryAfter: 30 });

    // A refused second read ends the page after the first, whether the wait comes as an HTTP date or not at all.
    const refusals: Array<{ headers: Record<string, string>; retryAfter: number | null }> = [
      { headers: { "Retry-After": new Date(Date.now() + 45_000).toUTCString() }, retryAfter: 45 },
      { headers: {}, retryAfter: null },
    ];
    for (const { headers, retryAfter } of refusals) {
      vi.mocked(fetch)
        .mockImplementationOnce(async (input, init) => plc.handle(new Request(input, init)))
        .mockResolvedValueOnce(new Response(null, { status: 429, headers }));
      expect(report.parse(await (await audit({ limit: 2 })).json())).toEqual({ ...firstPage, retryAfter });
    }
    const resumed = report.parse(await (await audit({ limit: 1, cursor: firstPage.cursor })).json());
    expect(resumed.checked).toBe(1);
    expect(resumed.retryAfter).toBeUndefined();
  });

  it("reports a leak of the host's key that the person's sheet undid, while the host follows the undo", async () => {
    const { repo, did } = await hostedAccount("undone-leak.ship.test");
    await deliver(repo);
    const owner = await sheet();
    await repo.setOwnerRecoveryKey(owner.did);
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), rotationKeys: [await hostKey(), owner.did] }, await hostKeypair());
    // The sheet builds on the host's operation and nullifies the leaked key's.
    await submitAs(did, known, stateOf(known.operation), owner.key);
    const undo = await head(did);

    expect(await findings(did)).toEqual({
      steppedAside: [], unread: [], undoneLeaks: [{ did, handle: "undone-leak.ship.test", nullifiedAt: undo.createdAt }],
    });
  });

  it("doesn't report an operation of the host's own that the person's sheet undid", async () => {
    const { repo, did } = await hostedAccount("own-undone.ship.test");
    await deliver(repo);
    const old = await sheet();
    await repo.setOwnerRecoveryKey(old.did);
    const before = await head(did);
    await repo.setOwnerRecoveryKey((await sheet()).did);
    const swap = await head(did);
    await submitAs(did, before, stateOf(before.operation), old.key);
    expect(await nullified(did)).toEqual([swap.cid]);

    expect(await findings(did)).toEqual({ steppedAside: [], unread: [], undoneLeaks: [] });
  });

  it("doesn't report an operation another key signed that the person's sheet undid", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const { repo, did } = await hostedAccount("paper-undone.ship.test", await paper.exportPublicKey("did"));
    await deliver(repo);
    const owner = await sheet();
    await repo.setOwnerRecoveryKey(owner.did);
    const known = await head(did);
    await submitAs(did, known, stateOf(known.operation), paper);
    const papered = await head(did);
    await submitAs(did, known, stateOf(known.operation), owner.key);
    expect(await nullified(did)).toEqual([papered.cid]);

    expect(await findings(did)).toEqual({ steppedAside: [], unread: [], undoneLeaks: [] });
  });

  it("still reports the leak after the host follows the operator's paper-key repair", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const { repo, did } = await hostedAccount("paper-audited.ship.test", await paper.exportPublicKey("did"));
    await deliver(repo);
    const genesis = await head(did);
    await submitAs(did, genesis, { ...stateOf(genesis.operation), alsoKnownAs: ["at://taken.example"] }, await hostKeypair());
    expect(await rejection(write(repo))).toContain("IdentityChanged");
    await submitAs(did, genesis, stateOf(genesis.operation), paper);
    const repaired = await head(did);
    anHourPasses();
    await write(repo);

    expect(await findings(did)).toEqual({
      steppedAside: [], unread: [], undoneLeaks: [{ did, handle: "paper-audited.ship.test", nullifiedAt: repaired.createdAt }],
    });
  });

  it("opens only with an operator token for the audit", async () => {
    expect(await errorOf(post("/operator/identities"))).toBe("AuthenticationRequired");
    expect(await errorOf(post("/operator/identities", { aud: env.PDS_ORIGIN, act: "status" }))).toBe("InvalidToken");
    expect(await errorOf(post("/operator/lexicons", { aud: env.PDS_ORIGIN, act: "audit" }))).toBe("InvalidToken");
  });
});

/** An hour passes, so the host's next write or signature reads its DID's log again. */
function anHourPasses(): void {
  vi.setSystemTime(Date.now() + HOUR_MS);
}

/** A hosted account; with the operator's paper key, its genesis ranks that key above the host's. */
async function hostedAccount(handle: string, paperKey?: DidKeyString) {
  const name = crypto.randomUUID();
  const repo = env.REPOS.getByName(name);
  const blobPrefix = `installations/${name}/`;
  const { did } = paperKey
    ? await runInDurableObject(repo, (_instance, state) => new HostedRepo(state, { ...env, PLC_RECOVERY_KEY: paperKey }).create(handle, blobPrefix))
    : await repo.create(handle, blobPrefix);
  if (!isDidPlc(did)) throw new Error(`Expected a did:plc, not ${did}`);
  return { repo, did };
}

function write(repo: DurableObjectStub<HostedRepo>) {
  notes += 1;
  return repo.applyWrites([{ action: "put", collection: NOTE, rkey: `note-${notes}`, record: { $type: NOTE, text: `note ${notes}` } }]);
}

/** A person's recovery sheet: its P-256 key and the did:key the identity lists for it. */
async function sheet() {
  const key = await P256PrivateKeyExportable.createKeypair();
  return { key, did: await key.exportPublicKey("did") };
}

async function hostKeypair(): Promise<PrivateKey> {
  return Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
}

async function hostKey(): Promise<DidKeyString> {
  return (await hostKeypair()).exportPublicKey("did");
}

/** The entry in force at the head of the DID's log. */
async function head(did: DidPlcString) {
  const entry = (await new PlcClient({ serviceUrl: env.PLC_URL }).getAuditLog(did)).filter(({ nullified }) => !nullified).at(-1);
  if (!entry) throw new Error(`Expected a log for ${did}`);
  return entry;
}

/** The CIDs of the operations in the DID's audit log that a later one nullified, oldest first. */
async function nullified(did: DidPlcString): Promise<string[]> {
  return (await new PlcClient({ serviceUrl: env.PLC_URL }).getAuditLog(did)).filter((entry) => entry.nullified).map((entry) => entry.cid);
}

function lastRotationKeys(did: string): DidKeyString[] {
  const last = plc.operations(did).at(-1);
  if (last?.type !== "plc_operation") throw new Error("Expected the DID's last operation to be a plc_operation");
  return last.rotationKeys;
}

function stateOf(operation: CompatibleOperationOrTombstone): IdentityState {
  if (operation.type !== "plc_operation") throw new Error("Expected a plc_operation");
  const { sig: _sig, prev: _prev, type: _type, ...state } = operation;
  return state;
}

/** Signs and submits an operation on `base` with a key other than the host's own submissions. */
async function submitAs(did: DidPlcString, base: { cid: string }, state: IdentityState, key: PrivateKey): Promise<void> {
  await new PlcClient({ serviceUrl: env.PLC_URL }).submitOperation(did, await signOperation({ type: "plc_operation", prev: base.cid, ...state }, key));
}

/** What a whole audit, page by page, finds of one DID. */
async function findings(did: string) {
  const pages = [report.parse(await (await audit({ limit: AUDIT_PAGE })).json())];
  while (pages.at(-1)?.cursor) pages.push(report.parse(await (await audit({ limit: AUDIT_PAGE, cursor: pages.at(-1)?.cursor })).json()));
  return {
    steppedAside: pages.flatMap((page) => page.steppedAside).filter((found) => found.did === did),
    unread: pages.flatMap((page) => page.unread).filter((found) => found === did),
    undoneLeaks: pages.flatMap((page) => page.undoneLeaks).filter((found) => found.did === did),
  };
}

async function audit(page: { limit: number; cursor?: string; readsPerSecond?: number }): Promise<Response> {
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor) query.set("cursor", page.cursor);
  if (page.readsPerSecond) query.set("readsPerSecond", String(page.readsPerSecond));
  return post(`/operator/identities?${query}`, { aud: env.PDS_ORIGIN, act: "audit" });
}

async function post(path: string, request?: OperatorRequest): Promise<Response> {
  const headers = request ? { Authorization: `Bearer ${await signOperatorToken(env.PLC_ROTATION_KEY, request)}` } : undefined;
  return worker.fetch(new Request(`${env.PDS_ORIGIN}${path}`, { method: "POST", headers }), deployedEnv());
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: new FakeAccounts() };
}
