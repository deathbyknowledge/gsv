import { z } from "zod";
import type { ResponseFrame } from "../protocol/frames";
import type { SysLedgerLine, SysLedgerListArgs, SysLedgerListResult, SysLedgerOutcome } from "@humansandmachines/gsv/protocol";

/**
 * The ledger is the Kernel's record of what ran: one line per dispatched
 * syscall, written when the call is dispatched and completed when its response
 * is known. The active window stays small; closed lines rotate into immutable
 * segments in the installation's R2 storage, and an index of those segments
 * stays here so reads can page across both and skip segments by process or
 * place.
 *
 * Lines carry the argument that matters, redacted and capped, never a body,
 * prompt text, or a credential.
 */

export const LEDGER_WINDOW_ROWS = 5_000;
export const LEDGER_WINDOW_AGE_MS = 24 * 60 * 60 * 1000;
export const LEDGER_SEGMENT_ROWS = 2_000;
export const LEDGER_DETAIL_LIMIT = 200;
export const LEDGER_LIST_MAX = 200;
export const LEDGER_OBJECT_PREFIX = "ledger/";
const ROTATIONS_PER_ALARM = 8;

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

function oneLine(value: string, limit = LEDGER_DETAIL_LIMIT): string {
  const flat = value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * What a person would recognize the call by. Paths, hosts, the first line of a
 * command, a query, a model id. Never bodies, message text, tokens, or keys.
 */
export function redactDetail(call: string, args: JsonLike): string {
  const parsed = detailArgsSchema.safeParse(args);
  const a = parsed.success ? parsed.data : {};
  if (call === "shell.exec") return oneLine(a.input ?? "");
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

/** The place a call went to: its `target` argument, else the cloud home. */
export function ledgerTargetOf(args: JsonLike): string {
  const parsed = targetArgSchema.safeParse(args);
  return parsed.success && parsed.data.target ? parsed.data.target : "gsv";
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

const usageSchema = z.object({
  usage: z
    .object({
      totalTokens: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      costNanoUsd: z.number().optional(),
    })
    .optional(),
});

/** Tokens and cost when a response carries usage, as the ai.* calls do. */
export function usageOfResponse(frame: ResponseFrame): Pick<LedgerCompletion, "tokens" | "costNanoUsd"> {
  if (!frame.ok) return {};
  const parsed = usageSchema.safeParse(frame.data);
  const usage = parsed.success ? parsed.data.usage : undefined;
  if (!usage) return {};
  const tokens = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || null);
  return {
    tokens,
    costNanoUsd: usage.costNanoUsd ?? null,
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

/** Cursor: `w:<seq>` reads window lines below seq; `s:<segmentSeq>:<offset>` reads a segment from the end. */
type Cursor = { kind: "window"; belowSeq: number } | { kind: "segment"; seq: number; offset: number };

function parseCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  const window = cursor.match(/^w:(\d+)$/);
  if (window) return { kind: "window", belowSeq: Number(window[1]) };
  const segment = cursor.match(/^s:(\d+):(\d+)$/);
  if (segment) return { kind: "segment", seq: Number(segment[1]), offset: Number(segment[2]) };
  throw new Error("Invalid ledger cursor");
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

  append(entry: LedgerAppend): number {
    this.sql.exec(
      `INSERT INTO ledger_window
       (request_id, ts, principal_kind, uid, owner_uid, pid, run_id, target, call, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.requestId,
      entry.timestamp,
      entry.principalKind,
      entry.uid,
      entry.ownerUid,
      entry.pid,
      entry.runId,
      entry.target,
      entry.call,
      oneLine(entry.detail),
    );
    const [row] = [...this.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")];
    return row?.seq ?? 0;
  }

  /** Completes the newest open line for the request; returns false when nothing was open. */
  complete(requestId: string, completion: LedgerCompletion, now = Date.now()): boolean {
    const [open] = [...this.sql.exec<{ seq: number; ts: number }>(
      "SELECT seq, ts FROM ledger_window WHERE request_id = ? AND outcome IS NULL ORDER BY seq DESC LIMIT 1",
      requestId,
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
   * transaction removes them from the window and records the segment. Lines
   * still open after the window age are closed as cancelled on the way out. A
   * failed object write leaves the window untouched.
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
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const lastSeq = lines[lines.length - 1].seq;
    const key = segmentKey(lastSeq);
    const bytes = new TextEncoder().encode(body).byteLength;
    await this.bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });

    const segment: LedgerSegment = {
      seq: lastSeq,
      firstSeq: lines[0].seq,
      objectKey: key,
      firstTs: Math.min(...lines.map((line) => line.timestamp)),
      lastTs: Math.max(...lines.map((line) => line.timestamp)),
      rowCount: lines.length,
      bytes,
      pids: [...new Set(lines.flatMap((line) => (line.pid ? [line.pid] : [])))].sort(),
      targets: [...new Set(lines.map((line) => line.target))].sort(),
      createdAt: now,
    };
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ledger_window WHERE seq >= ? AND seq <= ? AND (outcome IS NOT NULL OR ts < ?)", segment.firstSeq, segment.seq, cutoff);
      this.sql.exec(
        `INSERT INTO ledger_segments
         (seq, first_seq, object_key, first_ts, last_ts, row_count, bytes, pids, targets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        segment.seq,
        segment.firstSeq,
        segment.objectKey,
        segment.firstTs,
        segment.lastTs,
        segment.rowCount,
        segment.bytes,
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

  async list(query: LedgerQuery): Promise<SysLedgerListResult> {
    const limit = Math.max(1, Math.min(LEDGER_LIST_MAX, query.limit));
    const cursor = parseCursor(query.cursor);
    const lines: LedgerLine[] = [];

    if (cursor === null || cursor.kind === "window") {
      const belowSeq = cursor?.kind === "window" ? cursor.belowSeq : Number.MAX_SAFE_INTEGER;
      const rows = [...this.sql.exec<WindowRow>(
        "SELECT * FROM ledger_window WHERE seq < ? ORDER BY seq DESC",
        belowSeq,
      )];
      for (const row of rows) {
        const stored = rowToStored(row);
        if (!matches(stored, query)) continue;
        lines.push(publicLine(stored));
        if (lines.length === limit) return { lines, nextCursor: `w:${stored.seq}` };
      }
    }

    const segments = this.segments();
    const startIndex = cursor?.kind === "segment" ? segments.findIndex((segment) => segment.seq === cursor.seq) : 0;
    if (cursor?.kind === "segment" && startIndex < 0) return { lines, nextCursor: null };
    for (let index = Math.max(0, startIndex); index < segments.length; index += 1) {
      const segment = segments[index];
      const offset = cursor?.kind === "segment" && segment.seq === cursor.seq ? cursor.offset : 0;
      if (!segmentMayMatch(segment, query)) continue;
      const stored = await this.readSegment(segment);
      for (let position = stored.length - 1 - offset; position >= 0; position -= 1) {
        const line = stored[position];
        if (!matches(line, query)) continue;
        lines.push(publicLine(line));
        if (lines.length === limit) {
          const nextOffset = stored.length - position;
          return {
            lines,
            nextCursor: nextOffset >= stored.length
              ? index + 1 < segments.length ? `s:${segments[index + 1].seq}:0` : null
              : `s:${segment.seq}:${nextOffset}`,
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

function segmentMayMatch(segment: LedgerSegment, query: LedgerQuery): boolean {
  if (query.pid !== undefined && !segment.pids.includes(query.pid)) return false;
  if (query.target !== undefined && !segment.targets.includes(query.target)) return false;
  if (query.since !== undefined && segment.lastTs < query.since) return false;
  if (query.until !== undefined && segment.firstTs > query.until) return false;
  return true;
}

/** Validates a client's list arguments at the boundary. */
export const ledgerListArgsSchema = z.object({
  pid: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  callPrefix: z.string().min(1).optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().positive().max(LEDGER_LIST_MAX).optional(),
  cursor: z.string().optional(),
}) satisfies z.ZodType<SysLedgerListArgs>;
