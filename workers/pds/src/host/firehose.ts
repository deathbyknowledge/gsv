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
export type RepoHead = { rev: string; blocks: Uint8Array };

export type RepoListing = { repos: RepoState[]; cursor?: string };

/** Frames older than this are pruned; a cursor before them gets #info OutdatedCursor. */
const RETENTION_MS = 72 * 60 * 60_000;
const REPLAY_PAGE = 500;
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
      for (const event of events) {
        if (event.seq <= delivered) continue;
        seq += 1;
        const frame = eventFrame(event, seq);
        this.ctx.storage.sql.exec(
          "INSERT INTO events (seq, did, frame, appended_at) VALUES (?, ?, ?, ?)",
          seq,
          state.did,
          frame,
          appendedAt,
        );
        frames.push(frame);
        delivered = event.seq;
      }
      this.ctx.storage.sql.exec("UPDATE sequence SET seq = ?", seq);
      this.ctx.storage.sql.exec(
        `INSERT INTO repos (did, name, handle, active, status, rev, head, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, active = excluded.active, status = excluded.status,
           rev = excluded.rev, head = excluded.head, delivered = excluded.delivered`,
        state.did,
        name,
        state.handle,
        state.active ? 1 : 0,
        state.status,
        state.rev,
        state.head,
        delivered,
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
    if (joined.length > 0) await this.introduce(joined, batch);
    return due;
  }

  /** The relays the host remembers asking. */
  async relays(): Promise<string[]> {
    return Object.keys(this.relayRequests());
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

  /** Sends every retained frame after cursor. It never awaits, so no append interleaves with it. */
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
    for (;;) {
      const page = this.ctx.storage.sql.exec<{ seq: number; frame: ArrayBuffer }>(
        "SELECT seq, frame FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        REPLAY_PAGE,
      ).toArray();
      for (const row of page) {
        ws.send(row.frame);
        after = row.seq;
      }
      if (page.length < REPLAY_PAGE) return;
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
   * #identity, and #sync at the repository's current head. One batch serves
   * every relay that has got as far as the first one waiting; the others wait
   * for later runs. The batch's frames and how far each relay has got commit in one
   * transaction, so a relay hears each account once, even across restarts, and
   * is introduced once a batch comes up short.
   */
  private async introduce(relays: readonly string[], batch: number): Promise<void> {
    const requests = this.relayRequests();
    const waiting = relays.filter((relay) => requests[relay] && !requests[relay].introduced);
    const [first] = waiting;
    if (!first) return;
    const begun = requests[first]?.cursor;
    const along = (request: RelayRequest | undefined) => request !== undefined && !request.introduced
      && JSON.stringify(request.cursor) === JSON.stringify(begun);
    const sharing = waiting.filter((relay) => along(requests[relay]));
    const from: IntroductionCursor = begun ?? {
      through: this.ctx.storage.sql.exec<{ through: number | null }>("SELECT MAX(rowid) AS through FROM repos").one().through ?? 0,
      after: "",
    };
    const accounts = this.ctx.storage.sql.exec<{ did: string; name: string }>(
      "SELECT did, name FROM repos WHERE rowid <= ? AND did > ? AND active = 1 AND head IS NOT NULL ORDER BY did LIMIT ?",
      from.through,
      from.after,
      batch,
    ).toArray();
    const heads = await Promise.all(accounts.map(async ({ did, name }) => ({ did, head: await this.env.REPOS.getByName(name).head() })));
    // A full batch may leave accounts after its last; a short one ends the introduction.
    const next = accounts.length < batch ? undefined : accounts.at(-1)?.did;
    const appendedAt = Date.now();
    const time = new Date(appendedAt).toISOString();
    const frames: Uint8Array[] = [];
    this.ctx.storage.transactionSync(() => {
      const current = this.relayRequests();
      // Another run may have introduced this batch while the heads were read.
      const introducing = sharing.flatMap((relay) => {
        const request = current[relay];
        return along(request) ? [[relay, request] as const] : [];
      });
      if (introducing.length === 0) return;
      let seq = this.latestSeq();
      for (const { did, head } of heads) {
        // An account taken down or deleted while its head was read stays as its own last event left it.
        if (!head || !this.row("SELECT * FROM repos WHERE did = ? AND active = 1", did)) continue;
        const events = [
          { t: "#account", body: { did, active: true, time } },
          { t: "#identity", body: { did, time } },
          { t: "#sync", body: { did, rev: head.rev, blocks: head.blocks, time } },
        ];
        for (const { t, body } of events) {
          seq += 1;
          const frame = frameBytes(encode({ op: 1, t }), encode({ ...body, seq }));
          this.ctx.storage.sql.exec("INSERT INTO events (seq, did, frame, appended_at) VALUES (?, ?, ?, ?)", seq, did, frame, appendedAt);
          frames.push(frame);
        }
      }
      this.ctx.storage.sql.exec("UPDATE sequence SET seq = ?", seq);
      for (const [relay, { at, seq: accepted, failures }] of introducing) {
        current[relay] = next === undefined
          ? { at, seq: accepted, failures, introduced: true }
          : { at, seq: accepted, failures, introduced: false, cursor: { through: from.through, after: next } };
      }
      this.ctx.storage.kv.put(RELAYS_KEY, current);
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
 * the relays it remembers, and has nothing to do once it remembers none.
 */
export async function announceToRelays(env: HostEnv): Promise<void> {
  const relays = [...new Set((env.PDS_RELAYS ?? "").split(",").map((relay) => relay.trim()).filter(Boolean))];
  const firehose = env.FIREHOSE.getByName(FIREHOSE_NAME);
  if (relays.length === 0 && (await firehose.relays()).length === 0) return;
  await firehose.announce(relays, new URL(env.PDS_ORIGIN).host);
}

/** Encodes an outbox event as a subscribeRepos frame that carries the host's sequence number. */
function eventFrame(event: OutboxEvent, seq: number): Uint8Array {
  // SAFETY: outbox payloads are the engine Sequencer's own CBOR encoding of an event body.
  const body = decode(event.payload) as Omit<SeqEvent["event"], "seq">;
  return frameBytes(encode({ op: 1, t: `#${event.type}` }), encode({ ...body, seq }));
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
