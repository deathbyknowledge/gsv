import { z } from "zod";
import type { ProcHistoryRecordsResult, ProcMessageMetadata } from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow, ChatTranscriptValue } from "../../chat/domain/transcript";
import type { LibraryCollection } from "../../gsv-console/library/libraryTypes";
import type { MemoryPageRef } from "../shared/navigation";

/* ---------- the prompt line ---------- */

export type PromptIntent =
  | { kind: "say"; text: string }
  | { kind: "run"; command: string }
  | { kind: "switch"; name: string };

/** A sentence goes to the ship. `$` or `!` runs directly. A bare `@name` moves the prompt to that place. */
export function parsePromptInput(raw: string): PromptIntent | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("$") || text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { kind: "run", command } : null;
  }
  const switchMatch = /^@([\w.:-]+)$/.exec(text);
  if (switchMatch) {
    return { kind: "switch", name: switchMatch[1] };
  }
  return { kind: "say", text };
}

/* ---------- places ---------- */

export type Place = {
  id: string;
  label: string;
  online: boolean;
};

export const CLOUD_PLACE_ID = "gsv";
export const CLOUD_PLACE_LABEL = "your cloud home";

export function placeLabel(id: string, places: readonly Place[]): string {
  if (id === CLOUD_PLACE_ID) return CLOUD_PLACE_LABEL;
  return places.find((place) => place.id === id)?.label ?? id;
}

/** Resolve a typed name to a place id, by id first, then by label, case-insensitively. */
export function resolvePlace(name: string, places: readonly Place[]): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  if (wanted === CLOUD_PLACE_ID || wanted === "cloud" || wanted === "home") return CLOUD_PLACE_ID;
  const byId = places.find((place) => place.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const byLabel = places.find((place) => place.label.toLowerCase() === wanted);
  return byLabel ? byLabel.id : null;
}

/** The prompt's default place: the first online machine, else the cloud home. */
export function defaultPlace(places: readonly Place[]): string {
  return places.find((place) => place.online)?.id ?? CLOUD_PLACE_ID;
}

/* ---------- activity along the target axis ---------- */

export type ActivityCall = {
  callId: string;
  syscall: string;
  summary: string;
  output: string;
  finished: boolean;
  failed: boolean;
  operation?: { label: string; subject: string; detail?: string };
  /** The original structured Read path, before display shortening. */
  filePath?: string;
};

export type Activity = {
  key: string;
  target: string | null;
  calls: ActivityCall[];
  live: boolean;
  you: boolean;
  startedAt: number | null;
  endedAt: number | null;
};

export type Moment = {
  id: string;
  /** `note` is the ship's own memory: a compaction summary the gateway wrote when it folded older history. */
  role: "human" | "ship" | "note";
  event?: ChatTranscriptRow["event"];
  text: string;
  media?: ChatTranscriptRow["media"];
  streaming: boolean;
  thinking: boolean;
  runId: string | null;
  processId?: string;
  timestamp: number | null;
  activities: Activity[];
  /** The ship's working narration for this run: what it told itself, not what it sent. Folded by default. */
  narration: string;
  attribution?: AnswerAttribution | null;
};

export type AnswerHistoryEntry = {
  runId: string | null;
  timestamp: number | null;
  metadata?: ProcMessageMetadata;
};

export type AnswerHistorySnapshot = { entries: AnswerHistoryEntry[]; through: number };

/** Delta pages can expose Send results before their updated assistant groups; attribute only a complete snapshot. */
export function answerHistorySnapshot(
  history: Pick<ProcHistoryRecordsResult, "pid" | "records" | "hasMore"> | undefined,
  pid: string | null,
): AnswerHistorySnapshot {
  if (!history || history.pid !== pid || history.hasMore) return { entries: [], through: 0 };
  const entries = history.records.filter((record) => record.kind === "note" || record.kind === "call")
    .map(({ runId, createdAt, metadata }) => ({ runId, timestamp: createdAt, metadata }));
  return { entries, through: history.records.reduce((through, record) => Math.max(through, record.createdAt), 0) };
}

export type AnswerAttribution = {
  model: string | null;
  provider: string | null;
  fallbacks: Array<{ from: string; to: string; reason: string | null }>;
  omittedFallbacks: number;
};

/** Attribute a committed answer to its generation, never to the process's current model setting. */
export function answerAttribution(
  moment: Pick<Moment, "role" | "text" | "media" | "runId" | "timestamp" | "streaming">,
  history: readonly AnswerHistoryEntry[],
  historyThrough: number,
): AnswerAttribution | null {
  if (moment.role !== "ship" || (!moment.text.trim() && !moment.media?.length) || moment.streaming || !moment.runId || moment.timestamp === null) return null;
  // Delivery can arrive before the refreshed Process history; an older generation is not evidence for that reply.
  if (historyThrough < moment.timestamp) return null;
  const cutoff = moment.timestamp;
  const candidates = history.filter((entry): entry is AnswerHistoryEntry & { timestamp: number } => entry.runId === moment.runId
    && entry.timestamp !== null && entry.timestamp <= cutoff)
    .sort((left, right) => left.timestamp - right.timestamp);
  const metadata = candidates.at(-1)?.metadata;
  const model = metadata?.provider?.responseModel?.trim() || metadata?.provider?.model?.trim() || null;
  const provider = metadata?.provider?.provider?.trim() || null;
  const fallbacks = new Map<string, AnswerAttribution["fallbacks"][number]>();
  for (const entry of candidates) {
    const fallback = entry.metadata?.fallback;
    if (!fallback?.used) continue;
    const from = fallback.from?.model?.trim() || fallback.from?.provider?.trim() || "unknown model";
    const to = fallback.to?.model?.trim() || fallback.to?.provider?.trim() || "unknown model";
    const reason = fallback.reason?.slice(0, 241).replace(/\s+/g, " ").trim() || null;
    const key = JSON.stringify([from, to]);
    fallbacks.delete(key);
    fallbacks.set(key, { from, to, reason: reason && reason.length > 240 ? `${reason.slice(0, 239)}…` : reason });
  }
  if (!model && fallbacks.size === 0) return null;
  return { model, provider, fallbacks: [...fallbacks.values()].slice(-3), omittedFallbacks: Math.max(0, fallbacks.size - 3) };
}

const OUTPUT_LIMIT = 600;

function isRecord(value: ChatTranscriptValue | undefined): value is { [key: string]: ChatTranscriptValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringValue(value: ChatTranscriptValue | undefined): value is string {
  return typeof value === "string";
}

function stringField(value: ChatTranscriptValue | undefined, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isStringValue(field) && field.trim() ? field : null;
}

/** The target a tool call touched: an explicit `target` argument, else the cloud home. */
/** The one argument a person wants to see: the command, the path, the URL, or the tool's name. */
export function argumentThatMatters(syscall: string, args: ChatTranscriptValue | undefined): string {
  if (syscall === "codemode.exec" || syscall === "codemode.run" || syscall === "CodeMode") return stringField(args, "code") ?? "";
  const input = stringField(args, "input") ?? stringField(args, "command");
  if (input && syscall.startsWith("shell.")) return input;
  const path = stringField(args, "path");
  if (path && syscall.startsWith("fs.")) return path;
  const url = stringField(args, "url");
  if (url && syscall.startsWith("net.")) return url;
  return input ?? path ?? url ?? "";
}

export function trimOutput(text: string): string {
  const clean = text.replace(/\s+$/, "");
  if (clean.length <= OUTPUT_LIMIT) return clean;
  return `${clean.slice(0, OUTPUT_LIMIT)}\n… ${clean.length - OUTPUT_LIMIT} more characters`;
}

const shellResultSchema = z.object({ stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().nullable().optional() })
  .refine((value) => value.stdout !== undefined || value.stderr !== undefined || value.exitCode !== undefined);
const commandResultSchema = z.object({ status: z.string().optional(), output: z.string() });
const codeModeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), result: z.json(), logs: z.array(z.string()).optional() }),
  z.object({ status: z.literal("failed"), error: z.string(), logs: z.array(z.string()).optional() }),
]);
const fileOperationErrorSchema = z.object({ ok: z.literal(false), error: z.string() });
const fileWriteResultSchema = z.object({ ok: z.literal(true), path: z.string(), size: z.number().int().nonnegative() });
const fileEditResultSchema = z.object({ ok: z.literal(true), path: z.string(), replacements: z.number().int().nonnegative() });
const fileDeleteResultSchema = z.object({ ok: z.literal(true), path: z.string() });
const fileResultSchema = z.object({ content: z.string().optional(), entries: z.array(z.object({ name: z.string(), kind: z.string().optional() })).optional() });
const searchResultSchema = z.object({ results: z.array(z.object({ path: z.string() })).optional(), matches: z.array(z.object({ path: z.string() })).optional() });
const fileSearchResultSchema = z.object({ ok: z.literal(true), matches: z.array(z.object({ path: z.string(), line: z.number(), content: z.string() })), count: z.number().int().nonnegative(), truncated: z.boolean().optional() });
const filesystemOperationVerbs = new Map([
  ["fs.read", ["read", "reading", "read"]],
  ["fs.write", ["write", "writing", "wrote"]],
  ["fs.edit", ["edit", "editing", "edited"]],
  ["fs.delete", ["delete", "deleting", "deleted"]],
  ["fs.search", ["search", "searching", "searched"]],
]);

function mutationConfirmation(syscall: string, output: ChatTranscriptValue | undefined): { path: string; detail?: string } | null {
  if (syscall === "fs.write") {
    const result = fileWriteResultSchema.safeParse(output);
    return result.success ? { path: result.data.path, detail: countLabel(result.data.size, "byte") } : null;
  }
  if (syscall === "fs.edit") {
    const result = fileEditResultSchema.safeParse(output);
    return result.success ? { path: result.data.path, detail: countLabel(result.data.replacements, "replacement") } : null;
  }
  if (syscall === "fs.delete") {
    const result = fileDeleteResultSchema.safeParse(output);
    return result.success ? { path: result.data.path } : null;
  }
  return null;
}

/** The tool result as a person would read it: stdout and stderr for a command, content or names for files, never the transport JSON. */
export function outputText(syscall: string, output: ChatTranscriptValue | undefined, fallback: string): string {
  if (output === undefined || output === null) return fallback;
  if (syscall.startsWith("fs.")) {
    const error = fileOperationErrorSchema.safeParse(output);
    if (error.success) return error.data.error;
  }
  if (syscall === "codemode.exec" || syscall === "codemode.run") {
    const code = codeModeResultSchema.safeParse(output);
    if (code.success) {
      const logs = code.data.logs?.join("\n") ?? "";
      const result = code.data.status === "failed" ? code.data.error
        : code.data.result === null ? ""
        : isStringValue(code.data.result) && code.data.result !== "" ? code.data.result
        : JSON.stringify(code.data.result, null, 2);
      return [logs, result].filter((text) => text !== "").join("\n") || code.data.status;
    }
  }
  if (syscall === "shell.exec") {
    const command = commandResultSchema.safeParse(output);
    if (command.success) return command.data.output;
    const shell = shellResultSchema.safeParse(output);
    if (shell.success) {
      const stdout = shell.data.stdout ?? "";
      const stderr = shell.data.stderr ?? "";
      const text = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
      const exit = shell.data.exitCode;
      return text.trim() ? text : exit === 0 || exit === null || exit === undefined ? "" : `exit ${exit}`;
    }
  }
  if (syscall === "fs.write") {
    const file = fileWriteResultSchema.safeParse(output);
    if (file.success) return `wrote ${file.data.size} ${file.data.size === 1 ? "byte" : "bytes"}`;
  }
  if (syscall === "fs.edit") {
    const file = fileEditResultSchema.safeParse(output);
    if (file.success) return `replaced ${file.data.replacements} ${file.data.replacements === 1 ? "occurrence" : "occurrences"}`;
  }
  if (syscall === "fs.delete") {
    const file = fileDeleteResultSchema.safeParse(output);
    if (file.success) return "deleted";
  }
  if (syscall === "fs.read") {
    const file = fileResultSchema.safeParse(output);
    if (file.success) {
      if (file.data.content !== undefined) return file.data.content;
      if (file.data.entries) return file.data.entries.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n");
    }
  }
  if (syscall === "fs.search") {
    const search = searchResultSchema.safeParse(output);
    const hits = search.success ? (search.data.results ?? search.data.matches ?? []) : [];
    if (hits.length > 0) return hits.map((hit) => hit.path).join("\n");
  }
  if (isStringValue(output)) return output;
  return fallback;
}

/** Some rows carry the result as a JSON string in their text; read it as the result it is.
 * TODO: remove once process history stores tool results structured (typed history records) instead of the model-facing text. */
function callFromRow(row: ChatTranscriptRow): ActivityCall {
  const syscall = row.toolSyscall ?? (row.toolName === "CodeMode" ? "codemode.exec" : row.toolName ?? "call");
  const finished = row.role === "toolResult" || row.status === "done" || row.status === "error";
  const summary = argumentThatMatters(syscall, row.toolArgs) || (row.toolName === "CodeMode" ? "" : row.toolName ?? syscall);
  const call: ActivityCall = {
    callId: row.toolCallId ?? row.id,
    syscall,
    summary,
    filePath: syscall === "fs.read" ? stringField(row.toolArgs, "path") ?? undefined : undefined,
    output: finished ? trimOutput(outputText(syscall, row.toolOutput, row.text)) : "",
    finished,
    failed: row.isError === true || row.status === "error" || (row.toolOutcome !== undefined && row.toolOutcome !== "completed"),
  };
  const verb = filesystemOperationVerbs.get(syscall);
  if (!verb) return call;
  const completed = finished && !call.failed && row.toolOutcome === "completed";
  const path = stringField(row.toolArgs, "path") ?? "";
  call.operation = { label: !finished && !call.failed && row.status === "running" ? verb[1] : verb[0], subject: path };
  if (syscall === "fs.search") {
    const query = stringField(row.toolArgs, "query") ?? "";
    call.operation.subject = [query, path ? `in ${path}` : ""].filter(Boolean).join(" ");
    const result = fileSearchResultSchema.safeParse(row.toolOutput);
    if (completed && result.success) {
      call.operation.label = verb[2];
      call.operation.detail = result.data.truncated ? `${result.data.count}+ results` : countLabel(result.data.count, "result");
      call.output = "";
    } else if (finished && result.success) {
      call.output = trimOutput(row.text || JSON.stringify(row.toolOutput, null, 2));
    }
  } else if (syscall !== "fs.read") {
    const result = mutationConfirmation(syscall, row.toolOutput);
    if (completed && result) {
      call.operation.label = verb[2];
      call.operation.subject = result.path;
      if (result.detail) call.operation.detail = result.detail;
      call.output = "";
    } else if (finished && result) {
      call.output = trimOutput(row.text || JSON.stringify(row.toolOutput, null, 2));
    }
  }
  return call;
}

function isToolRow(row: ChatTranscriptRow): boolean {
  return row.role === "tool" || row.role === "toolResult";
}

/**
 * Group a run's tool rows by the place they touched, in first-touch order.
 * The last activity of an active run is live while its latest call is unfinished.
 */
/** A `message` command is the ship sending the moment itself; it is not something it did along the way. */
export function isMessageSend(row: ChatTranscriptRow): boolean {
  return row.toolSyscall === null && (row.toolName === "Send"
    || (row.toolName === "Shell" && row.toolRunControl === true));
}

export function activitiesForRows(rows: readonly ChatTranscriptRow[], runKey: string, active: boolean): Activity[] {
  const activities: Activity[] = [];
  for (const row of rows) {
    if (!isToolRow(row) || isMessageSend(row)) continue;
    const target = row.toolSyscall === "codemode.exec" || row.toolSyscall === "codemode.run" || (row.toolSyscall == null && row.toolName === "CodeMode")
      ? null : row.toolTarget ?? "unknown target";
    const call = callFromRow(row);
    const existing = activities.find((activity) => activity.target === target);
    const timestamp = row.timestamp ?? null;
    const startedAt = row.toolStartedAt ?? timestamp;
    if (existing) {
      const index = existing.calls.findIndex((candidate) => candidate.callId === call.callId);
      if (index >= 0) {
        if (call.syscall === "fs.read" && row.toolArgs === undefined) call.filePath ??= existing.calls[index].filePath;
        if (call.operation && !call.operation.subject && row.toolArgs === undefined) {
          call.operation.subject = existing.calls[index].operation?.subject ?? "";
        }
        existing.calls[index] = call;
      }
      else existing.calls.push(call);
      if (startedAt !== null) existing.startedAt = Math.min(existing.startedAt ?? startedAt, startedAt);
      if (timestamp !== null) existing.endedAt = Math.max(existing.endedAt ?? timestamp, timestamp);
    } else {
      activities.push({
        key: JSON.stringify([runKey, target]),
        target,
        calls: [call],
        live: false,
        you: false,
        startedAt,
        endedAt: timestamp,
      });
    }
  }
  for (const activity of activities) activity.live = active && activity.calls.some((call) => !call.finished);
  return activities;
}

/** Only successful structured reads of an unambiguous known wiki page become Memory links. */
export function memoryPagesForMoment(moment: Moment, collections: readonly LibraryCollection[]): MemoryPageRef[] {
  const pages = new Map<string, MemoryPageRef>();
  for (const activity of moment.activities) {
    if (activity.you || activity.target !== CLOUD_PLACE_ID) continue;
    for (const call of activity.calls) {
      if (call.syscall !== "fs.read" || !call.finished || call.failed || !call.filePath) continue;
      const path = call.filePath;
      if (!path.startsWith("/src/repos/") || path.includes("\0") || path.split("/").slice(1).some((part) => !part || part === "." || part === "..")) continue;
      const matches = collections.filter((collection) => path.startsWith(`/src/repos/${collection.repo}/`));
      if (matches.length !== 1) continue;
      const collection = matches[0];
      if (collections.filter((entry) => entry.id === collection.id).length !== 1) continue;
      const localPath = path.slice(`/src/repos/${collection.repo}/`.length);
      if (localPath !== "index.md" && !/^pages\/(?:[^/]+\/)*[^/]+\.md$/i.test(localPath)) continue;
      const page = { db: collection.id, path: `${collection.id}/${localPath}` };
      pages.set(page.path, page);
    }
  }
  return [...pages.values()];
}

function runKeyOf(row: ChatTranscriptRow, index: number): string {
  return row.runId ?? `row:${index}`;
}

/**
 * Fold transcript rows into moments: one human moment per user row, and one ship moment per run
 * carrying that run's activities and its final text. A run with tools but no text yet is thinking.
 */
export function momentsFromRows(rows: readonly ChatTranscriptRow[], activeRunId: string | null): Moment[] {
  const moments: Moment[] = [];
  const shipByRun = new Map<string, Moment>();
  const toolRowsByRun = new Map<string, ChatTranscriptRow[]>();

  rows.forEach((row, index) => {
    const runKey = runKeyOf(row, index);
    if (row.role === "user") {
      moments.push({
        id: row.id,
        role: "human",
        text: row.text,
        streaming: false,
        thinking: false,
        runId: row.runId ?? null,
        processId: row.processId,
        timestamp: row.timestamp ?? null,
        activities: [],
        narration: "",
      });
      return;
    }
    if (isToolRow(row)) {
      const bucket = toolRowsByRun.get(runKey) ?? [];
      bucket.push(row);
      toolRowsByRun.set(runKey, bucket);
      if (!shipByRun.has(runKey)) {
        const placeholder: Moment = {
          id: `run:${runKey}`,
          role: "ship",
          text: "",
          streaming: false,
          thinking: activeRunId !== null && row.runId === activeRunId,
          runId: row.runId ?? null,
          processId: row.processId,
          timestamp: row.timestamp ?? null,
          activities: [],
          narration: "",
        };
        shipByRun.set(runKey, placeholder);
        moments.push(placeholder);
      } else {
        const existing = shipByRun.get(runKey);
        if (existing) existing.processId ??= row.processId;
      }
      return;
    }
    if (row.role === "assistant") {
      if (!row.text.trim() && !row.streaming) return;
      const existing = shipByRun.get(runKey);
      if (existing) {
        existing.id = row.id;
        existing.text = row.text;
        existing.streaming = row.streaming === true;
        existing.thinking = false;
        existing.timestamp = row.timestamp ?? existing.timestamp;
        existing.processId ??= row.processId;
        return;
      }
      const moment: Moment = {
        id: row.id,
        role: "ship",
        text: row.text,
        streaming: row.streaming === true,
        thinking: false,
        runId: row.runId ?? null,
        processId: row.processId,
        timestamp: row.timestamp ?? null,
        activities: [],
        narration: "",
      };
      shipByRun.set(runKey, moment);
      moments.push(moment);
      return;
    }
    if (row.role === "system" && row.text.trim()) {
      if (row.event?.audience === "model" && row.event.kind !== "history.compacted") return;
      moments.push({
        id: row.id,
        role: "note", event: row.event,
        text: row.text,
        streaming: false,
        thinking: false,
        runId: row.runId ?? null,
        processId: row.processId,
        timestamp: row.timestamp ?? null,
        activities: [],
        narration: "",
      });
    }
  });

  for (const [runKey, moment] of shipByRun) {
    const toolRows = toolRowsByRun.get(runKey);
    if (!toolRows) continue;
    const active = activeRunId !== null && moment.runId === activeRunId;
    moment.activities = activitiesForRows(toolRows, runKey, active);
  }
  return moments;
}

/* ---------- small formatting ---------- */

export function formatSeconds(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function activityDuration(activity: Activity): string {
  if (activity.startedAt === null || activity.endedAt === null) return "";
  return formatSeconds(Math.max(0, activity.endedAt - activity.startedAt));
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function placesUsed(moment: Moment): number {
  return new Set(moment.activities.flatMap((activity) => activity.target === null ? [] : [activity.target])).size;
}

/* ---------- streaming text resolving out of ramp glyphs ---------- */

export const RESOLVE_GLYPHS = "·.:+=o*Ø#@";
export const RESOLVE_TAIL = 22;

export type ResolvedChar = { char: string; noise: string | null };
export type ResolvedText = { head: string; tail: ResolvedChar[] };
const glyphSegmenter = Intl.Segmenter === undefined ? null : new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Split streaming text into a settled head and a tail whose newest characters are still glyph noise.
 * `random` is injected so the effect is testable.
 */
export function resolveTail(text: string, random: () => number, tail = RESOLVE_TAIL): ResolvedText {
  const glyphs = glyphSegmenter ? Array.from(glyphSegmenter.segment(text), (part) => part.segment) : Array.from(text);
  const cut = Math.max(0, glyphs.length - tail);
  const rest = glyphs.slice(cut);
  const chars: ResolvedChar[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    const age = (rest.length - index) / rest.length;
    const chance = age * age * 0.85;
    const noisy = !/^\s+$/u.test(char) && random() < chance;
    chars.push({
      char,
      noise: noisy ? RESOLVE_GLYPHS[Math.floor(random() * RESOLVE_GLYPHS.length)] : null,
    });
  }
  return { head: glyphs.slice(0, cut).join(""), tail: chars };
}

/* ---------- references to places inside ship text ---------- */

/** Replace `@name` mentions of known places with markdown links the renderer turns into fleet references. */
export function linkPlaceReferences(text: string, places: readonly Place[]): string {
  return text.replace(/(^|[\s(])@([\w.:-]+)/g, (whole, lead: string, name: string) => {
    const id = resolvePlace(name, places);
    return id ? `${lead}[@${name}](#place:${encodeURIComponent(id)})` : whole;
  });
}

export const PLACE_REFERENCE_PREFIX = "#place:";

const NOTE_SUMMARY_LENGTH = 92;

/** One line for a folded note: the first sentence or the first 92 characters, whichever is shorter. */
export function noteSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = flat.match(/^[^.!?]{12,}?[.!?](?=\s|$)/)?.[0] ?? flat;
  const candidate = sentence.length < flat.length ? sentence : flat;
  if (candidate.length <= NOTE_SUMMARY_LENGTH) return candidate;
  return `${candidate.slice(0, NOTE_SUMMARY_LENGTH - 3).trim()}...`;
}

/**
 * Moments from the conversation, which is what the ship actually sent and received, joined with the
 * process transcript for what it did along the way. Assistant text in the transcript is narration and
 * never becomes a message here; it folds under the moment it belongs to.
 */
export function momentsFromConversation(
  messages: readonly ChatTranscriptRow[],
  transcript: readonly ChatTranscriptRow[],
  activeRunId: string | null,
): Moment[] {
  const moments: Moment[] = [];
  const processesByRun = new Map<string, Set<string>>();
  for (const row of [...messages, ...transcript]) {
    if (!row.runId || !row.processId) continue;
    const processes = processesByRun.get(row.runId) ?? new Set<string>();
    processes.add(row.processId);
    processesByRun.set(row.runId, processes);
  }
  type Position = { record: [number, number] | null; timestamp: number | null };
  type Boundary = { id: string; position: Position; row: ChatTranscriptRow; moment?: Moment };
  type Work = { position: Position; rows: ChatTranscriptRow[] };
  type Run = { key: string; processId?: string; runId: string | null; boundaries: Boundary[]; work: Work[]; calls: Map<string, Work> };
  const runs = new Map<string, Run>();
  const runFor = (row: ChatTranscriptRow): Run => {
    const candidates = row.runId ? processesByRun.get(row.runId) : undefined;
    const processId = row.processId ?? (candidates?.size === 1 ? [...candidates][0] : undefined);
    const key = JSON.stringify([processId ?? null, row.runId ?? null, row.runId ? null : row.toolCallId ?? row.id]);
    let run = runs.get(key);
    if (!run) {
      run = { key, processId, runId: row.runId ?? null, boundaries: [], work: [], calls: new Map() };
      runs.set(key, run);
    }
    return run;
  };
  const position = (row: ChatTranscriptRow, call = false): Position => {
    const key = call ? row.toolCallRecordKey ?? row.historyRecordKey : row.historyRecordKey;
    const match = key ? /^(\d+):(\d+)$/.exec(key) : null;
    return {
      record: match ? [Number(match[1]), Number(match[2])] : null,
      timestamp: call ? row.toolStartedAt ?? row.timestamp : row.timestamp,
    };
  };
  const compare = (left: Position, right: Position): number => {
    if (left.record && right.record) return left.record[0] - right.record[0] || left.record[1] - right.record[1];
    return (left.timestamp ?? Infinity) - (right.timestamp ?? Infinity);
  };
  const canonical = new Map<string, ChatTranscriptRow>();
  for (const row of messages) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const key = JSON.stringify([row.role, row.messageId ?? row.id]);
    const previous = canonical.get(key);
    if (!previous || previous.streaming || !row.streaming) canonical.set(key, row);
  }
  for (const row of canonical.values()) {
    if (row.role === "assistant" && !row.text.trim() && !row.streaming && !row.media?.length) continue;
    const moment: Moment = {
      id: row.id,
      role: row.role === "user" ? "human" : "ship",
      text: row.text,
      media: row.media,
      streaming: row.streaming === true,
      thinking: false,
      runId: row.runId ?? null,
      processId: row.processId,
      timestamp: row.timestamp ?? null,
      activities: [],
      narration: "",
    };
    moments.push(moment);
    if (moment.role === "ship" && moment.runId) {
      const run = runFor(row);
      moment.processId ??= run.processId;
      run.boundaries.push({ id: String(row.messageId ?? row.id), position: position(row), row, moment });
    }
  }

  for (const row of transcript) {
    if (row.role === "system" && row.text.trim()) {
      if (row.event?.audience === "model" && row.event.kind !== "history.compacted") continue;
      moments.push({ id: row.id, role: "note", event: row.event, text: row.text, streaming: false, thinking: false, runId: row.runId ?? null, processId: row.processId, timestamp: row.timestamp ?? null, activities: [], narration: "" });
      continue;
    }
    if (row.messageDirection === "out") {
      if (!row.runId || !row.conversationMessageId) continue;
      const run = runFor(row);
      const boundary = run.boundaries.find((entry) => entry.id === row.conversationMessageId);
      if (boundary) boundary.position.record = position(row).record;
      else run.boundaries.push({ id: row.conversationMessageId, position: position(row), row });
      continue;
    }
    if (isToolRow(row) && !isMessageSend(row)) {
      const run = runFor(row);
      const key = row.toolCallId ?? row.id;
      const existing = run.calls.get(key);
      const start = position(row, true);
      if (existing) {
        existing.rows.push(row);
        if (compare(start, existing.position) < 0) existing.position = start;
      } else {
        const work = { position: start, rows: [row] };
        run.calls.set(key, work);
        run.work.push(work);
      }
    } else if (row.role === "assistant" && row.text.trim()) {
      runFor(row).work.push({ position: position(row), rows: [row] });
    }
  }

  for (const run of runs.values()) {
    run.boundaries.sort((left, right) => compare(left.position, right.position)
      || (left.row.conversationSequence ?? Infinity) - (right.row.conversationSequence ?? Infinity));
    run.work.sort((left, right) => compare(left.position, right.position));
    const segments = new Map<Boundary | undefined, Work[]>();
    for (const work of run.work) {
      const boundary = run.boundaries.find((entry) => compare(work.position, entry.position) <= 0);
      const segment = segments.get(boundary) ?? [];
      segment.push(work);
      segments.set(boundary, segment);
    }
    for (const [boundary, work] of segments) {
      const previous = boundary ? run.boundaries[run.boundaries.indexOf(boundary) - 1] : run.boundaries.at(-1);
      const active = activeRunId !== null && run.runId === activeRunId;
      let moment = boundary?.moment;
      if (!moment) {
        // a run that has not sent anything yet, or never did: it still shows what it did
        moment = {
          id: `work:${JSON.stringify([run.key, boundary ? ["before", boundary.id] : ["after", previous?.id ?? null]])}`,
          role: "ship", text: "", streaming: false, thinking: active, runId: run.runId, processId: run.processId,
          timestamp: work[0].position.timestamp, activities: [], narration: "",
        };
        if (previous?.moment?.timestamp !== undefined && previous.moment.timestamp !== null) {
          moment.timestamp = Math.max(moment.timestamp ?? previous.moment.timestamp, previous.moment.timestamp);
        }
        moments.push(moment);
      }
      const tools = work.filter((entry) => isToolRow(entry.rows[0])).map((entry) => {
        const terminal = entry.rows.filter((row) => row.role === "toolResult" || row.status === "done" || row.status === "error");
        const result = terminal.at(-1) ?? entry.rows.at(-1)!;
        const call = entry.rows.find((row) => row.role === "tool") ?? entry.rows[0];
        return {
          ...result, toolArgs: result.toolArgs ?? call.toolArgs, toolTarget: result.toolTarget ?? call.toolTarget,
          toolSyscall: result.toolSyscall ?? call.toolSyscall, toolStartedAt: entry.position.timestamp,
        };
      });
      moment.activities = activitiesForRows(tools, moment.id, active);
      moment.narration = work.filter((entry) => entry.rows[0].role === "assistant").map((entry) => entry.rows[0].text.trim()).join("\n\n");
    }
  }
  return moments.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/* the receipt: what a ship moment did, in plain words, generated from its calls */

export function receiptTargets(moment: Moment): { target: string; live: boolean; failed: boolean }[] {
  return moment.activities.filter((activity): activity is Activity & { target: string } => !activity.you && activity.target !== null).map((activity) => ({
    target: activity.target,
    live: activity.live,
    failed: activity.calls.some((call) => call.failed),
  }));
}

export function receiptSteps(moment: Moment): number {
  return moment.activities.reduce((total, activity) => (activity.you ? total : total + activity.calls.length), 0);
}

/** From the first call's start to the last call's end across every place the moment touched. */
export function receiptDuration(moment: Moment): string {
  let start: number | null = null;
  let end: number | null = null;
  for (const activity of moment.activities) {
    if (activity.you) continue;
    if (activity.startedAt !== null && (start === null || activity.startedAt < start)) start = activity.startedAt;
    if (activity.endedAt !== null && (end === null || activity.endedAt > end)) end = activity.endedAt;
  }
  return start !== null && end !== null && end > start ? formatSeconds(end - start) : "";
}
