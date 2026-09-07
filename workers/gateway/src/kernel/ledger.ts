import { z } from "zod";
import type { ResponseFrame } from "../protocol/frames";
import type { SysLedgerLine, SysLedgerListArgs, SysLedgerListResult, SysLedgerOutcome } from "@humansandmachines/gsv/protocol";

/**
 * The ledger is the Kernel's record of what ran: one line per dispatched
 * syscall, written when the call is dispatched and completed when its response
 * is known. The active window stays small; closed lines rotate into immutable
 * segments in the installation's R2 storage, and an index of those segments
 * stays here so reads can page across both and skip segments by owner,
 * process, or place.
 *
 * Lines carry the call's arguments as sent, whole, capped only by size: the
 * ledger is the owner's own record of what ran, and a record that leaves out
 * the input is not one.
 */

export const LEDGER_WINDOW_ROWS = 5_000;
export const LEDGER_WINDOW_AGE_MS = 24 * 60 * 60 * 1000;
/** Lines older than this leave the window without a segment; keep it equal to the bucket's lifecycle rule. */
export const LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const LEDGER_SEGMENT_ROWS = 2_000;
/** A segment closes early past this many encoded bytes, so a read that holds a few segments stays small. */
export const LEDGER_SEGMENT_BYTES = 4 * 1024 * 1024;
/** Index entries checked or expired per alarm, so housekeeping stays a bounded amount of storage work. */
export const LEDGER_PRUNE_PER_ALARM = 25;
/** Index rows a read fetches at a time while looking for segments that may match. */
export const LEDGER_INDEX_BATCH = 32;
/** The missing-object repair moves on to the next batch of the index once a day. */
const REPAIR_STEP_MS = 24 * 60 * 60 * 1000;
/** Characters of JSON text a line keeps of its arguments; the cut is marked. */
export const LEDGER_ARGS_LIMIT = 16_384;
export const LEDGER_ID_LIMIT = 128;
export const LEDGER_LIST_MAX = 200;
export const LEDGER_SEGMENTS_PER_READ = 4;
export const LEDGER_OBJECT_PREFIX = "ledger/";
/** Distinct pids, targets, or owners an index entry lists before it stops promising anything. */
export const LEDGER_INDEX_SET_LIMIT = 64;
const WALK_PAGES_LIMIT = 16;
const ROTATIONS_PER_ALARM = 8;
const DELETE_CHUNK = 50;

export type LedgerOutcome = SysLedgerOutcome;
export type LedgerLine = SysLedgerLine;

export type LedgerAppend = {
  requestId: string;
  timestamp: number;
  principalKind: string;
  uid: number;
  ownerUid: number;
  pid: string | null;
  runId: string | null;
  target: string;
  call: string;
  args: string;
};

export type LedgerCompletion = {
  outcome: LedgerOutcome;
  tokens?: number | null;
  costNanoUsd?: number | null;
};

export type LedgerSegment = {
  seq: number;
  firstSeq: number;
  objectKey: string;
  firstTs: number;
  lastTs: number;
  rowCount: number;
  bytes: number;
  /** The owner uids present, or null when there were too many to list: the segment must then be read. */
  uids: number[] | null;
  pids: string[] | null;
  targets: string[] | null;
  createdAt: number;
};

export type LedgerQuery = {
  /** The owner uid whose lines may be read, or null for every line (root). */
  ownerUid: number | null;
  pid?: string;
  target?: string;
  callPrefix?: string;
  since?: number;
  until?: number;
  limit: number;
  cursor?: string;
};

export type RotationResult =
  | { rotated: false; reason: "nothing-closed" }
  | { rotated: true; segment: LedgerSegment };

type WindowRow = {
  seq: number;
  request_id: string;
  ts: number;
  principal_kind: string;
  uid: number;
  owner_uid: number;
  pid: string | null;
  run_id: string | null;
  target: string;
  call: string;
  args: string;
  outcome: string | null;
  duration_ms: number | null;
  tokens: number | null;
  cost_nano_usd: number | null;
};

type SegmentRow = {
  seq: number;
  first_seq: number;
  object_key: string;
  first_ts: number;
  last_ts: number;
  row_count: number;
  bytes: number;
  uids: string | null;
  pids: string | null;
  targets: string | null;
  created_at: number;
};

/** Everything a segment line needs to say, including who may read it. */
type StoredLine = LedgerLine & { ownerUid: number };

const outcomeSchema = z.enum(["ok", "failed", "denied", "cancelled"]);
const storedLineSchema = z.object({
  seq: z.number().int(),
  timestamp: z.number(),
  principalKind: z.string(),
  uid: z.number().int(),
  ownerUid: z.number().int(),
  pid: z.string().nullable(),
  runId: z.string().nullable(),
  target: z.string(),
  call: z.string(),
  args: z.string(),
  outcome: outcomeSchema.nullable(),
  durationMs: z.number().nullable(),
  tokens: z.number().nullable().optional(),
  costNanoUsd: z.number().nullable().optional(),
});
const stringListSchema = z.array(z.string());
const numberListSchema = z.array(z.number());

/* ---------- the input: the call's arguments as sent, capped by size ---------- */

/** Truncates to `limit` characters, marking the cut so a reader knows the line was longer. */
export function capField(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * The call's arguments as JSON text, whole. A line longer than the limit is
 * cut and the cut marked; `JSON.parse` failing on a line is how a reader
 * knows it was cut.
 */
export function argsText(args: JsonLike): string {
  return capField(JSON.stringify(args ?? null), LEDGER_ARGS_LIMIT);
}

const targetArgSchema = z.object({ target: z.string().min(1).optional(), sessionId: z.string().min(1).optional() });

/**
 * The place a call went to: its `target` argument, else the target of the
 * shell session it continues, else the cloud home. Capped either way.
 */
export function ledgerTargetOf(args: JsonLike, sessionTarget: (sessionId: string) => string | null = () => null): string {
  const parsed = targetArgSchema.safeParse(args);
  if (!parsed.success) return "gsv";
  const target = parsed.data.target ?? (parsed.data.sessionId ? sessionTarget(parsed.data.sessionId) : null);
  return target ? capField(target, LEDGER_ID_LIMIT) : "gsv";
}

/** JSON as it arrives on the wire; the redactor parses what it needs at the boundary. */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike } | undefined;

/** The outcome of a response frame, in the ledger's four words. */
export function outcomeOfResponse(frame: ResponseFrame): LedgerOutcome {
  if (frame.ok) return "ok";
  const code = frame.error.code;
  if (code === 403) return "denied";
  if (code === 499) return "cancelled";
  return "failed";
}

/** The usage an ai.text.generate result carries: on its assistant message, with cost in USD. */
const aiResultUsageSchema = z.object({
  message: z.object({
    usage: z.object({
      totalTokens: z.number().optional(),
      input: z.number().optional(),
      output: z.number().optional(),
      cost: z.object({ total: z.number().optional() }).optional(),
    }),
  }),
});

const NANO = 1_000_000_000;

/** Tokens and cost when a response carries usage, as ai.text.generate does. */
export function usageOfResponse(frame: ResponseFrame): Pick<LedgerCompletion, "tokens" | "costNanoUsd"> {
  if (!frame.ok) return {};
  const parsed = aiResultUsageSchema.safeParse(frame.data);
  if (!parsed.success) return {};
  const usage = parsed.data.message.usage;
  const tokens = usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) || null);
  const total = usage.cost?.total;
  return {
    tokens,
    costNanoUsd: total === undefined ? null : Math.round(total * NANO),
  };
}

function segmentKey(lastSeq: number): string {
  return `${LEDGER_OBJECT_PREFIX}${String(lastSeq).padStart(12, "0")}.jsonl`;
}

function rowToStored(row: WindowRow): StoredLine {
  const outcome = outcomeSchema.safeParse(row.outcome);
  return {
    seq: row.seq,
    timestamp: row.ts,
    principalKind: row.principal_kind,
    uid: row.uid,
    ownerUid: row.owner_uid,
    pid: row.pid,
    runId: row.run_id,
    target: row.target,
    call: row.call,
    args: row.args,
    outcome: outcome.success ? outcome.data : null,
    durationMs: row.duration_ms,
    tokens: row.tokens,
    costNanoUsd: row.cost_nano_usd,
  };
}

function segmentFromRow(row: SegmentRow): LedgerSegment {
  const uids = row.uids === null ? null : numberListSchema.safeParse(JSON.parse(row.uids));
  const pids = row.pids === null ? null : stringListSchema.safeParse(JSON.parse(row.pids));
  const targets = row.targets === null ? null : stringListSchema.safeParse(JSON.parse(row.targets));
  return {
    seq: row.seq,
    firstSeq: row.first_seq,
    objectKey: row.object_key,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    rowCount: row.row_count,
    bytes: row.bytes,
    uids: uids === null ? null : uids.success ? uids.data : [],
    pids: pids === null ? null : pids.success ? pids.data : [],
    targets: targets === null ? null : targets.success ? targets.data : [],
    createdAt: row.created_at,
  };
}

function publicLine(line: StoredLine): LedgerLine {
  const { ownerUid: _ownerUid, ...rest } = line;
  return rest;
}

function matches(line: StoredLine, query: LedgerQuery): boolean {
  if (query.ownerUid !== null && line.ownerUid !== query.ownerUid) return false;
  if (query.pid !== undefined && line.pid !== query.pid) return false;
  if (query.target !== undefined && line.target !== query.target) return false;
  if (query.callPrefix !== undefined && !line.call.startsWith(query.callPrefix)) return false;
  if (query.since !== undefined && line.timestamp < query.since) return false;
  if (query.until !== undefined && line.timestamp > query.until) return false;
  return true;
}

/**
 * A walk is a series of pages. Each page that read the window remembers the
 * newest segment that existed at the time (`segTop`) and the lowest window seq
 * it examined (`low`, 0 once the window was exhausted): every window line at
 * or above `low` had been seen by then. A segment created after a page holds
 * lines that were in the window at that page, so reading it skips seqs at or
 * above the `low` of the latest page that predates the segment, and returns
 * the rest; segments older than the walk are read whole. That is what makes a
 * rotation between two pages neither repeat a line nor lose one. The cursor
 * carries those pages and a position: `<segTop>.<low>[,...]|w` continues in
 * the window below the last `low`; `<segTop>.<low>[,...]|s<segmentSeq>.<offset>`
 * continues inside a segment.
 */
type WalkPage = { segTop: number; low: number };
type Cursor = { pages: WalkPage[]; segment: { seq: number; offset: number } | null };

function parseCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  const match = cursor.match(/^(\d+\.\d+(?:,\d+\.\d+)*)\|(w|s\d+\.\d+)$/);
  if (!match) throw new Error("Invalid ledger cursor");
  const pages = match[1].split(",").map((pair) => {
    const [segTop, low] = pair.split(".");
    return { segTop: Number(segTop), low: Number(low) };
  });
  if (match[2] === "w") return { pages, segment: null };
  const [seq, offset] = match[2].slice(1).split(".");
  return { pages, segment: { seq: Number(seq), offset: Number(offset) } };
}

function formatCursor(pages: WalkPage[], segment: { seq: number; offset: number } | null): string {
  const head = pages.map((page) => `${page.segTop}.${page.low}`).join(",");
  return segment ? `${head}|s${segment.seq}.${segment.offset}` : `${head}|w`;
}

/** Records a window page; pages that saw the same segments collapse into one, the oldest are forgotten past the limit. */
function notePage(pages: WalkPage[], segTop: number, low: number): void {
  const last = pages[pages.length - 1];
  if (last && last.segTop === segTop) {
    last.low = Math.min(last.low, low);
  } else {
    pages.push({ segTop, low });
  }
  while (pages.length > WALK_PAGES_LIMIT) pages.shift();
}

/** The seq from which a segment's lines were already seen in the window, or null when the segment predates the walk. */
function examinedFrom(pages: WalkPage[], segment: LedgerSegment): number | null {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (pages[index].segTop < segment.seq) return pages[index].low;
  }
  return null;
}

/** The three things the ledger asks of the installation's storage; an R2 bucket satisfies it as is. */
export type LedgerObjectStore = {
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<{ key: string } | null>;
  delete(key: string): Promise<void>;
};

export class LedgerStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: Pick<DurableObjectStorage, "transactionSync">,
    /** The installation's object store; swapped in tests to make writes fail. */
    public bucket: LedgerObjectStore,
  ) {}

  /* ---------- the active window ---------- */

  /**
   * The seq of each line still open, by its full request id. Request ids are
   * capped in the row, so two open requests sharing a long prefix would meet
   * in SQL; here they never do. The map only outlives a line by a restart,
   * after which completion falls back to the capped id.
   */
  private readonly open = new Map<string, number>();

  /** Writes an open line. Every client-controlled field is capped here, whatever the caller checked. */
  append(entry: LedgerAppend): number {
    this.sql.exec(
      `INSERT INTO ledger_window
       (request_id, ts, principal_kind, uid, owner_uid, pid, run_id, target, call, args)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      capField(entry.requestId, LEDGER_ID_LIMIT),
      entry.timestamp,
      capField(entry.principalKind, 32),
      entry.uid,
      entry.ownerUid,
      entry.pid === null ? null : capField(entry.pid, LEDGER_ID_LIMIT),
      entry.runId === null ? null : capField(entry.runId, LEDGER_ID_LIMIT),
      capField(entry.target, LEDGER_ID_LIMIT),
      capField(entry.call, LEDGER_ID_LIMIT),
      capField(entry.args, LEDGER_ARGS_LIMIT),
    );
    const [row] = [...this.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")];
    const seq = row?.seq ?? 0;
    this.open.set(entry.requestId, seq);
    while (this.open.size > LEDGER_WINDOW_ROWS) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.open.delete(oldest);
    }
    return seq;
  }

  /** Completes the request's own open line; returns false when nothing was open. */
  complete(requestId: string, completion: LedgerCompletion, now = Date.now()): boolean {
    const known = this.open.get(requestId);
    this.open.delete(requestId);
    const [open] = known === undefined
      ? [...this.sql.exec<{ seq: number; ts: number }>(
        "SELECT seq, ts FROM ledger_window WHERE request_id = ? AND outcome IS NULL ORDER BY seq DESC LIMIT 1",
        capField(requestId, LEDGER_ID_LIMIT),
      )]
      : [...this.sql.exec<{ seq: number; ts: number }>("SELECT seq, ts FROM ledger_window WHERE seq = ? AND outcome IS NULL", known)];
    if (!open) return false;
    this.sql.exec(
      "UPDATE ledger_window SET outcome = ?, duration_ms = ?, tokens = ?, cost_nano_usd = ? WHERE seq = ?",
      completion.outcome,
      Math.max(0, now - open.ts),
      completion.tokens ?? null,
      completion.costNanoUsd ?? null,
      open.seq,
    );
    return true;
  }

  windowCount(): number {
    const [row] = [...this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_window")];
    return row?.n ?? 0;
  }

  oldestTimestamp(): number | null {
    const [row] = [...this.sql.exec<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM ledger_window")];
    return row?.ts ?? null;
  }

  /** True when the window holds more rows than its bound. Age alone never rotates: a quiet installation keeps its lines in SQL. */
  needsRotation(): boolean {
    return this.windowCount() > LEDGER_WINDOW_ROWS;
  }

  /** Closes as cancelled every line still open past the window age; returns how many. */
  closeStale(now = Date.now()): number {
    return this.sql.exec(
      "UPDATE ledger_window SET outcome = 'cancelled', duration_ms = NULL WHERE outcome IS NULL AND ts < ?",
      now - LEDGER_WINDOW_AGE_MS,
    ).rowsWritten;
  }

  /** Drops lines past retention that never needed a segment, so the window keeps the bucket's promise; returns how many. */
  pruneExpired(now = Date.now()): number {
    return this.sql.exec("DELETE FROM ledger_window WHERE ts < ?", now - LEDGER_RETENTION_MS).rowsWritten;
  }

  /* ---------- rotation ---------- */

  /**
   * Moves the oldest lines, in seq order, into one segment object, then in one
   * transaction removes exactly those lines from the window and records the
   * segment. Rotation stops at the first line still open within the window
   * age, so a segment is always a contiguous range below everything left in
   * the window: that is what keeps a read newest-first across the two. An open
   * line older than the window age is closed as cancelled on the way out. The
   * rows are captured before the object write, and only those seqs are
   * deleted; a failed object write leaves the window untouched. Whether to
   * rotate at all is `rotate`'s decision; this moves one segment when asked.
   */
  async rotateOnce(now = Date.now()): Promise<RotationResult> {
    const cutoff = now - LEDGER_WINDOW_AGE_MS;
    const rows = [...this.sql.exec<WindowRow>(
      `SELECT * FROM ledger_window
       WHERE seq < COALESCE((SELECT MIN(seq) FROM ledger_window WHERE outcome IS NULL AND ts >= ?), ?)
       ORDER BY seq ASC
       LIMIT ?`,
      cutoff,
      Number.MAX_SAFE_INTEGER,
      LEDGER_SEGMENT_ROWS,
    )];
    if (rows.length === 0) return { rotated: false, reason: "nothing-closed" };

    // a segment closes at its row bound or its size bound, whichever comes first, and always holds at least one line
    const lines: StoredLine[] = [];
    const encoded: string[] = [];
    const encoder = new TextEncoder();
    let used = 0;
    for (const row of rows) {
      const stored = rowToStored(row);
      const line = stored.outcome === null ? { ...stored, outcome: "cancelled" as const, durationMs: null } : stored;
      const text = JSON.stringify(line);
      const size = encoder.encode(text).byteLength + 1;
      if (lines.length > 0 && used + size > LEDGER_SEGMENT_BYTES) break;
      lines.push(line);
      encoded.push(text);
      used += size;
    }
    const seqs = lines.map((line) => line.seq);
    const body = encoded.join("\n") + "\n";
    const lastSeq = seqs[seqs.length - 1];
    const key = segmentKey(lastSeq);
    const bytes = used;
    await this.bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });

    const segment: LedgerSegment = {
      seq: lastSeq,
      firstSeq: seqs[0],
      objectKey: key,
      firstTs: Math.min(...lines.map((line) => line.timestamp)),
      lastTs: Math.max(...lines.map((line) => line.timestamp)),
      rowCount: lines.length,
      bytes,
      uids: cappedSet([...new Set(lines.map((line) => line.ownerUid))].sort((a, b) => a - b)),
      pids: cappedSet([...new Set(lines.flatMap((line) => (line.pid ? [line.pid] : [])))].sort()),
      targets: cappedSet([...new Set(lines.map((line) => line.target))].sort()),
      createdAt: now,
    };
    this.storage.transactionSync(() => {
      for (let start = 0; start < seqs.length; start += DELETE_CHUNK) {
        const chunk = seqs.slice(start, start + DELETE_CHUNK);
        this.sql.exec(`DELETE FROM ledger_window WHERE seq IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      }
      this.sql.exec(
        `INSERT INTO ledger_segments
         (seq, first_seq, object_key, first_ts, last_ts, row_count, bytes, uids, pids, targets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        segment.seq,
        segment.firstSeq,
        segment.objectKey,
        segment.firstTs,
        segment.lastTs,
        segment.rowCount,
        segment.bytes,
        segment.uids === null ? null : JSON.stringify(segment.uids),
        segment.pids === null ? null : JSON.stringify(segment.pids),
        segment.targets === null ? null : JSON.stringify(segment.targets),
        segment.createdAt,
      );
    });
    return { rotated: true, segment };
  }

  /** Rotates while the window is over its row bound, until the per-alarm budget is spent. */
  async rotate(now = Date.now()): Promise<LedgerSegment[]> {
    const written: LedgerSegment[] = [];
    for (let i = 0; i < ROTATIONS_PER_ALARM; i += 1) {
      if (!this.needsRotation()) break;
      const result = await this.rotateOnce(now);
      if (!result.rotated) break;
      written.push(result.segment);
    }
    return written;
  }

  /** The index, newest first, narrowed to the entries that overlap the time bounds when the query has them. */
  segments(bounds: { since?: number; until?: number } = {}): LedgerSegment[] {
    const where: string[] = [];
    const params: number[] = [];
    if (bounds.since !== undefined) {
      where.push("last_ts >= ?");
      params.push(bounds.since);
    }
    if (bounds.until !== undefined) {
      where.push("first_ts <= ?");
      params.push(bounds.until);
    }
    const filter = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    return [...this.sql.exec<SegmentRow>(`SELECT * FROM ledger_segments${filter} ORDER BY seq DESC`, ...params)].map(segmentFromRow);
  }

  /** The index from `belowOrAt` downward, newest first, narrowed by time bounds, one batch. */
  private segmentsFrom(belowOrAt: number, bounds: { since?: number; until?: number }, limit: number): LedgerSegment[] {
    const where: string[] = ["seq <= ?"];
    const params: number[] = [belowOrAt];
    if (bounds.since !== undefined) {
      where.push("last_ts >= ?");
      params.push(bounds.since);
    }
    if (bounds.until !== undefined) {
      where.push("first_ts <= ?");
      params.push(bounds.until);
    }
    return [...this.sql.exec<SegmentRow>(
      `SELECT * FROM ledger_segments WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit,
    )].map(segmentFromRow);
  }

  private newestSegmentSeq(): number {
    const row = this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM ledger_segments").one();
    return row.seq ?? 0;
  }

  /**
   * Deletes the oldest segments whose every line is past retention, object
   * first and then its index entry, a bounded number per alarm. The Kernel
   * keeps the retention promise itself; a bucket lifecycle rule is optional.
   */
  async pruneExpiredSegments(now = Date.now()): Promise<number> {
    const cutoff = now - LEDGER_RETENTION_MS;
    const expired = this.segments().filter((segment) => segment.lastTs < cutoff).slice(-LEDGER_PRUNE_PER_ALARM);
    for (const segment of expired) {
      await this.bucket.delete(segment.objectKey);
      this.sql.exec("DELETE FROM ledger_segments WHERE seq = ?", segment.seq);
      this.segmentCache.delete(segment.objectKey);
    }
    return expired.length;
  }

  /**
   * Drops index entries whose object was removed from storage by something
   * other than the Kernel. Each run checks one bounded batch, chosen by the
   * day, so successive days walk the whole index without keeping a cursor.
   */
  async pruneMissingSegments(now = Date.now()): Promise<number> {
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_segments").one().n;
    if (total === 0) return 0;
    const batches = Math.ceil(total / LEDGER_PRUNE_PER_ALARM);
    const offset = (Math.floor(now / REPAIR_STEP_MS) % batches) * LEDGER_PRUNE_PER_ALARM;
    const batch = [...this.sql.exec<SegmentRow>(
      "SELECT * FROM ledger_segments ORDER BY seq ASC LIMIT ? OFFSET ?",
      LEDGER_PRUNE_PER_ALARM,
      offset,
    )].map(segmentFromRow);
    let dropped = 0;
    for (const segment of batch) {
      const head = await this.bucket.head(segment.objectKey);
      if (head) continue;
      this.sql.exec("DELETE FROM ledger_segments WHERE seq = ?", segment.seq);
      this.segmentCache.delete(segment.objectKey);
      dropped += 1;
    }
    return dropped;
  }

  /* ---------- reads ---------- */

  /**
   * Newest first. The window is filtered and limited in SQL; segments are then
   * walked newest to oldest, at most a few per call, skipping any whose index
   * sets cannot match. A filtered read may return fewer than `limit` lines with
   * a cursor still set: that means "more may exist, continue here".
   */
  async list(query: LedgerQuery): Promise<SysLedgerListResult> {
    const limit = Math.max(1, Math.min(LEDGER_LIST_MAX, query.limit));
    const cursor = parseCursor(query.cursor);
    const pages = cursor ? cursor.pages.map((page) => ({ ...page })) : [];
    const lines: LedgerLine[] = [];

    if (cursor === null || cursor.segment === null) {
      const segTop = this.newestSegmentSeq();
      const last = pages[pages.length - 1];
      const where: string[] = ["seq < ?"];
      const params: (string | number)[] = [last ? last.low : Number.MAX_SAFE_INTEGER];
      if (query.ownerUid !== null) {
        where.push("owner_uid = ?");
        params.push(query.ownerUid);
      }
      if (query.pid !== undefined) {
        where.push("pid = ?");
        params.push(query.pid);
      }
      if (query.target !== undefined) {
        where.push("target = ?");
        params.push(query.target);
      }
      if (query.callPrefix !== undefined) {
        where.push("substr(call, 1, ?) = ?");
        params.push(query.callPrefix.length, query.callPrefix);
      }
      if (query.since !== undefined) {
        where.push("ts >= ?");
        params.push(query.since);
      }
      if (query.until !== undefined) {
        where.push("ts <= ?");
        params.push(query.until);
      }
      const rows = [...this.sql.exec<WindowRow>(
        `SELECT * FROM ledger_window WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        ...params,
        limit + 1,
      )];
      const returned = rows.slice(0, limit).map(rowToStored);
      for (const stored of returned) lines.push(publicLine(stored));
      const exhausted = rows.length <= limit;
      notePage(pages, segTop, exhausted ? 0 : returned[returned.length - 1].seq);
      if (!exhausted) return { lines, nextCursor: formatCursor(pages, null) };
      if (lines.length >= limit) return { lines, nextCursor: segTop === 0 ? null : formatCursor(pages, null) };
    }

    // the index is walked a batch at a time from the cursor down, so a read never holds more of it than it looks at
    let below = cursor?.segment ? cursor.segment.seq : Number.MAX_SAFE_INTEGER;
    let touched = 0;
    for (;;) {
      const batch = this.segmentsFrom(below, query, LEDGER_INDEX_BATCH);
      if (batch.length === 0) return { lines, nextCursor: null };
      for (const segment of batch) {
        const from = examinedFrom(pages, segment);
        if (from !== null && segment.firstSeq >= from) continue;
        if (!segmentMayMatch(segment, query)) continue;
        if (touched === LEDGER_SEGMENTS_PER_READ) {
          return { lines, nextCursor: formatCursor(pages, { seq: segment.seq, offset: 0 }) };
        }
        touched += 1;
        const offset = cursor?.segment && segment.seq === cursor.segment.seq ? cursor.segment.offset : 0;
        const stored = await this.readSegment(segment);
        for (let position = stored.length - 1 - offset; position >= 0; position -= 1) {
          const line = stored[position];
          if ((from !== null && line.seq >= from) || !matches(line, query)) continue;
          lines.push(publicLine(line));
          if (lines.length >= limit) {
            const nextOffset = stored.length - position;
            if (nextOffset < stored.length) return { lines, nextCursor: formatCursor(pages, { seq: segment.seq, offset: nextOffset }) };
            const next = this.segmentsFrom(segment.seq - 1, query, 1)[0];
            return { lines, nextCursor: next ? formatCursor(pages, { seq: next.seq, offset: 0 }) : null };
          }
        }
      }
      below = batch[batch.length - 1].seq - 1;
    }
  }

  /** Segments are immutable, so the last few read stay parsed for the pages that follow inside them. */
  private readonly segmentCache = new Map<string, StoredLine[]>();

  private async readSegment(segment: LedgerSegment): Promise<StoredLine[]> {
    const cached = this.segmentCache.get(segment.objectKey);
    if (cached) return cached;
    const object = await this.bucket.get(segment.objectKey);
    if (!object) return [];
    const text = await object.text();
    const lines: StoredLine[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const parsed = storedLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
    }
    this.segmentCache.set(segment.objectKey, lines);
    while (this.segmentCache.size > LEDGER_SEGMENTS_PER_READ) {
      const oldest = this.segmentCache.keys().next().value;
      if (oldest === undefined) break;
      this.segmentCache.delete(oldest);
    }
    return lines;
  }
}

function segmentMayMatch(segment: LedgerSegment, query: LedgerQuery): boolean {
  if (query.ownerUid !== null && segment.uids !== null && !segment.uids.includes(query.ownerUid)) return false;
  if (query.pid !== undefined && segment.pids !== null && !segment.pids.includes(query.pid)) return false;
  if (query.target !== undefined && segment.targets !== null && !segment.targets.includes(query.target)) return false;
  if (query.since !== undefined && segment.lastTs < query.since) return false;
  if (query.until !== undefined && segment.firstTs > query.until) return false;
  return true;
}

/** A set small enough to promise something; past the limit the entry promises nothing and the segment is read. */
function cappedSet<T>(values: T[]): T[] | null {
  return values.length > LEDGER_INDEX_SET_LIMIT ? null : values;
}

/** Validates a client's list arguments at the boundary. */
export const ledgerListArgsSchema = z.object({
  pid: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  target: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  callPrefix: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().positive().max(LEDGER_LIST_MAX).optional(),
  cursor: z.string().max(512).optional(),
}) satisfies z.ZodType<SysLedgerListArgs>;
