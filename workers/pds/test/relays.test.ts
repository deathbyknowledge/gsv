import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { encode } from "../src/cirrus/cbor-compat";
import type { PdsEnv } from "../src/gsv/env";
import { FIREHOSE_NAME, type HostFirehose } from "../src/host/firehose";
import type { RelayRequest } from "../src/host/relays";
import { HostedRepo } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory } from "./plc";
import { FakeRelay, framesFor, subscribe } from "./relay";
import { deliver, installFakeServices, rejection, type FakeService } from "./support";

const MINUTE = 60_000;
/** The name a relay knows the host by: its origin's host, without the scheme. */
const HOST = new URL(env.PDS_ORIGIN).host;

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

  it("asks no relay while the deployment names none, and asks a relay at once when it's named again", async () => {
    await worker.scheduled(createScheduledController(), deployed(undefined));
    await worker.scheduled(createScheduledController(), deployed(""));
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const kept = relay("https://relay-a.test");
    const dropped = relay("https://relay-b.test");
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    expect(await firehose.announce([kept.origin, dropped.origin], HOST)).toEqual([kept.origin, dropped.origin]);
    expect(await firehose.announce([kept.origin], HOST)).toEqual([]);
    expect(Object.keys(await requested(firehose))).toEqual([kept.origin]);
    expect(await firehose.announce([kept.origin, dropped.origin], HOST)).toEqual([dropped.origin]);
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

/** What the firehose keeps of its last request to each relay. */
function requested(firehose: DurableObjectStub<HostFirehose>): Promise<Record<string, RelayRequest>> {
  return runInDurableObject(firehose, async (_instance, state) => (await state.storage.get<Record<string, RelayRequest>>("relays")) ?? {});
}

/** Moves the firehose's last request to each relay back by ms, as though that long had passed. */
async function rewind(firehose: DurableObjectStub<HostFirehose>, ms: number): Promise<void> {
  const relays = await requested(firehose);
  for (const request of Object.values(relays)) request.at -= ms;
  await runInDurableObject(firehose, (_instance, state) => state.storage.put("relays", relays));
}

/** Appends an event to the firehose, as a repository's next change does. */
async function change(firehose: DurableObjectStub<HostFirehose>): Promise<void> {
  const name = crypto.randomUUID();
  const did = `did:plc:${name.replaceAll("-", "").slice(0, 24)}`;
  const state = { did, handle: `${name}.ship.test`, active: true, status: null, rev: null, head: null };
  await firehose.append(name, state, [{ seq: 1, type: "identity", payload: encode({ did, time: new Date().toISOString() }) }]);
}

/** The text of every warning so far, sorted. */
function warned(warnings: MockInstance<typeof console.warn>): string[] {
  return warnings.mock.calls.map(([message]) => String(message)).sort();
}
