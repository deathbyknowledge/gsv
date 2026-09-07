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
 * Lines carry the argument that matters, redacted and capped, never a body,
 * message text, or a credential.
 */

export const LEDGER_WINDOW_ROWS = 5_000;
export const LEDGER_WINDOW_AGE_MS = 24 * 60 * 60 * 1000;
export const LEDGER_SEGMENT_ROWS = 2_000;
export const LEDGER_DETAIL_LIMIT = 200;
export const LEDGER_ID_LIMIT = 128;
export const LEDGER_LIST_MAX = 200;
export const LEDGER_SEGMENTS_PER_READ = 4;
export const LEDGER_OBJECT_PREFIX = "ledger/";
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
  detail: string;
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
  uids: number[];
  pids: string[];
  targets: string[];
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
  | { rotated: false; reason: "within-bounds" | "nothing-closed" }
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
  detail: string;
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
  uids: string;
  pids: string;
  targets: string;
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
  detail: z.string(),
  outcome: outcomeSchema.nullable(),
  durationMs: z.number().nullable(),
  tokens: z.number().nullable().optional(),
  costNanoUsd: z.number().nullable().optional(),
});
const stringListSchema = z.array(z.string());
const numberListSchema = z.array(z.number());

/* ---------- redaction: the argument that matters, one line, capped ---------- */

const detailArgsSchema = z.object({
  input: z.string().optional(),
  path: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  code: z.string().optional(),
  model: z.string().optional(),
  label: z.string().optional(),
  adapter: z.string().optional(),
  key: z.string().optional(),
  contactId: z.string().optional(),
  serverId: z.string().optional(),
  name: z.string().optional(),
});

/** Truncates to `limit` characters, marking the cut so a reader knows the line was longer. */
export function capField(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function oneLine(value: string, limit = LEDGER_DETAIL_LIMIT): string {
  const flat = value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return capField(flat, limit);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Flags whose value is content, not a name: nothing after them is kept. */
const CONTENT_FLAGS = [
  "--message", "-m", "-H", "--header", "--data", "-d", "--data-raw", "--data-binary",
  "--body", "-b", "--cookie", "-u", "--user", "--token", "--password",
];

function isContentFlag(token: string): boolean {
  return CONTENT_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`));
}

/** A token that looks like a URL keeps its scheme, host, and path; never userinfo, query, or fragment. */
function scrubUrlToken(token: string): string {
  const match = token.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (!match) return token;
  const rest = match[2];
  const withoutUserinfo = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
  const cut = withoutUserinfo.search(/[?#]/);
  return `${match[1]}${cut >= 0 ? withoutUserinfo.slice(0, cut) : withoutUserinfo}`;
}

/**
 * The shape of a shell command without its content: the command word and its
 * first argument when that argument is not a flag, cut at the first flag that
 * carries content, with URLs stripped to scheme, host, and path.
 */
export function redactShellInput(input: string): string {
  const line = oneLine(input, LEDGER_DETAIL_LIMIT * 4);
  const tokens = line.split(" ").filter(Boolean);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isContentFlag(token)) break;
    if (index === 0) {
      kept.push(scrubUrlToken(token));
      continue;
    }
    if (token.startsWith("-")) break;
    kept.push(scrubUrlToken(token));
    break;
  }
  return capField(kept.join(" "), LEDGER_DETAIL_LIMIT);
}

/**
 * What a person would recognize the call by. A command's shape, a path, a
 * host, a query, a model id. Never bodies, message text, tokens, or keys.
 */
export function redactDetail(call: string, args: JsonLike): string {
  const parsed = detailArgsSchema.safeParse(args);
  const a = parsed.success ? parsed.data : {};
  if (call === "shell.exec") return redactShellInput(a.input ?? "");
  if (call.startsWith("codemode.")) return oneLine(a.code ?? "");
  if (call === "fs.copy" || call.startsWith("fs.transfer")) {
    const from = a.from ?? a.path ?? "";
    return oneLine(a.to ? `${from} → ${a.to}` : from);
  }
  if (call.startsWith("fs.")) return oneLine(a.path ?? a.query ?? "");
  if (call === "net.fetch") return oneLine(a.url ? hostOf(a.url) : "");
  if (call.startsWith("ai.")) return oneLine(a.model ?? "");
  if (call.startsWith("proc.")) return oneLine(a.label ?? a.name ?? "");
  if (call.startsWith("adapter.")) return oneLine(a.adapter ?? "");
  if (call.startsWith("contact.")) return oneLine(a.contactId ?? "");
  if (call.startsWith("sys.config")) return oneLine(a.key ?? "");
  if (call.startsWith("sys.mcp")) return oneLine(a.serverId ?? a.name ?? "");
  return "";
}

const targetArgSchema = z.object({ target: z.string().min(1).optional() });

/** The place a call went to: its `target` argument, capped, else the cloud home. */
export function ledgerTargetOf(args: JsonLike): string {
  const parsed = targetArgSchema.safeParse(args);
  return parsed.success && parsed.data.target ? capField(parsed.data.target, LEDGER_ID_LIMIT) : "gsv";
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
    detail: row.detail,
    outcome: outcome.success ? outcome.data : null,
    durationMs: row.duration_ms,
    tokens: row.tokens,
    costNanoUsd: row.cost_nano_usd,
  };
}

function segmentFromRow(row: SegmentRow): LedgerSegment {
  const uids = numberListSchema.safeParse(JSON.parse(row.uids));
  const pids = stringListSchema.safeParse(JSON.parse(row.pids));
  const targets = stringListSchema.safeParse(JSON.parse(row.targets));
  return {
    seq: row.seq,
    firstSeq: row.first_seq,
    objectKey: row.object_key,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    rowCount: row.row_count,
    bytes: row.bytes,
    uids: uids.success ? uids.data : [],
    pids: pids.success ? pids.data : [],
    targets: targets.success ? targets.data : [],
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
 * A cursor remembers which window lines a reader has already been handed, as
 * the seq range `[low, high]` returned from the window so far, plus where it
 * is: `<low>:<high>:w` continues in the window below `low`;
 * `<low>:<high>:s:<segmentSeq>:<offset>` continues in a segment. Segment reads
 * skip lines inside that range, so a line that rotated between two pages is
 * never returned twice, while stragglers with lower seqs than the segments
 * around them are still reachable.
 */
type Cursor = { low: number; high: number; segment: { seq: number; offset: number } | null };

const NO_RANGE = { low: Number.MAX_SAFE_INTEGER, high: 0 };

function parseCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  const window = cursor.match(/^(\d+):(\d+):w$/);
  if (window) return { low: Number(window[1]), high: Number(window[2]), segment: null };
  const segment = cursor.match(/^(\d+):(\d+):s:(\d+):(\d+)$/);
  if (segment) {
    return { low: Number(segment[1]), high: Number(segment[2]), segment: { seq: Number(segment[3]), offset: Number(segment[4]) } };
  }
  throw new Error("Invalid ledger cursor");
}

function formatCursor(range: { low: number; high: number }, segment: { seq: number; offset: number } | null): string {
  const head = `${range.low}:${range.high}`;
  return segment ? `${head}:s:${segment.seq}:${segment.offset}` : `${head}:w`;
}

function inRange(seq: number, range: { low: number; high: number }): boolean {
  return seq >= range.low && seq <= range.high;
}

/** The three things the ledger asks of the installation's storage; an R2 bucket satisfies it as is. */
export type LedgerObjectStore = {
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<{ key: string } | null>;
};

export class LedgerStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: Pick<DurableObjectStorage, "transactionSync">,
    private readonly bucket: LedgerObjectStore,
  ) {}

  /* ---------- the active window ---------- */

  /** Writes an open line. Every client-controlled field is capped here, whatever the caller checked. */
  append(entry: LedgerAppend): number {
    this.sql.exec(
      `INSERT INTO ledger_window
       (request_id, ts, principal_kind, uid, owner_uid, pid, run_id, target, call, detail)
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
      oneLine(entry.detail),
    );
    const [row] = [...this.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")];
    return row?.seq ?? 0;
  }

  /** Completes the newest open line for the request; returns false when nothing was open. */
  complete(requestId: string, completion: LedgerCompletion, now = Date.now()): boolean {
    const [open] = [...this.sql.exec<{ seq: number; ts: number }>(
      "SELECT seq, ts FROM ledger_window WHERE request_id = ? AND outcome IS NULL ORDER BY seq DESC LIMIT 1",
      capField(requestId, LEDGER_ID_LIMIT),
    )];
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

  /** True when the window holds more rows than its bound, or rows older than its age. */
  needsRotation(now = Date.now()): boolean {
    if (this.windowCount() > LEDGER_WINDOW_ROWS) return true;
    const oldest = this.oldestTimestamp();
    return oldest !== null && now - oldest > LEDGER_WINDOW_AGE_MS;
  }

  /* ---------- rotation ---------- */

  /**
   * Moves the oldest closed lines into one segment object, then in one
   * transaction removes exactly those lines from the window and records the
   * segment. The rows are captured before the object write, and only those
   * seqs are deleted: a line that completes while the write is in flight stays
   * in the window for the next rotation. Lines still open after the window age
   * are closed as cancelled on the way out. A failed object write leaves the
   * window untouched.
   *
   * A line that closes late rotates in a later segment with a lower seq, so
   * segment seq ranges may overlap; readers page by seq bound, not by range.
   */
  async rotateOnce(now = Date.now()): Promise<RotationResult> {
    if (!this.needsRotation(now)) return { rotated: false, reason: "within-bounds" };
    const cutoff = now - LEDGER_WINDOW_AGE_MS;
    const rows = [...this.sql.exec<WindowRow>(
      `SELECT * FROM ledger_window
       WHERE outcome IS NOT NULL OR ts < ?
       ORDER BY seq ASC
       LIMIT ?`,
      cutoff,
      LEDGER_SEGMENT_ROWS,
    )];
    if (rows.length === 0) return { rotated: false, reason: "nothing-closed" };

    const lines = rows.map((row) => {
      const stored = rowToStored(row);
      return stored.outcome === null ? { ...stored, outcome: "cancelled" as const, durationMs: null } : stored;
    });
    const seqs = lines.map((line) => line.seq);
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const lastSeq = seqs[seqs.length - 1];
    const key = segmentKey(lastSeq);
    const bytes = new TextEncoder().encode(body).byteLength;
    await this.bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });

    const segment: LedgerSegment = {
      seq: lastSeq,
      firstSeq: seqs[0],
      objectKey: key,
      firstTs: Math.min(...lines.map((line) => line.timestamp)),
      lastTs: Math.max(...lines.map((line) => line.timestamp)),
      rowCount: lines.length,
      bytes,
      uids: [...new Set(lines.map((line) => line.ownerUid))].sort((a, b) => a - b),
      pids: [...new Set(lines.flatMap((line) => (line.pid ? [line.pid] : [])))].sort(),
      targets: [...new Set(lines.map((line) => line.target))].sort(),
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
        JSON.stringify(segment.uids),
        JSON.stringify(segment.pids),
        JSON.stringify(segment.targets),
        segment.createdAt,
      );
    });
    return { rotated: true, segment };
  }

  /** Rotates until the window is within bounds or the per-alarm budget is spent. */
  async rotate(now = Date.now()): Promise<LedgerSegment[]> {
    const written: LedgerSegment[] = [];
    for (let i = 0; i < ROTATIONS_PER_ALARM; i += 1) {
      const result = await this.rotateOnce(now);
      if (!result.rotated) break;
      written.push(result.segment);
    }
    return written;
  }

  segments(): LedgerSegment[] {
    return [...this.sql.exec<SegmentRow>("SELECT * FROM ledger_segments ORDER BY seq DESC")].map(segmentFromRow);
  }

  /** Drops index entries whose object has expired or been removed from storage. */
  async pruneMissingSegments(): Promise<number> {
    let dropped = 0;
    for (const segment of this.segments()) {
      const head = await this.bucket.head(segment.objectKey);
      if (head) continue;
      this.sql.exec("DELETE FROM ledger_segments WHERE seq = ?", segment.seq);
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
    const range = cursor ? { low: cursor.low, high: cursor.high } : { ...NO_RANGE };
    const lines: LedgerLine[] = [];

    if (cursor === null || cursor.segment === null) {
      const where: string[] = ["seq < ?"];
      const params: (string | number)[] = [cursor ? cursor.low : Number.MAX_SAFE_INTEGER];
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
      for (const row of rows.slice(0, limit)) {
        const stored = rowToStored(row);
        range.high = Math.max(range.high, stored.seq);
        range.low = Math.min(range.low, stored.seq);
        lines.push(publicLine(stored));
      }
      if (rows.length > limit) return { lines, nextCursor: formatCursor(range, null) };
    }

    const segments = this.segments();
    const startIndex = cursor?.segment ? segments.findIndex((segment) => segment.seq === cursor.segment?.seq) : 0;
    if (cursor?.segment && startIndex < 0) return { lines, nextCursor: null };
    let touched = 0;
    for (let index = Math.max(0, startIndex); index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segmentMayMatch(segment, query, range)) continue;
      if (touched === LEDGER_SEGMENTS_PER_READ) {
        return { lines, nextCursor: formatCursor(range, { seq: segment.seq, offset: 0 }) };
      }
      touched += 1;
      const offset = cursor?.segment && segment.seq === cursor.segment.seq ? cursor.segment.offset : 0;
      const stored = await this.readSegment(segment);
      for (let position = stored.length - 1 - offset; position >= 0; position -= 1) {
        const line = stored[position];
        if (inRange(line.seq, range) || !matches(line, query)) continue;
        lines.push(publicLine(line));
        if (lines.length === limit) {
          const nextOffset = stored.length - position;
          const next = index + 1 < segments.length ? segments[index + 1] : null;
          return {
            lines,
            nextCursor: nextOffset >= stored.length
              ? next ? formatCursor(range, { seq: next.seq, offset: 0 }) : null
              : formatCursor(range, { seq: segment.seq, offset: nextOffset }),
          };
        }
      }
    }
    return { lines, nextCursor: null };
  }

  private async readSegment(segment: LedgerSegment): Promise<StoredLine[]> {
    const object = await this.bucket.get(segment.objectKey);
    if (!object) return [];
    const text = await object.text();
    const lines: StoredLine[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const parsed = storedLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
    }
    return lines;
  }
}

function segmentMayMatch(segment: LedgerSegment, query: LedgerQuery, range: { low: number; high: number }): boolean {
  if (segment.firstSeq >= range.low && segment.seq <= range.high) return false;
  if (query.ownerUid !== null && !segment.uids.includes(query.ownerUid)) return false;
  if (query.pid !== undefined && !segment.pids.includes(query.pid)) return false;
  if (query.target !== undefined && !segment.targets.includes(query.target)) return false;
  if (query.since !== undefined && segment.lastTs < query.since) return false;
  if (query.until !== undefined && segment.firstTs > query.until) return false;
  return true;
}

/** Validates a client's list arguments at the boundary. */
export const ledgerListArgsSchema = z.object({
  pid: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  target: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  callPrefix: z.string().min(1).max(LEDGER_ID_LIMIT).optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().positive().max(LEDGER_LIST_MAX).optional(),
  cursor: z.string().max(64).optional(),
}) satisfies z.ZodType<SysLedgerListArgs>;
