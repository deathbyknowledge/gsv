import { DurableObject } from "cloudflare:workers";
import { decode, encode } from "../cirrus/cbor-compat";
import type { AccountStatus, SeqEvent } from "../cirrus/repo/sequencer";
import type { HostEnv } from "./env";
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

export type RepoListing = { repos: RepoState[]; cursor?: string };

/** Frames older than this are pruned; a cursor before them gets #info OutdatedCursor. */
const RETENTION_MS = 72 * 60 * 60_000;
const REPLAY_PAGE = 500;
const ACCOUNT_STATUSES = ["takendown", "suspended", "deleted", "deactivated"] as const;

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

  private latestSeq(): number {
    return this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM sequence").one().seq;
  }

  private row(query: string, value: string): RepoRow | null {
    return this.ctx.storage.sql.exec<RepoRow>(query, value).toArray()[0] ?? null;
  }
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
