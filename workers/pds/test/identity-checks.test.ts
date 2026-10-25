import { createScheduledController, runInDurableObject } from "cloudflare:test";
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
import { signOperatorToken, type OperatorRequest } from "../src/gsv/operator-token";
import { FIREHOSE_NAME } from "../src/host/firehose";
import type { IdentityState } from "../src/host/identity";
import { HostedRepo } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory, isDidPlc } from "./plc";
import { deliver, errorOf, installFakePlc, rejection } from "./support";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NOTE = "com.example.note";
const SHIP_CALL = { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" };
const ELSEWHERE = { type: "AtprotoPersonalDataServer", endpoint: "https://pds.elsewhere.test" };
const TAKEN = ["at://taken.example"];

// What the audit may say of an identity: nothing but its public DID, handle and log.
const decision = z.strictObject({
  at: z.number(),
  outcome: z.enum(["leaked-key", "untrusted-key", "moved"]),
  head: z.string(),
  operation: z.string(),
  signedBy: z.string(),
});
const feedRecord = z.strictObject({
  after: z.nullable(z.number()),
  loggedAt: z.nullable(z.string()),
  error: z.nullable(z.string()),
  notBefore: z.nullable(z.number()),
  backoffMs: z.number(),
  steppedAside: z.array(decision.extend({ did: z.string(), handle: z.string() })),
  undoneLeaks: z.array(z.strictObject({ did: z.string(), handle: z.string(), nullifiedAt: z.string() })),
});
const followed = z.strictObject({
  outcome: z.literal("read"),
  did: z.string(),
  handle: z.string(),
  steppedAside: z.nullable(decision),
  undoneLeaks: z.array(z.string()),
});

let plc: FakePlcDirectory;
let notes = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
  // Each test's directory is a new one, so the host's reading of its feed begins again.
  await runInDurableObject(env.FIREHOSE.getByName(FIREHOSE_NAME), (_instance, state) => state.storage.kv.delete("identity.feed"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a hosted identity someone else changes", () => {
  it("is refused once the feed lists an operation the host's own key signed that the host never submitted", async () => {
    const { repo, did } = await hostedAccount("leaked.ship.test");
    const owner = await sheet();
    await repo.setOwnerRecoveryKey(owner.did);
    const known = await head(did);
    const host = await hostKey();

    // The leaked key moves the host's key above the person's sheet and leaves the PDS and signing key as they were.
    await submitAs(did, known, { ...stateOf(known.operation), rotationKeys: [host, owner.did] }, await hostKeypair());
    const leaked = await head(did);
    // Writes don't read the log, so the host serves until its schedule reads the directory's feed.
    await write(repo);
    await scheduleRuns();

    expect(await rejection(write(repo))).toContain("IdentityChanged");
    expect(await rejection(repo.serviceAuth(SHIP_CALL))).toContain("IdentityChanged");
    expect(await rejection(repo.setOwnerRecoveryKey((await sheet()).did))).toContain("IdentityChanged");
    expect((await repo.identityCheck())?.steppedAside).toMatchObject({
      outcome: "leaked-key", head: leaked.cid, operation: leaked.cid, signedBy: host,
    });
  });

  it("is refused when the host next signs, after a leaked key's two steps: one ranks another key above the host's, which then signs", async () => {
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

    // The host reads its DID's log before it submits an operation of its own, and submits nothing.
    expect(await rejection(repo.setOwnerRecoveryKey((await sheet()).did))).toContain("IdentityChanged");
    expect(plc.operations(did)).toHaveLength(4);
    expect(await rejection(write(repo))).toContain("IdentityChanged");
    expect((await repo.identityCheck())?.steppedAside).toMatchObject({
      outcome: "leaked-key", head: second.cid, operation: first.cid, signedBy: host,
    });
  });

  it("is refused once the feed lists the person's sheet moving it to another PDS or replacing its signing key", async () => {
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
      await scheduleRuns();

      expect(await rejection(write(repo))).toContain("IdentityChanged");
      expect((await repo.identityCheck())?.steppedAside).toMatchObject({
        outcome: "moved", head: moved.cid, operation: moved.cid, signedBy: owner.did,
      });
    }
  });

  it("is followed when the host next signs, after the person's old sheet undoes a swap the host signed", async () => {
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

    // The host adopts the undo and builds on it, replacing the old sheet rather than keeping it.
    const next = await sheet();
    expect(await repo.setOwnerRecoveryKey(next.did)).toEqual({ ownerRecoveryKey: next.did });
    expect(await repo.identityCheck()).toMatchObject({
      steppedAside: null, events: [{ outcome: "adopted", head: undone.cid, operation: undone.cid, signedBy: old.did }],
    });
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
    await scheduleRuns();

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
    await scheduleRuns();

    await write(repo);
    expect(await repo.identityCheck()).toMatchObject({
      steppedAside: null, events: [{ outcome: "adopted", head: latest.cid, signedBy: second.did }],
    });
  });

  it("is followed after the operator's paper key undoes a leaked key's operation", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const { repo, did } = await hostedAccount("repaired.ship.test", await paper.exportPublicKey("did"));
    const genesis = await head(did);
    await submitAs(did, genesis, { ...stateOf(genesis.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const leaked = await head(did);
    await scheduleRuns();
    expect(await rejection(write(repo))).toContain("IdentityChanged");

    // Within 72 hours the paper key, which ranks above the host's, builds on the genesis and nullifies the leak.
    await submitAs(did, genesis, stateOf(genesis.operation), paper);
    const repaired = await head(did);
    expect(await nullified(did)).toEqual([leaked.cid]);
    await scheduleRuns();

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
  it("happen before the host submits an operation of its own, and never before a write or a Ship call", async () => {
    const { repo, did } = await hostedAccount("on-demand.ship.test");
    const reads = plc.reads(did);
    await write(repo);
    await write(repo);
    await repo.serviceAuth(SHIP_CALL);
    expect(plc.reads(did)).toBe(reads);

    await repo.setOwnerRecoveryKey((await sheet()).did);
    expect(plc.reads(did)).toBeGreaterThan(reads);
    expect((await repo.identityCheck())?.checkedAt).toBe(Date.now());
  });

  it("refuse the host's own operation when the directory can't be read, and leave the account's writes alone", async () => {
    const { repo, did } = await hostedAccount("unreadable.ship.test");
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network connection lost."));

    expect(await rejection(repo.setOwnerRecoveryKey((await sheet()).did))).toContain("Network connection lost");
    expect(plc.operations(did)).toHaveLength(1);
    expect(await repo.identityCheck()).toBeNull();
    await write(repo);
  });
});

describe("the host's reading of the PLC directory's feed", () => {
  it("reads a hosted identity's log only when the feed lists an operation the host didn't sign or adopt", async () => {
    const quiet = await hostedAccount("quiet.ship.test");
    const own = await hostedAccount("own.ship.test");
    const changed = await hostedAccount("changed.ship.test");
    const wakes = vi.spyOn(HostedRepo.prototype, "followIdentity");
    // The first run lists each genesis the host submitted, and reads none of their logs.
    const created = logReads(quiet, own, changed);
    await scheduleRuns();
    expect(logReads(quiet, own, changed)).toEqual(created);
    expect(wakes).toHaveBeenCalledTimes(3);

    await own.repo.setOwnerRecoveryKey((await sheet()).did);
    const known = await head(changed.did);
    await submitAs(changed.did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    // Identities the host doesn't hold change too.
    plc.logElsewhere(5);
    const before = logReads(quiet, own, changed);
    wakes.mockClear();
    await scheduleRuns();

    // Only the two identities the feed listed wake, and only the one another key changed reads its log.
    expect(wakes).toHaveBeenCalledTimes(2);
    expect(logReads(quiet, own, changed)).toEqual([before[0], before[1], (before[2] ?? 0) + 1]);
    expect(await rejection(write(changed.repo))).toContain("IdentityChanged");
    await write(quiet.repo);
    await write(own.repo);
  });

  it("reads a page at a time, at most so many a run, from where the last run stopped", async () => {
    const { repo, did } = await hostedAccount("paged.ship.test");
    const firehose = env.FIREHOSE.getByName(FIREHOSE_NAME);
    const bounds = { page: 2, pages: 2 };
    await firehose.followIdentities(bounds);
    expect(await feed()).toMatchObject({ after: 1, loggedAt: (await head(did)).createdAt });

    plc.logElsewhere(5);
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const changed = await head(did);
    let reads = plc.feedReads();
    // Two full pages end the run before the change, the seventh operation.
    await firehose.followIdentities(bounds);
    expect(plc.feedReads()).toBe(reads + 2);
    expect((await feed()).after).toBe(5);
    await write(repo);

    reads = plc.feedReads();
    await firehose.followIdentities(bounds);
    expect(plc.feedReads()).toBe(reads + 2);
    expect(await feed()).toMatchObject({ after: 7, loggedAt: changed.createdAt, error: null });
    expect(await rejection(write(repo))).toContain("IdentityChanged");
  });

  it("begins 72 hours back on its first run, and leaves an older change to the host's next operation", async () => {
    const settled = await hostedAccount("settled.ship.test");
    const settledHead = await head(settled.did);
    await submitAs(settled.did, settledHead, { ...stateOf(settledHead.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    vi.setSystemTime(Date.now() + 3 * HOUR_MS);
    const recent = await hostedAccount("recent.ship.test");
    const recentHead = await head(recent.did);
    await submitAs(recent.did, recentHead, { ...stateOf(recentHead.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    // The first change is now 74 hours old, past any undo; the second is 71.
    vi.setSystemTime(Date.now() + 71 * HOUR_MS);
    const before = logReads(settled, recent);
    await scheduleRuns();

    expect(logReads(settled, recent)).toEqual([before[0], (before[1] ?? 0) + 1]);
    expect(await rejection(write(recent.repo))).toContain("IdentityChanged");
    await write(settled.repo);
    expect(await rejection(settled.repo.setOwnerRecoveryKey((await sheet()).did))).toContain("IdentityChanged");
  });

  it("waits as long as the directory asks when it answers 429, then reads the page it stopped in again", async () => {
    const { repo, did } = await hostedAccount("throttled.ship.test");
    await scheduleRuns();
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const after = (await feed()).after;

    // A refused page and a refused read of a hosted identity's log each hold the feed where it was.
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    await scheduleRuns();
    expect(await feed()).toMatchObject({ after, notBefore: Date.now() + 2 * MINUTE_MS, error: null });
    const reads = plc.feedReads();
    vi.setSystemTime(Date.now() + MINUTE_MS);
    await scheduleRuns();
    expect(plc.feedReads()).toBe(reads);
    await write(repo);

    vi.setSystemTime(Date.now() + MINUTE_MS);
    vi.mocked(fetch)
      .mockImplementationOnce(async (input, init) => plc.handle(new Request(input, init)))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": new Date(Date.now() + 45_000).toUTCString() } }));
    await scheduleRuns();
    expect(await feed()).toMatchObject({ after, notBefore: Date.now() + 45_000 });
    await write(repo);

    vi.setSystemTime(Date.now() + 45_000);
    await scheduleRuns();
    expect(await feed()).toMatchObject({ notBefore: null, error: null });
    expect((await feed()).after).toBeGreaterThan(after ?? 0);
    expect(await rejection(write(repo))).toContain("IdentityChanged");
  });

  it("backs off from ten minutes, doubling, while the directory answers 429 without naming a wait", async () => {
    await hostedAccount("backed-off.ship.test");
    await scheduleRuns();
    for (const wait of [10 * MINUTE_MS, 20 * MINUTE_MS, 40 * MINUTE_MS]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429 }));
      await scheduleRuns();
      expect((await feed()).notBefore).toBe(Date.now() + wait);
      vi.setSystemTime(Date.now() + wait);
    }
    await scheduleRuns();
    expect(await feed()).toMatchObject({ notBefore: null, backoffMs: 10 * MINUTE_MS });
  });

  it("keeps a failure in its record and fails the schedule's run, then reads on from where it stopped", async () => {
    const { repo, did } = await hostedAccount("failing.ship.test");
    await scheduleRuns();
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const after = (await feed()).after;

    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 502 }));
    expect(await rejection(scheduleRuns())).toContain("answered 502");
    expect(await feed()).toMatchObject({ after, error: "The PLC directory answered 502 to a read of its feed" });
    await write(repo);

    await scheduleRuns();
    expect(await feed()).toMatchObject({ error: null });
    expect(await rejection(write(repo))).toContain("IdentityChanged");
  });

  it("keeps each leak of the host's key it finds, whether an undo nullified it before the feed listed it or after", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const paperKey = await paper.exportPublicKey("did");
    const caught = await hostedAccount("caught-leak.ship.test", paperKey);
    const hidden = await hostedAccount("hidden-leak.ship.test", paperKey);
    const caughtGenesis = await head(caught.did);
    await submitAs(caught.did, caughtGenesis, { ...stateOf(caughtGenesis.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const leaked = await head(caught.did);
    await scheduleRuns();

    // The paper key repairs the first leak once the feed has listed it, and the second before.
    await submitAs(caught.did, caughtGenesis, stateOf(caughtGenesis.operation), paper);
    const caughtRepair = await head(caught.did);
    const hiddenGenesis = await head(hidden.did);
    await submitAs(hidden.did, hiddenGenesis, { ...stateOf(hiddenGenesis.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    await submitAs(hidden.did, hiddenGenesis, stateOf(hiddenGenesis.operation), paper);
    const hiddenRepair = await head(hidden.did);
    await scheduleRuns();

    await write(caught.repo);
    await write(hidden.repo);
    expect(await feed()).toMatchObject({
      steppedAside: [{ did: caught.did, handle: "caught-leak.ship.test", outcome: "leaked-key", head: leaked.cid, operation: leaked.cid }],
      undoneLeaks: [
        { did: caught.did, handle: "caught-leak.ship.test", nullifiedAt: caughtRepair.createdAt },
        { did: hidden.did, handle: "hidden-leak.ship.test", nullifiedAt: hiddenRepair.createdAt },
      ],
    });
  });

  it("doesn't count as a leak an operation of the host's own, or another key's, that the person's sheet undid", async () => {
    const paper = await Secp256k1PrivateKeyExportable.createKeypair();
    const swapped = await hostedAccount("own-undone.ship.test");
    const papered = await hostedAccount("paper-undone.ship.test", await paper.exportPublicKey("did"));
    const old = await sheet();
    await swapped.repo.setOwnerRecoveryKey(old.did);
    const before = await head(swapped.did);
    await swapped.repo.setOwnerRecoveryKey((await sheet()).did);
    const swap = await head(swapped.did);
    await submitAs(swapped.did, before, stateOf(before.operation), old.key);
    expect(await nullified(swapped.did)).toEqual([swap.cid]);

    const owner = await sheet();
    await papered.repo.setOwnerRecoveryKey(owner.did);
    const known = await head(papered.did);
    await submitAs(papered.did, known, stateOf(known.operation), paper);
    const paperOperation = await head(papered.did);
    await submitAs(papered.did, known, stateOf(known.operation), owner.key);
    expect(await nullified(papered.did)).toEqual([paperOperation.cid]);
    await scheduleRuns();

    expect(await feed()).toMatchObject({ steppedAside: [], undoneLeaks: [], error: null });
    await write(swapped.repo);
    await write(papered.repo);
  });

  it("reads nothing while the host holds no identity", async () => {
    const empty = env.FIREHOSE.getByName(crypto.randomUUID());
    expect(await empty.followIdentities()).toMatchObject({ after: null, loggedAt: null });
    expect(plc.feedReads()).toBe(0);
  });
});

describe("the operator's identity audit", () => {
  it("reports what reading the feed found, without reading any identity's log", async () => {
    const { did } = await hostedAccount("audited.ship.test");
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const changed = await head(did);
    await scheduleRuns();
    const reads = [plc.reads(did), plc.feedReads()];

    expect(feedRecord.parse(await (await audit()).json())).toEqual({
      after: 2,
      loggedAt: changed.createdAt,
      error: null,
      notBefore: null,
      backoffMs: 10 * MINUTE_MS,
      steppedAside: [{
        did, handle: "audited.ship.test", at: Date.now(), outcome: "leaked-key",
        head: changed.cid, operation: changed.cid, signedBy: await hostKey(),
      }],
      undoneLeaks: [],
    });
    expect([plc.reads(did), plc.feedReads()]).toEqual(reads);
  });

  it("reads one identity's log again when the operator names its DID", async () => {
    const { repo, did } = await hostedAccount("checked.ship.test");
    const known = await head(did);
    await submitAs(did, known, { ...stateOf(known.operation), alsoKnownAs: TAKEN }, await hostKeypair());
    const changed = await head(did);
    const reads = plc.reads(did);

    expect(followed.parse(await (await audit(did)).json())).toEqual({
      outcome: "read",
      did,
      handle: "checked.ship.test",
      steppedAside: { at: Date.now(), outcome: "leaked-key", head: changed.cid, operation: changed.cid, signedBy: await hostKey() },
      undoneLeaks: [],
    });
    expect(plc.reads(did)).toBe(reads + 1);
    expect(await rejection(write(repo))).toContain("IdentityChanged");

    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
    expect(await (await audit(did)).json()).toEqual({ outcome: "busy", retryAfter: 30 });
    expect(await errorOf(audit("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"))).toBe("RepoNotFound");
    expect(await errorOf(audit("checked.ship.test"))).toBe("InvalidRequest");
  });

  it("opens only with an operator token for the audit", async () => {
    expect(await errorOf(post("/operator/identities"))).toBe("AuthenticationRequired");
    expect(await errorOf(post("/operator/identities", { aud: env.PDS_ORIGIN, act: "status" }))).toBe("InvalidToken");
    expect(await errorOf(post("/operator/lexicons", { aud: env.PDS_ORIGIN, act: "audit" }))).toBe("InvalidToken");
  });
});

/**
 * A hosted account the host's directory lists, so the feed can name it; with
 * the operator's paper key, its genesis ranks that key above the host's.
 */
async function hostedAccount(handle: string, paperKey?: DidKeyString) {
  const name = crypto.randomUUID();
  const repo = env.REPOS.getByName(name);
  const blobPrefix = `installations/${name}/`;
  const { did } = paperKey
    ? await runInDurableObject(repo, (_instance, state) => new HostedRepo(state, { ...env, PLC_RECOVERY_KEY: paperKey }).create(handle, blobPrefix))
    : await repo.create(handle, blobPrefix);
  if (!isDidPlc(did)) throw new Error(`Expected a did:plc, not ${did}`);
  await deliver(repo);
  return { repo, did };
}

/** The deployed Worker's schedule runs once, as it does every ten minutes. */
function scheduleRuns(): Promise<void> {
  return worker.scheduled(createScheduledController(), deployedEnv());
}

/** What the host keeps of its reading of the directory's feed. */
async function feed() {
  return feedRecord.parse(await env.FIREHOSE.getByName(FIREHOSE_NAME).identityFeed());
}

/** How many times anyone has read each account's log. */
function logReads(...accounts: Array<{ did: string }>): number[] {
  return accounts.map(({ did }) => plc.reads(did));
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

/** Asks the host for its audit: what the feed found or, given a DID, what reading that one's log finds. */
function audit(did?: string): Promise<Response> {
  return post(`/operator/identities${did ? `?${new URLSearchParams({ did })}` : ""}`, { aud: env.PDS_ORIGIN, act: "audit" });
}

async function post(path: string, request?: OperatorRequest): Promise<Response> {
  const headers = request ? { Authorization: `Bearer ${await signOperatorToken(env.PLC_ROTATION_KEY, request)}` } : undefined;
  return worker.fetch(new Request(`${env.PDS_ORIGIN}${path}`, { method: "POST", headers }), deployedEnv());
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: new FakeAccounts() };
}
