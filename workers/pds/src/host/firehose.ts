import { decodeFirst, type CidLink } from "@atcute/cbor";
import { decodeFirst as decodeCid, equals as sameCid, fromCidLink } from "@atcute/cid";
import { DurableObject } from "cloudflare:workers";
import { decode, encode } from "../cirrus/cbor-compat";
import type { AccountStatus, SeqEvent } from "../cirrus/repo/sequencer";
import type { HostEnv } from "./env";
import { crawlDue, requestCrawl, type IntroductionCursor, type RelayRequest } from "./relays";
import { migrate } from "./schema";

/** Name of the one firehose object a host runs. */
export const FIREHOSE_NAME = "host";

/** An event from a repository's outbox, numbered by that repository. */
export type OutboxEvent = {
  seq: number;
  type: SeqEvent["type"];
  /** The engine's CBOR encoding of the event body, without a sequence number. */
  payload: Uint8Array;
};

/** What the host reports for a repository in listRepos and getRepoStatus. */
export type RepoState = {
  did: string;
  handle: string;
  active: boolean;
  status: AccountStatus | null;
  rev: string | null;
  head: string | null;
};

/** A hosted repository: its directory entry and the name of the object that holds it. */
export type HostedEntry = RepoState & { name: string };

/** A repository's head as a #sync event carries it: its revision and a CAR holding its signed commit. */
type RepoHead = { rev: string; blocks: Uint8Array };

/** The fields of a decoded event body that place its repository's head; decoding leaves each CID a link. */
type EventBody = { rev?: string; commit?: CidLink; blocks?: Uint8Array };

export type RepoListing = { repos: RepoState[]; cursor?: string };

/** Frames older than this are pruned; a cursor before them gets #info OutdatedCursor. */
const RETENTION_MS = 72 * 60 * 60_000;
const REPLAY_PAGE = 500;
/**
 * The most one replay sends before it closes the subscription, which resumes
 * from its last frame when the subscriber reconnects. A socket buffers what it
 * hasn't flushed in the firehose's memory, which every subscriber and
 * repository shares.
 */
export const REPLAY_BYTES = 1024 * 1024;
/** The most subscriptions the firehose holds at once, which bounds what their replays buffer. */
export const MAX_SUBSCRIBERS = 64;
const ACCOUNT_STATUSES = ["takendown", "suspended", "deleted", "deactivated"] as const;
/** The host's last request to each relay, kept as one record by the relay's origin. */
const RELAYS_KEY = "relays";
/** Accounts one run introduces to relays that have joined. */
const INTRODUCTION_BATCH = 200;

const MIGRATIONS = [{
  id: 1,
  statements: [
    `CREATE TABLE repos (
      did TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, handle TEXT NOT NULL,
      active INTEGER NOT NULL, status TEXT, rev TEXT, head TEXT, delivered INTEGER NOT NULL
    )`,
    "CREATE INDEX repos_handle ON repos(handle)",
    "CREATE TABLE events (seq INTEGER PRIMARY KEY, did TEXT NOT NULL, frame BLOB NOT NULL, appended_at INTEGER NOT NULL)",
    "CREATE INDEX events_appended ON events(appended_at)",
    "CREATE TABLE sequence (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)",
    "INSERT INTO sequence (id, seq) VALUES (1, 0)",
  ],
}, {
  id: 2,
  statements: [
    // An active repository's latest commit as a #sync carries it, so introducing the account to a relay reads only the firehose.
    "ALTER TABLE repos ADD COLUMN sync_rev TEXT",
    "ALTER TABLE repos ADD COLUMN sync_blocks BLOB",
  ],
  backfill: keepRetainedHeads,
}];

type RepoRow = {
  did: string;
  name: string;
  handle: string;
  active: number;
  status: string | null;
  rev: string | null;
  head: string | null;
  delivered: number;
  sync_rev: string | null;
  sync_blocks: ArrayBuffer | null;
};

/**
 * The host's firehose and repository directory. Repositories append their
 * outbox events; the host numbers them in one sequence, stores each frame
 * once, and sends it to every subscriber.
 */
export class HostFirehose extends DurableObject<HostEnv> {
  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    migrate(ctx.storage, "host_firehose", MIGRATIONS);
  }

  /**
   * Appends a repository's events in order and returns the last outbox sequence
   * the host holds for it, so a retried batch never appends an event twice.
   */
  async append(name: string, state: RepoState, events: OutboxEvent[]): Promise<number> {
    const hosted = this.row("SELECT * FROM repos WHERE did = ?", state.did);
    if (hosted && hosted.name !== name) throw new Error(`RepoConflict: ${state.did} is hosted by another repository`);
    if (!hosted && this.row("SELECT * FROM repos WHERE name = ?", name)) {
      throw new Error("RepoConflict: this repository already hosts another DID");
    }
    const appendedAt = Date.now();
    const frames: Uint8Array[] = [];
    let delivered = hosted?.delivered ?? 0;
    this.ctx.storage.transactionSync(() => {
      let seq = this.latestSeq();
      let head = hosted ? storedHead(hosted) : null;
      for (const event of events) {
        if (event.seq <= delivered) continue;
        seq += 1;
        // SAFETY: outbox payloads are the engine Sequencer's own CBOR encoding of an event body.
        const body = decode(event.payload) as EventBody;
        const frame = eventFrame(event.type, body, seq);
        this.ctx.storage.sql.exec(
          "INSERT INTO events (seq, did, frame, appended_at) VALUES (?, ?, ?, ?)",
          seq,
          state.did,
          frame,
          appendedAt,
        );
        frames.push(frame);
        delivered = event.seq;
        head = eventHead(event.type, body) ?? head;
      }
      // The host keeps an active account's latest commit to introduce the account to relays, and drops it while the account is
      // inactive; reactivating an account announces its head again.
      const kept = state.active ? head : null;
      this.ctx.storage.sql.exec("UPDATE sequence SET seq = ?", seq);
      this.ctx.storage.sql.exec(
        `INSERT INTO repos (did, name, handle, active, status, rev, head, delivered, sync_rev, sync_blocks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, active = excluded.active, status = excluded.status,
           rev = excluded.rev, head = excluded.head, delivered = excluded.delivered,
           sync_rev = excluded.sync_rev, sync_blocks = excluded.sync_blocks`,
        state.did,
        name,
        state.handle,
        state.active ? 1 : 0,
        state.status,
        state.rev,
        state.head,
        delivered,
        kept?.rev ?? null,
        kept?.blocks ?? null,
      );
      this.ctx.storage.sql.exec("DELETE FROM events WHERE appended_at < ?", appendedAt - RETENTION_MS);
    });
    for (const frame of frames) this.broadcast(frame);
    return delivered;
  }

  /**
   * The repository a DID or handle names, if this host holds it. A handle names
   * the newest repository that holds it, since a reset moves a handle to a new
   * repository while the old one still holds data.
   */
  async locate(identifier: string): Promise<HostedEntry | null> {
    const row = identifier.startsWith("did:")
      ? this.row("SELECT * FROM repos WHERE did = ?", identifier)
      : this.row("SELECT * FROM repos WHERE handle = ? ORDER BY rowid DESC LIMIT 1", identifier.toLowerCase());
    return row ? { ...repoState(row), name: row.name } : null;
  }

  /** Lists repositories that have a head, in DID order. */
  async listRepos(limit: number, cursor?: string): Promise<RepoListing> {
    const rows = this.ctx.storage.sql.exec<RepoRow>(
      "SELECT * FROM repos WHERE did > ? AND head IS NOT NULL ORDER BY did LIMIT ?",
      cursor ?? "",
      limit + 1,
    ).toArray();
    const page = rows.slice(0, limit);
    return { repos: page.map(repoState), cursor: rows.length > limit ? page.at(-1)?.did : undefined };
  }

  /** Whether the host holds a repository's directory entry, by the name of the object that holds it. */
  async inspectRepository(name: string): Promise<"identified" | "unrelated" | "empty"> {
    if (this.row("SELECT * FROM repos WHERE name = ?", name)) return "identified";
    const held = this.ctx.storage.sql.exec<{ held: number }>(
      "SELECT EXISTS (SELECT 1 FROM repos) OR EXISTS (SELECT 1 FROM events) AS held",
    ).one().held;
    return held ? "unrelated" : "empty";
  }

  /**
   * Forgets a deleted repository: its directory entry and every event it
   * published but the last, its deletion, which a relay replaying the
   * firehose still needs until the event ages out.
   */
  async eraseRepository(name: string): Promise<void> {
    const hosted = this.row("SELECT * FROM repos WHERE name = ?", name);
    if (!hosted) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM events WHERE did = ? AND seq < (SELECT MAX(seq) FROM events WHERE did = ?)",
        hosted.did,
        hosted.did,
      );
      this.ctx.storage.sql.exec("DELETE FROM repos WHERE did = ?", hosted.did);
    });
  }

  async healthCheck(): Promise<{ ok: true }> {
    this.ctx.storage.sql.exec("SELECT 1").toArray();
    return { ok: true };
  }

  /**
   * Asks each relay to crawl the host, named by its hostname, when a request
   * to it is due, and keeps how each answered. It forgets the relays it isn't
   * given, so one named again is asked at once. Returns the relays it asked.
   *
   * A relay follows a host it has just accepted from the firehose's live end,
   * so the accounts the host already held would reach it only with their next
   * events. The runs after a relay accepts introduce those accounts, a batch
   * of them a run.
   */
  async announce(relays: readonly string[], host: string, batch = INTRODUCTION_BATCH): Promise<string[]> {
    const last = this.relayRequests();
    const seq = this.latestSeq();
    const now = Date.now();
    const due = relays.filter((relay) => crawlDue(last[relay], seq, now));
    // A relay that accepted in an earlier run is following the firehose by now.
    const joined = relays.filter((relay) => {
      const request = last[relay];
      return request !== undefined && request.seq !== null && !request.introduced;
    });
    const answers = new Map(await Promise.all(due.map(async (relay) => [relay, await requestCrawl(relay, host)] as const)));
    // Another run may have changed the record while the relays answered.
    const current = this.relayRequests();
    const kept: Record<string, RelayRequest> = {};
    for (const relay of relays) {
      const previous = current[relay];
      const accepted = answers.get(relay);
      if (accepted === undefined) {
        if (previous) kept[relay] = previous;
      } else {
        const introduced = previous?.introduced ?? false;
        // A refusal keeps the sequence number the relay last accepted; either keeps how far its introduction has got.
        kept[relay] = accepted
          ? { ...previous, at: now, seq, failures: 0, introduced }
          : { ...previous, at: now, seq: previous?.seq ?? null, failures: (previous?.failures ?? 0) + 1, introduced };
      }
    }
    // Most runs ask no relay, and leave the record as it was.
    if (JSON.stringify(kept) !== JSON.stringify(current)) this.ctx.storage.kv.put(RELAYS_KEY, kept);
    if (joined.length > 0) this.introduce(joined, batch);
    return due;
  }

  /** Accepts a com.atproto.sync.subscribeRepos WebSocket and replays from its cursor. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "InvalidRequest", message: "Expected a WebSocket upgrade" }, { status: 400 });
    }
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && !/^\d+$/.test(cursor)) {
      return Response.json({ error: "InvalidRequest", message: "cursor must be a non-negative integer" }, { status: 400 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SUBSCRIBERS) {
      return Response.json({ error: "RateLimitExceeded", message: "The firehose has too many subscribers" }, { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (cursor !== null) this.replay(server, Number(cursor));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // The firehose only sends.
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // The socket is already closed.
    }
  }

  /**
   * Sends the retained frames after cursor, up to REPLAY_BYTES and always at
   * least one, and closes a subscription it didn't bring up to date. It never
   * awaits, so no append interleaves with it.
   */
  private replay(ws: WebSocket, cursor: number): void {
    if (cursor > this.latestSeq()) {
      ws.send(errorFrame("FutureCursor", "Cursor is in the future"));
      ws.close(1008, "FutureCursor");
      return;
    }
    const earliest = this.ctx.storage.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events").one().seq;
    let after = cursor;
    if (earliest !== null && cursor < earliest - 1) {
      ws.send(infoFrame("OutdatedCursor", "Requested cursor exceeded retention window; some events skipped"));
      after = earliest - 1;
    }
    let sent = 0;
    for (;;) {
      const page = this.ctx.storage.sql.exec<{ seq: number; frame: ArrayBuffer }>(
        "SELECT seq, frame FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        REPLAY_PAGE,
      );
      let rows = 0;
      for (const row of page) {
        if (sent > 0 && sent + row.frame.byteLength > REPLAY_BYTES) {
          ws.close(1013, "ReplayLimit");
          return;
        }
        ws.send(row.frame);
        sent += row.frame.byteLength;
        after = row.seq;
        rows += 1;
      }
      if (rows < REPLAY_PAGE) return;
    }
  }

  private broadcast(frame: Uint8Array): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch (error) {
        console.warn("Skipping a firehose subscriber that cannot receive", error);
      }
    }
  }

  /**
   * Introduces the next batch of active accounts, in DID order, to relays that
   * joined after them, with what activating each account announced: #account,
   * #identity, and #sync at the latest commit the firehose keeps for the
   * repository, so introducing wakes no repository. One batch serves
   * every relay that has got as far as the first one waiting; the others wait
   * for later runs. The batch's frames and how far each relay has got commit in one
   * transaction, so a relay hears each account once, even across restarts, and
   * is introduced once a batch comes up short.
   */
  private introduce(relays: readonly string[], batch: number): void {
    // Nothing here awaits, so no other event lands between reading a batch and committing it: an account taken down or
    // deleted first is left out, and one changed after reaches relays after its introduction.
    const requests = this.relayRequests();
    const waiting = relays.filter((relay) => requests[relay] && !requests[relay].introduced);
    const [first] = waiting;
    if (!first) return;
    const begun = requests[first]?.cursor;
    const sharing = waiting.filter((relay) => JSON.stringify(requests[relay]?.cursor) === JSON.stringify(begun));
    const from: IntroductionCursor = begun ?? {
      through: this.ctx.storage.sql.exec<{ through: number | null }>("SELECT MAX(rowid) AS through FROM repos").one().through ?? 0,
      after: "",
    };
    const accounts = this.ctx.storage.sql.exec<Pick<RepoRow, "did" | "sync_rev" | "sync_blocks">>(
      "SELECT did, sync_rev, sync_blocks FROM repos WHERE rowid <= ? AND did > ? AND active = 1 AND head IS NOT NULL ORDER BY did LIMIT ?",
      from.through,
      from.after,
      batch,
    ).toArray();
    // A full batch may leave accounts after its last; a short one ends the introduction.
    const next = accounts.length < batch ? undefined : accounts.at(-1)?.did;
    const appendedAt = Date.now();
    const time = new Date(appendedAt).toISOString();
    const frames: Uint8Array[] = [];
    this.ctx.storage.transactionSync(() => {
      let seq = this.latestSeq();
      for (const account of accounts) {
        const { did } = account;
        const head = storedHead(account);
        const events: Array<{ t: string; body: object }> = [
          { t: "#account", body: { did, active: true, time } },
          { t: "#identity", body: { did, time } },
        ];
        // Only a repository whose last commit aged out before the firehose kept commits has none; relays get its head with its next commit.
        if (head) events.push({ t: "#sync", body: { did, rev: head.rev, blocks: head.blocks, time } });
        for (const { t, body } of events) {
          seq += 1;
          const frame = frameBytes(encode({ op: 1, t }), encode({ ...body, seq }));
          this.ctx.storage.sql.exec("INSERT INTO events (seq, did, frame, appended_at) VALUES (?, ?, ?, ?)", seq, did, frame, appendedAt);
          frames.push(frame);
        }
      }
      this.ctx.storage.sql.exec("UPDATE sequence SET seq = ?", seq);
      for (const relay of sharing) {
        const { at, seq: accepted, failures } = requests[relay];
        requests[relay] = next === undefined
          ? { at, seq: accepted, failures, introduced: true }
          : { at, seq: accepted, failures, introduced: false, cursor: { through: from.through, after: next } };
      }
      this.ctx.storage.kv.put(RELAYS_KEY, requests);
    });
    for (const frame of frames) this.broadcast(frame);
  }

  /** The host's last request to each relay, by the relay's origin. */
  private relayRequests(): Record<string, RelayRequest> {
    return this.ctx.storage.kv.get<Record<string, RelayRequest>>(RELAYS_KEY) ?? {};
  }

  private latestSeq(): number {
    return this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM sequence").one().seq;
  }

  private row(query: string, value: string): RepoRow | null {
    return this.ctx.storage.sql.exec<RepoRow>(query, value).toArray()[0] ?? null;
  }
}

/**
 * Has the host's firehose ask each relay the deployment names to crawl it,
 * when a request to that relay is due. With none named, the firehose forgets
 * the relays it knew.
 */
export async function announceToRelays(env: HostEnv): Promise<void> {
  const relays = [...new Set((env.PDS_RELAYS ?? "").split(",").map((relay) => relay.trim()).filter(Boolean))];
  await env.FIREHOSE.getByName(FIREHOSE_NAME).announce(relays, new URL(env.PDS_ORIGIN).host);
}

/** Encodes an outbox event as a subscribeRepos frame that carries the host's sequence number. */
function eventFrame(type: OutboxEvent["type"], body: EventBody, seq: number): Uint8Array {
  return frameBytes(encode({ op: 1, t: `#${type}` }), encode({ ...body, seq }));
}

/** The head a #commit or #sync leaves its repository at, as a #sync carries it. */
function eventHead(type: string, body: EventBody): RepoHead | null {
  if (body.rev === undefined || body.blocks === undefined) return null;
  if (type === "sync") return { rev: body.rev, blocks: body.blocks };
  if (type === "commit" && body.commit) return { rev: body.rev, blocks: commitCar(body.blocks, body.commit) };
  return null;
}

/**
 * The CAR a #sync carries for a commit: the header of the commit's own CAR,
 * which names the commit as its first root, and the commit's block, without the
 * records and tree nodes a #commit carries so relays can check its operations.
 */
function commitCar(car: Uint8Array, commit: CidLink): Uint8Array {
  const root = fromCidLink(commit);
  const [headerLength, headerStart] = varint(car, 0);
  const blocksStart = headerStart + headerLength;
  for (let offset = blocksStart; offset < car.length;) {
    const [length, start] = varint(car, offset);
    const end = start + length;
    const [cid] = decodeCid(car.subarray(start, end));
    if (sameCid(cid, root)) {
      const head = new Uint8Array(blocksStart + end - offset);
      head.set(car.subarray(0, blocksStart));
      head.set(car.subarray(offset, end), blocksStart);
      return head;
    }
    offset = end;
  }
  throw new Error(`The CAR of commit ${commit.$link} doesn't hold the commit`);
}

/** Reads the unsigned varint at offset that frames a CAR's header and each block, and the offset after it. */
function varint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  for (let index = offset, scale = 1; index < bytes.length; index += 1, scale *= 128) {
    const byte = bytes[index];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, index + 1];
  }
  throw new Error("A CAR ends inside a varint");
}

function storedHead(row: Pick<RepoRow, "sync_rev" | "sync_blocks">): RepoHead | null {
  return row.sync_rev !== null && row.sync_blocks !== null ? { rev: row.sync_rev, blocks: new Uint8Array(row.sync_blocks) } : null;
}

/**
 * Keeps each active repository's latest commit from the frames the firehose
 * still retains, reading them newest first and stopping once every repository
 * has one. A repository whose last #commit or #sync has aged out keeps none
 * until its next.
 */
function keepRetainedHeads(sql: SqlStorage): void {
  const waiting = new Set(sql.exec<{ did: string }>(
    "SELECT did FROM repos WHERE active = 1 AND head IS NOT NULL",
  ).toArray().map((row) => row.did));
  const heads = new Map<string, RepoHead>();
  for (const { did, frame } of sql.exec<{ did: string; frame: ArrayBuffer }>("SELECT did, frame FROM events ORDER BY seq DESC")) {
    if (heads.size === waiting.size) break;
    if (!waiting.has(did) || heads.has(did)) continue;
    const head = frameHead(new Uint8Array(frame));
    if (head) heads.set(did, head);
  }
  for (const [did, { rev, blocks }] of heads) {
    sql.exec("UPDATE repos SET sync_rev = ?, sync_blocks = ? WHERE did = ?", rev, blocks, did);
  }
}

/** The head a stored #commit or #sync frame left its repository at. */
function frameHead(frame: Uint8Array): RepoHead | null {
  // SAFETY: the firehose stores only frames it encoded, each a header naming the event's type and then the event's body.
  const [header, body] = decodeFirst(frame) as [{ t?: string }, Uint8Array];
  if (header.t !== "#commit" && header.t !== "#sync") return null;
  // SAFETY: the firehose encoded the body from the engine Sequencer's own event body.
  return eventHead(header.t.slice(1), decode(body) as EventBody);
}

function errorFrame(error: string, message: string): Uint8Array {
  return frameBytes(encode({ op: -1 }), encode({ error, message }));
}

function infoFrame(name: string, message: string): Uint8Array {
  return frameBytes(encode({ op: 1, t: "#info" }), encode({ name, message }));
}

function frameBytes(header: Uint8Array, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

function repoState(row: RepoRow): RepoState {
  return {
    did: row.did,
    handle: row.handle,
    active: row.active === 1,
    status: accountStatus(row.status),
    rev: row.rev,
    head: row.head,
  };
}

function accountStatus(value: string | null): AccountStatus | null {
  if (value === null) return null;
  const status = ACCOUNT_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new Error(`Unknown account status ${value}`);
  return status;
}
