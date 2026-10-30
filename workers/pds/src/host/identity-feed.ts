import * as z from "zod/mini";
import type { HostEnv } from "./env";
import { DirectoryBusyError, readUnlessBusy } from "./identity";
import type { IdentityEvent, IdentityFollow } from "./repo";

/**
 * How far back the feed begins on its first run: PLC's 72 hours, within which
 * a key ranked above another can still undo what that key signed.
 */
const FIRST_READ_MS = 72 * 60 * 60_000;
/** The first wait when the directory answers 429 without naming one; each later one doubles, up to two hours. */
const FIRST_BACKOFF_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 2 * 60 * 60_000;
/** The findings the feed keeps of each kind, the newest. */
const FINDINGS = 100;
const FEED_KEY = "identity.feed";

/** How much of the directory's feed one run reads: operations a page, and pages a run. */
export type FeedBounds = { page: number; pages: number };

/** A page is the most operations plc.directory lists at once; a run that falls behind catches up over the next ones. */
export const FEED_BOUNDS: FeedBounds = { page: 1000, pages: 30 };

/** How far the host has read the PLC directory's feed, and what it found among the identities it holds. */
export type IdentityFeed = {
  /** The sequence number of the last operation the host read past; null until the first run finds where to begin. */
  after: number | null;
  /** When the directory logged that operation; null until a run reads one. */
  loggedAt: string | null;
  /** Why the last run failed, or null once one reads as far as it may. */
  error: string | null;
  /** While the directory asks the host to wait, when the feed may read again. */
  notBefore: number | null;
  /** How long the next wait lasts when the directory answers 429 without naming one. */
  backoffMs: number;
  /** Each change the host stepped aside for, as reading a DID's log found it, oldest first; the last 100. */
  steppedAside: Array<IdentityEvent & { did: string; handle: string }>;
  /** When an undo nullified each operation the host's key signed that the host never submitted, oldest first; the last 100. */
  undoneLeaks: Array<{ did: string; handle: string; nullifiedAt: string }>;
};

/** A DID the host holds, with the name of the object that holds it. */
export type HostedIdentity = { did: string; name: string };

/** What the host reads of each line of the directory's feed: the operation's place in it, its DID and CID, and when it was logged. */
const feedEntry = z.object({
  type: z.literal("sequenced_op"),
  seq: z.int(),
  did: z.string(),
  cid: z.string(),
  createdAt: z.iso.datetime(),
});

type FeedEntry = z.infer<typeof feedEntry>;

/** The feed's record, as the host's firehose keeps it. */
export function identityFeed(kv: SyncKvStorage): IdentityFeed {
  return kv.get<IdentityFeed>(FEED_KEY)
    ?? { after: null, loggedAt: null, error: null, notBefore: null, backoffMs: FIRST_BACKOFF_MS, steppedAside: [], undoneLeaks: [] };
}

/**
 * Reads the PLC directory's feed of every operation it logs on from where the
 * last run stopped, a page at a time and at most `bounds.pages` a run, and has
 * each identity the host holds that a page names read its DID's log again;
 * `hosted` gives those DIDs among a page's. The first run begins 72 hours
 * back. The record is written when the run ends, and only if it changed.
 * When the directory answers 429, the feed waits as long as its
 * Retry-After asks, or backs off when it names no time, and the next run reads
 * the page it stopped in again. Any other failure is kept in the record and
 * fails the run.
 */
export async function readIdentityFeed(
  env: HostEnv,
  kv: SyncKvStorage,
  hosted: (dids: string[]) => HostedIdentity[],
  bounds: FeedBounds = FEED_BOUNDS,
): Promise<IdentityFeed> {
  const stored = identityFeed(kv);
  if (stored.notBefore !== null && Date.now() < stored.notBefore) return stored;
  let feed = stored;
  try {
    let after = feed.after ?? await sequenceBefore(env, Date.now() - FIRST_READ_MS);
    feed = { ...feed, after };
    for (let read = 0; read < bounds.pages; read += 1) {
      const entries = await readPage(env, after, bounds.page);
      // Each DID's operations on the page, in the order the page first lists each DID.
      const listed = new Map<string, string[]>();
      for (const { did, cid } of entries) listed.set(did, [...listed.get(did) ?? [], cid]);
      const names = new Map(listed.size > 0 ? hosted([...listed.keys()]).map(({ did, name }) => [did, name]) : []);
      for (const [did, operations] of listed) {
        const name = names.get(did);
        if (name === undefined) continue;
        const followed = await env.REPOS.getByName(name).followIdentity(operations);
        if (followed?.outcome === "busy") throw new DirectoryBusyError(followed.retryAfter);
        if (followed?.outcome === "read") feed = recorded(feed, followed);
      }
      const last = entries.at(-1);
      if (last) {
        after = last.seq;
        feed = { ...feed, after, loggedAt: last.createdAt };
      }
      if (entries.length < bounds.page) break;
    }
    feed = { ...feed, error: null, notBefore: null, backoffMs: FIRST_BACKOFF_MS };
  } catch (error) {
    if (!(error instanceof DirectoryBusyError)) {
      save(kv, stored, { ...feed, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      throw error;
    }
    const { retryAfter } = error;
    feed = {
      ...feed,
      notBefore: Date.now() + (retryAfter === null ? feed.backoffMs : retryAfter * 1000),
      backoffMs: retryAfter === null ? Math.min(feed.backoffMs * 2, MAX_BACKOFF_MS) : feed.backoffMs,
    };
  }
  save(kv, stored, feed);
  return feed;
}

/** Keeps the record, unless it is as it was. */
function save(kv: SyncKvStorage, stored: IdentityFeed, feed: IdentityFeed): void {
  if (JSON.stringify(feed) !== JSON.stringify(stored)) kv.put(FEED_KEY, feed);
}

/** The record with what reading one identity's log found: what the host steps aside for, and each leak an undo hid, once each. */
function recorded(feed: IdentityFeed, { did, handle, steppedAside, undoneLeaks }: Extract<IdentityFollow, { outcome: "read" }>): IdentityFeed {
  const found = steppedAside !== null && !feed.steppedAside.some((event) => event.did === did
    && event.outcome === steppedAside.outcome && event.head === steppedAside.head && event.operation === steppedAside.operation);
  const leaks = undoneLeaks.filter((nullifiedAt) => !feed.undoneLeaks.some((leak) => leak.did === did && leak.nullifiedAt === nullifiedAt));
  return {
    ...feed,
    steppedAside: found ? [...feed.steppedAside, { did, handle, ...steppedAside }].slice(-FINDINGS) : feed.steppedAside,
    undoneLeaks: [...feed.undoneLeaks, ...leaks.map((nullifiedAt) => ({ did, handle, nullifiedAt }))].slice(-FINDINGS),
  };
}

/**
 * The sequence number after which the directory's feed lists what it logged
 * from `since` on. It doubles a guess until the operation after it was logged
 * since then, and halves back to the first, reading one operation each step:
 * about fifty reads, once.
 */
async function sequenceBefore(env: HostEnv, since: number): Promise<number> {
  const loggedSince = async (after: number) => {
    const [next] = await readPage(env, after, 1);
    return next === undefined || Date.parse(next.createdAt) >= since;
  };
  let before = -1;
  let after = 1;
  while (!await loggedSince(after)) {
    before = after;
    after *= 2;
  }
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (await loggedSince(middle)) after = middle;
    else before = middle;
  }
  return after;
}

/** Up to `count` operations the directory sequenced after `after`, in order, as its feed lists them. */
async function readPage(env: HostEnv, after: number, count: number): Promise<FeedEntry[]> {
  const url = new URL("/export", env.PLC_URL);
  url.searchParams.set("after", String(after));
  url.searchParams.set("count", String(count));
  const response = await readUnlessBusy(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The PLC directory answered ${response.status} to a read of its feed`);
  }
  // The feed is JSON lines, which the runtime warns about reading as text.
  const lines = new TextDecoder().decode(await response.arrayBuffer()).split("\n").filter((line) => line.trim() !== "");
  const entries = lines.map((line) => feedEntry.parse(JSON.parse(line)));
  if (entries.length > count || entries.some((entry, index) => entry.seq <= (entries[index - 1]?.seq ?? after))) {
    throw new Error("The PLC directory's feed listed operations out of order");
  }
  return entries;
}
