import { createScheduledController, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { encode } from "../src/cirrus/cbor-compat";
import type { PdsEnv } from "../src/gsv/env";
import { FIREHOSE_NAME, type HostFirehose } from "../src/host/firehose";
import { REPO_REF } from "../src/host/moderation";
import type { RelayRequest } from "../src/host/relays";
import { HostedRepo, type RepoWrite } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory } from "./plc";
import { FakeRelay, framesFor, subscribe, syncedCommit, type Frame } from "./relay";
import { deliver, installFakeServices, rejection, type FakeService } from "./support";

const MINUTE = 60_000;
/** The name a relay knows the host by: its origin's host, without the scheme. */
const HOST = new URL(env.PDS_ORIGIN).host;
const NOTE = "com.example.note";

let services: Map<string, FakeService>;
let accounts: FakeAccounts;

beforeEach(() => {
  const plc = new FakePlcDirectory();
  services = new Map([[env.PLC_URL, (request) => plc.handle(request)]]);
  installFakeServices(services);
  accounts = new FakeAccounts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("announcing the host to relays", () => {
  it("asks each relay the deployment names to crawl the host by its hostname, and the relay then hears what the host does", async () => {
    const relays = [relay("https://relay-a.test"), relay("https://relay-b.test")];
    // The deployment's list may space its entries or repeat one.
    await worker.scheduled(createScheduledController(), deployed("https://relay-a.test, https://relay-b.test,https://relay-a.test"));
    expect(relays.map((relay) => relay.requests)).toEqual([[HOST], [HOST]]);

    // A relay that accepts follows the firehose from its live end.
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    const name = crypto.randomUUID();
    const repo = env.REPOS.getByName(name);
    const account = await repo.create(`${name}.ship.test`, `installations/${name}/`);
    await deliver(repo);
    await vi.waitFor(() => expect(framesFor(live, account.did).map((frame) => frame.type)).toEqual(["#account", "#identity", "#sync"]));
  });

  it("asks the relays even when publishing lexicons fails, and still fails the run", async () => {
    const other = relay("https://relay-c.test");
    vi.spyOn(HostedRepo.prototype, "collections").mockRejectedValue(new Error("Lexicon account unavailable"));
    const scheduled = worker.scheduled(createScheduledController(), { ...deployed(other.origin), PDS_LEXICON_HANDLE: "lexicons.ship.test" });
    expect(await rejection(scheduled)).toContain("Lexicon account unavailable");
    expect(other.requests).toEqual([HOST]);
  });

  it("asks a relay again only once the host has events it hasn't announced and twenty minutes have passed", async () => {
    const accepting = relay("https://relay-a.test");
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    expect(await firehose.announce([accepting.origin], HOST)).toEqual([accepting.origin]);
    await change(firehose);
    expect(await firehose.announce([accepting.origin], HOST)).toEqual([]);
    await rewind(firehose, 21 * MINUTE);
    expect(await firehose.announce([accepting.origin], HOST)).toEqual([accepting.origin]);
    // A host with nothing new stays quiet, however long it has been.
    await rewind(firehose, 24 * 60 * MINUTE);
    expect(await firehose.announce([accepting.origin], HOST)).toEqual([]);
    expect(accepting.requests).toEqual([HOST, HOST]);
  });

  it("backs off a relay that refuses or can't be reached, warning each time, until it accepts", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refusing = relay("https://refusing.test");
    refusing.refusal = { status: 400, error: "HostNotFound" };
    const unreachable = "https://unreachable.test";
    services.set(unreachable, async () => {
      throw new TypeError("Network connection lost.");
    });
    const relays = [refusing.origin, unreachable];
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());

    expect(await firehose.announce(relays, HOST)).toEqual(relays);
    expect(warned(warnings)).toEqual([
      `Relay ${refusing.origin} refused to crawl ${HOST}: HTTP 400 HostNotFound`,
      `Relay ${unreachable} could not be reached to crawl ${HOST}`,
    ]);
    // A refusal doubles the twenty minutes between requests.
    await rewind(firehose, 39 * MINUTE);
    expect(await firehose.announce(relays, HOST)).toEqual([]);
    await rewind(firehose, 2 * MINUTE);
    refusing.refusal = null;
    expect(await firehose.announce(relays, HOST)).toEqual(relays);
    expect(warned(warnings)).toHaveLength(3);

    // A relay that accepts waits again only for new events and twenty minutes; one refused twice waits eighty.
    await change(firehose);
    await rewind(firehose, 21 * MINUTE);
    expect(await firehose.announce(relays, HOST)).toEqual([refusing.origin]);
    await rewind(firehose, 60 * MINUTE);
    expect(await firehose.announce(relays, HOST)).toEqual([unreachable]);
    expect(refusing.requests).toEqual([HOST, HOST, HOST]);
    expect(warned(warnings)).toHaveLength(4);
  });

  it("asks no relay while the deployment names none, and forgets each relay it stops naming", async () => {
    const kept = relay("https://relay-d.test");
    const dropped = relay("https://relay-e.test");
    const host = env.FIREHOSE.getByName(FIREHOSE_NAME);
    await scheduled(`${kept.origin},${dropped.origin}`);
    await scheduled(kept.origin);
    expect(Object.keys(await requested(host))).toEqual([kept.origin]);
    await scheduled(undefined);
    await scheduled("");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(await requested(host)).toEqual({});
    // A relay named again is asked at once.
    await scheduled(`${kept.origin},${dropped.origin}`);
    expect([kept.requests, dropped.requests]).toEqual([[HOST, HOST], [HOST, HOST]]);
  });

  it("writes what it keeps of the relays only when that changes, and nothing while the deployment names no relay", async () => {
    const quiet = relay("https://relay-h.test");
    const host = env.FIREHOSE.getByName(FIREHOSE_NAME);
    await scheduled(quiet.origin);
    await scheduled(quiet.origin);
    const writes = await kvWrites(host);
    // A relay that has accepted and heard the introduction isn't due again until the host changes and twenty minutes pass.
    await scheduled(quiet.origin);
    await scheduled(quiet.origin);
    expect(writes).not.toHaveBeenCalled();

    // Dropping the last relay forgets it in one write; after that, a run with none named writes nothing.
    await scheduled(undefined);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await requested(host)).toEqual({});
    writes.mockClear();
    await scheduled(undefined);
    await scheduled("");
    expect(writes).not.toHaveBeenCalled();
    expect(quiet.requests).toEqual([HOST]);
  });

  it("introduces each active account to a relay that joins after it, as creating the account announced it, once per relay", async () => {
    const first = await publishedAccount();
    const second = await publishedAccount();
    const down = await publishedAccount();
    await down.repo.updateSubjectStatus({ subject: { $type: REPO_REF, did: down.did }, takedown: { applied: true } });
    await deliver(down.repo);
    const joining = relay("https://relay-f.test");
    const host = env.FIREHOSE.getByName(FIREHOSE_NAME);

    // A relay follows a host it has just accepted from the live end, so the run after it accepts introduces the accounts.
    expect(await heardWhile(() => scheduled(joining.origin))).toEqual([]);
    const introduction = await heardWhile(() => scheduled(joining.origin));
    for (const ship of [first, second]) expect(await heard(introduction, ship.did)).toEqual(await introductionOf(ship));
    expect(await heard(introduction, down.did)).toEqual([]);

    // Later runs don't introduce the accounts again, even after the firehose restarts.
    await evictDurableObject(host);
    await rewind(host, 21 * MINUTE);
    expect(await heardWhile(async () => {
      await scheduled(joining.origin);
      await scheduled(joining.origin);
    })).toEqual([]);

    // A relay named again after the deployment stopped naming it hears of each account again, at its current head.
    await first.repo.applyWrites([note("second")]);
    await deliver(first.repo);
    await scheduled(undefined);
    await scheduled(joining.origin);
    const again = await heardWhile(() => scheduled(joining.origin));
    for (const ship of [first, second]) expect(await heard(again, ship.did)).toEqual(await introductionOf(ship));
    expect(joining.requests).toEqual([HOST, HOST, HOST]);
  });

  it("leaves out an account taken down while the host reads its head, so relays still see it down", async () => {
    const ship = await publishedAccount();
    const joining = relay("https://relay-g.test");
    await scheduled(joining.origin);
    const read = HostedRepo.prototype.head;
    vi.spyOn(HostedRepo.prototype, "head").mockImplementation(async function (this: HostedRepo) {
      const head = await read.call(this);
      if ((await this.account())?.did === ship.did) {
        await this.updateSubjectStatus({ subject: { $type: REPO_REF, did: ship.did }, takedown: { applied: true } });
        await this.alarm();
      }
      return head;
    });
    const introduction = await heardWhile(() => scheduled(joining.origin));
    expect(await heard(introduction, ship.did)).toEqual([{ type: "#account", active: false }]);
  });

  it("introduces at most a batch of accounts a run, in DID order, and resumes where it stopped after a restart", async () => {
    const ships: PublishedAccount[] = [];
    for (let count = 0; count < 5; count++) ships.push(await publishedAccount());
    // A firehose of its own lists only these five.
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    for (const ship of ships) await list(firehose, ship);
    const joining = relay("https://relay-i.test");
    expect(await firehose.announce([joining.origin], HOST, 2)).toEqual([joining.origin]);

    const order = ships.map((ship) => ship.did).sort();
    const runs: string[][] = [];
    for (let run = 0; run < 3; run++) {
      if (run === 1) {
        // An account listed after the introduction began reaches relays live, so no batch introduces it,
        // even one whose DID the walk has yet to reach.
        let late = await publishedAccount();
        while (late.did < order[1]) late = await publishedAccount();
        await list(firehose, late);
        // The firehose restarts after the first batch, keeping only what it stored.
        await evictDurableObject(firehose);
      }
      const frames = await heardWhile(async () => {
        await firehose.announce([joining.origin], HOST, 2);
      }, firehose);
      const dids = [...new Set(frames.flatMap((frame) => "did" in frame ? [frame.did] : []))];
      for (const did of dids) {
        const ship = ships.find((candidate) => candidate.did === did);
        if (!ship) throw new Error(`The firehose introduced ${did}, which it doesn't list`);
        expect(await heard(frames, did)).toEqual(await introductionOf(ship));
      }
      runs.push(dids);
      expect((await requested(firehose))[joining.origin]?.introduced).toBe(run === 2);
    }
    expect(runs).toEqual([order.slice(0, 2), order.slice(2, 4), order.slice(4)]);
    expect(await heardWhile(async () => {
      await firehose.announce([joining.origin], HOST, 2);
    }, firehose)).toEqual([]);
  });
});

/** A relay at origin that reaches the host through the deployed Worker. */
function relay(origin: string): FakeRelay {
  const fake = new FakeRelay(origin, (url) => worker.fetch(new Request(url), deployed()));
  services.set(origin, (request) => fake.handle(request));
  return fake;
}

/** The deployed Worker's bindings, with the relays the deployment names. */
function deployed(relays?: string): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: accounts, PDS_RELAYS: relays };
}

/** Runs the deployed Worker's schedule once, with the relays the deployment names. */
function scheduled(relays?: string): Promise<void> {
  return worker.scheduled(createScheduledController(), deployed(relays));
}

/** What the firehose keeps of its last request to each relay. */
function requested(firehose: DurableObjectStub<HostFirehose>): Promise<Record<string, RelayRequest>> {
  return runInDurableObject(firehose, (_instance, state) => state.storage.kv.get<Record<string, RelayRequest>>("relays") ?? {});
}

/** Watches every write a firehose makes to its synchronous storage, which keeps only the relay record. */
function kvWrites(firehose: DurableObjectStub<HostFirehose>): Promise<MockInstance<SyncKvStorage["put"]>> {
  return runInDurableObject(firehose, (_instance, state) =>
    // SAFETY: a SyncKvStorage's methods live on its prototype, which every object's storage shares.
    vi.spyOn(Object.getPrototypeOf(state.storage.kv) as SyncKvStorage, "put"));
}

/** Moves the firehose's last request to each relay back by ms, as though that long had passed. */
async function rewind(firehose: DurableObjectStub<HostFirehose>, ms: number): Promise<void> {
  const relays = await requested(firehose);
  for (const request of Object.values(relays)) request.at -= ms;
  await runInDurableObject(firehose, (_instance, state) => state.storage.kv.put("relays", relays));
}

/** Appends an event to the firehose, as a repository's next change does, and returns the DID it is for. */
async function change(firehose: DurableObjectStub<HostFirehose>): Promise<string> {
  const name = crypto.randomUUID();
  const did = `did:plc:${name.replaceAll("-", "").slice(0, 24)}`;
  const state = { did, handle: `${name}.ship.test`, active: true, status: null, rev: null, head: null };
  await firehose.append(name, state, [{ seq: 1, type: "identity", payload: encode({ did, time: new Date().toISOString() }) }]);
  return did;
}

type PublishedAccount = { name: string; repo: DurableObjectStub<HostedRepo>; did: string };

/** A hosted account that has written a record since it was created, delivered to the host firehose. */
async function publishedAccount(): Promise<PublishedAccount> {
  const name = crypto.randomUUID();
  const repo = env.REPOS.getByName(name);
  const { did } = await repo.create(`${name}.ship.test`, `installations/${name}/`);
  await repo.applyWrites([note("first")]);
  await deliver(repo);
  return { name, repo, did };
}

/** Lists an account on another firehose, as its repository's first delivery would. */
async function list(firehose: DurableObjectStub<HostFirehose>, { name, repo, did }: PublishedAccount): Promise<void> {
  const state = await repo.state();
  if (!state) throw new Error("The repository holds no account");
  await firehose.append(name, state, [{ seq: 1, type: "identity", payload: encode({ did, time: new Date().toISOString() }) }]);
}

function note(rkey: string): RepoWrite {
  return { action: "put", collection: NOTE, rkey, record: { $type: NOTE, text: rkey, createdAt: "2026-10-25T00:00:00.000Z" } };
}

/**
 * Every frame a relay following the host's firehose hears while run runs. The
 * host's next event marks the end, since a relay hears its frames in order.
 */
async function heardWhile(run: () => Promise<void>, host = env.FIREHOSE.getByName(FIREHOSE_NAME)): Promise<Frame[]> {
  const following = await subscribe(host);
  await run();
  const marker = await change(host);
  await vi.waitFor(() => expect(framesFor(following, marker)).toHaveLength(1));
  return following.frames.slice(0, following.frames.findIndex((frame) => "did" in frame && frame.did === marker));
}

/** A firehose event as a relay acts on it: an account's status, or the commit a #sync makes its head. */
type Heard = { type: string; active?: boolean; rev?: string; commit?: string };

/** The events among frames for one account, as a relay acts on them. */
function heard(frames: readonly Frame[], did: string): Promise<Heard[]> {
  return Promise.all(frames.filter((frame) => "did" in frame && frame.did === did).map(async (frame): Promise<Heard> => {
    if (frame.type === "#account") return { type: frame.type, active: frame.body.active };
    if (frame.type === "#sync") return { type: frame.type, rev: frame.body.rev, commit: await syncedCommit(frame.body) };
    return { type: frame.type };
  }));
}

/** What creating an account announces, at its repository's current head. */
async function introductionOf({ repo }: PublishedAccount): Promise<Heard[]> {
  const state = await repo.state();
  if (!state?.rev || !state.head) throw new Error("The repository has no head");
  return [{ type: "#account", active: true }, { type: "#identity" }, { type: "#sync", rev: state.rev, commit: state.head }];
}

/** The text of every warning so far, sorted. */
function warned(warnings: MockInstance<typeof console.warn>): string[] {
  return warnings.mock.calls.map(([message]) => String(message)).sort();
}
