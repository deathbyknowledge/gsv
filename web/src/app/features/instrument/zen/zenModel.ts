import { z } from "zod";
import type { ProcMessageMetadata } from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow, ChatTranscriptValue } from "../../chat/domain/transcript";

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
};

export type Activity = {
  key: string;
  target: string;
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
  text: string;
  streaming: boolean;
  thinking: boolean;
  runId: string | null;
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

export type AnswerAttribution = {
  model: string | null;
  provider: string | null;
  fallbacks: Array<{ from: string; to: string; reason: string | null }>;
  omittedFallbacks: number;
};

/** Attribute a committed answer to its generation, never to the process's current model setting. */
export function answerAttribution(
  moment: Pick<Moment, "role" | "text" | "runId" | "timestamp" | "streaming">,
  history: readonly AnswerHistoryEntry[],
  historyThrough: number,
): AnswerAttribution | null {
  if (moment.role !== "ship" || !moment.text.trim() || moment.streaming || !moment.runId || moment.timestamp === null) return null;
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
export function callTarget(args: ChatTranscriptValue | undefined): string {
  return stringField(args, "target") ?? CLOUD_PLACE_ID;
}

/** The one argument a person wants to see: the command, the path, the URL, or the tool's name. */
export function argumentThatMatters(syscall: string, args: ChatTranscriptValue | undefined): string {
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

const shellResultSchema = z.object({ stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().nullable().optional() });
const commandResultSchema = z.object({ status: z.string().optional(), output: z.string() });
const fileResultSchema = z.object({ content: z.string().optional(), entries: z.array(z.object({ name: z.string(), kind: z.string().optional() })).optional() });
const searchResultSchema = z.object({ results: z.array(z.object({ path: z.string() })).optional(), matches: z.array(z.object({ path: z.string() })).optional() });

/** The tool result as a person would read it: stdout and stderr for a command, content or names for files, never the transport JSON. */
export function outputText(syscall: string, output: ChatTranscriptValue | undefined, fallback: string): string {
  if (output === undefined || output === null) return fallback;
  if (syscall === "shell.exec" || syscall.startsWith("codemode.")) {
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
function resultOf(row: ChatTranscriptRow): ChatTranscriptValue | undefined {
  if (row.toolOutput !== undefined && row.toolOutput !== null && !isStringValue(row.toolOutput)) return row.toolOutput;
  const text = isStringValue(row.toolOutput) ? row.toolOutput : row.text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return row.toolOutput ?? undefined;
  try {
    const parsed: ChatTranscriptValue = JSON.parse(trimmed);
    return parsed;
  } catch {
    return row.toolOutput ?? undefined;
  }
}

function callFromRow(row: ChatTranscriptRow): ActivityCall {
  const syscall = row.toolSyscall ?? row.toolName ?? "call";
  const finished = row.role === "toolResult" || row.status === "done" || row.status === "error";
  const summary = argumentThatMatters(syscall, row.toolArgs) || (row.toolName ?? syscall);
  return {
    callId: row.toolCallId ?? row.id,
    syscall,
    summary,
    output: finished ? trimOutput(outputText(syscall, resultOf(row), row.text)) : "",
    finished,
    failed: row.isError === true || row.toolOutcome === "failed" || row.toolOutcome === "denied",
  };
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
  if ((row.toolSyscall ?? row.toolName) !== "shell.exec") return false;
  const input = stringField(row.toolArgs, "input") ?? "";
  return /^\s*(gsv\s+)?message\b/.test(input);
}

export function activitiesForRows(rows: readonly ChatTranscriptRow[], runKey: string, active: boolean): Activity[] {
  const activities: Activity[] = [];
  for (const row of rows) {
    if (!isToolRow(row) || isMessageSend(row)) continue;
    const target = callTarget(row.toolArgs);
    const call = callFromRow(row);
    const existing = activities.find((activity) => activity.target === target);
    const timestamp = row.timestamp ?? null;
    if (existing) {
      const index = existing.calls.findIndex((candidate) => candidate.callId === call.callId);
      if (index >= 0) existing.calls[index] = call;
      else existing.calls.push(call);
      if (timestamp !== null) existing.endedAt = timestamp;
    } else {
      activities.push({
        key: `${runKey}:${target}`,
        target,
        calls: [call],
        live: false,
        you: false,
        startedAt: timestamp,
        endedAt: timestamp,
      });
    }
  }
  if (active && activities.length > 0) {
    const last = activities[activities.length - 1];
    last.live = last.calls.some((call) => !call.finished);
  }
  return activities;
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
          timestamp: row.timestamp ?? null,
          activities: [],
          narration: "",
        };
        shipByRun.set(runKey, placeholder);
        moments.push(placeholder);
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
        return;
      }
      const moment: Moment = {
        id: row.id,
        role: "ship",
        text: row.text,
        streaming: row.streaming === true,
        thinking: false,
        runId: row.runId ?? null,
        timestamp: row.timestamp ?? null,
        activities: [],
        narration: "",
      };
      shipByRun.set(runKey, moment);
      moments.push(moment);
      return;
    }
    if (row.role === "system" && row.text.trim()) {
      moments.push({
        id: row.id,
        role: "note",
        text: row.text,
        streaming: false,
        thinking: false,
        runId: row.runId ?? null,
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
  return new Set(moment.activities.map((activity) => activity.target)).size;
}

/* ---------- streaming text resolving out of ramp glyphs ---------- */

export const RESOLVE_GLYPHS = "·.:+=o*Ø#@";
export const RESOLVE_TAIL = 22;

export type ResolvedChar = { char: string; noise: string | null };
export type ResolvedText = { head: string; tail: ResolvedChar[] };

/**
 * Split streaming text into a settled head and a tail whose newest characters are still glyph noise.
 * `random` is injected so the effect is testable.
 */
export function resolveTail(text: string, random: () => number, tail = RESOLVE_TAIL): ResolvedText {
  const cut = Math.max(0, text.length - tail);
  const rest = text.slice(cut);
  const chars: ResolvedChar[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    const age = (rest.length - index) / rest.length;
    const chance = age * age * 0.85;
    const noisy = char !== " " && char !== "\n" && random() < chance;
    chars.push({
      char,
      noise: noisy ? RESOLVE_GLYPHS[Math.floor(random() * RESOLVE_GLYPHS.length)] : null,
    });
  }
  return { head: text.slice(0, cut), tail: chars };
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
  const shipByRun = new Map<string, Moment>();
  for (const row of messages) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (row.role === "assistant" && !row.text.trim() && !row.streaming) continue;
    const moment: Moment = {
      id: row.id,
      role: row.role === "user" ? "human" : "ship",
      text: row.text,
      streaming: row.streaming === true,
      thinking: false,
      runId: row.runId ?? null,
      timestamp: row.timestamp ?? null,
      activities: [],
      narration: "",
    };
    moments.push(moment);
    if (moment.role === "ship" && moment.runId) shipByRun.set(moment.runId, moment);
  }

  const toolRowsByRun = new Map<string, ChatTranscriptRow[]>();
  const narrationByRun = new Map<string, string[]>();
  const runStarted = new Map<string, number | null>();
  transcript.forEach((row, index) => {
    if (row.role === "system" && row.text.trim()) {
      moments.push({ id: row.id, role: "note", text: row.text, streaming: false, thinking: false, runId: row.runId ?? null, timestamp: row.timestamp ?? null, activities: [], narration: "" });
      return;
    }
    const runKey = runKeyOf(row, index);
    if (!runStarted.has(runKey)) runStarted.set(runKey, row.timestamp ?? null);
    if (isToolRow(row)) {
      const bucket = toolRowsByRun.get(runKey) ?? [];
      bucket.push(row);
      toolRowsByRun.set(runKey, bucket);
    } else if (row.role === "assistant" && row.text.trim()) {
      const bucket = narrationByRun.get(runKey) ?? [];
      bucket.push(row.text.trim());
      narrationByRun.set(runKey, bucket);
    }
  });

  const runKeys = new Set([...toolRowsByRun.keys(), ...narrationByRun.keys()]);
  for (const runKey of runKeys) {
    const toolRows = toolRowsByRun.get(runKey) ?? [];
    const active = activeRunId !== null && runKey === activeRunId;
    let moment = shipByRun.get(runKey);
    if (!moment) {
      // a run that has not sent anything yet, or never did: it still shows what it did
      moment = { id: `run:${runKey}`, role: "ship", text: "", streaming: false, thinking: active, runId: runKey, timestamp: runStarted.get(runKey) ?? null, activities: [], narration: "" };
      moments.push(moment);
      shipByRun.set(runKey, moment);
    }
    moment.activities = toolRows.length > 0 ? activitiesForRows(toolRows, runKey, active) : [];
    moment.narration = (narrationByRun.get(runKey) ?? []).join("\n\n");
    if (moment.thinking && (moment.activities.length > 0 || moment.narration)) moment.thinking = active;
  }

  return moments.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/* the receipt: what a ship moment did, in plain words, generated from its calls */

type ReceiptVerb = { past: string; present: string; noun: string };
const verb = (past: string, present: string, noun: string): ReceiptVerb => ({ past, present, noun });
const RECEIPT_VERBS = new Map<string, ReceiptVerb>([
  ["fs.read", verb("read", "reading", "files")],
  ["fs.write", verb("wrote", "writing", "files")],
  ["fs.edit", verb("edited", "editing", "files")],
  ["fs.delete", verb("deleted", "deleting", "files")],
  ["fs.list", verb("listed", "listing", "folders")],
  ["fs.search", verb("searched", "searching", "searches")],
  ["fs.grep", verb("searched", "searching", "searches")],
  ["fs.copy", verb("copied", "copying", "files")],
  ["fs.stat", verb("checked", "checking", "files")],
  ["fs.transfer.send", verb("sent", "sending", "files")],
  ["shell.exec", verb("ran", "running", "commands")],
  ["codemode.exec", verb("ran code", "running code", "scripts")],
  ["net.fetch", verb("fetched", "fetching", "pages")],
]);

/** The words that stand for a syscall; an unknown one keeps its own name, which is still true. */
function receiptVerb(syscall: string, present: boolean): [verb: string, noun: string] {
  const known = RECEIPT_VERBS.get(syscall);
  if (known) return [present ? known.present : known.past, known.noun];
  return [present ? `${syscall}…` : syscall, "steps"];
}

function shortenMiddle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** The one argument a person wants to see, qualified by its place when that place is not the cloud home. */
function receiptWhat(syscall: string, summary: string, target: string): string {
  if (!summary) return "";
  if (syscall.startsWith("net.")) {
    try {
      return new URL(summary).host;
    } catch {
      return shortenMiddle(summary);
    }
  }
  const qualified = syscall.startsWith("fs.") && target !== CLOUD_PLACE_ID ? `${target}:${summary}` : summary;
  return shortenMiddle(qualified);
}

export type ReceiptPhrase = {
  verb: string;
  /** The argument shown; null when three or more alike calls were folded into a count. */
  what: string | null;
  count: number;
  noun: string;
  failed: boolean;
};

const RECEIPT_FOLD_AT = 3;

/** Finished calls as phrases, in order; a run of three or more with the same verb folds into a count. */
export function receiptPhrases(moment: Moment): ReceiptPhrase[] {
  const singles: ReceiptPhrase[] = [];
  for (const activity of moment.activities) {
    if (activity.you) continue;
    for (const call of activity.calls) {
      if (!call.finished) continue;
      const [verb, noun] = receiptVerb(call.syscall, false);
      singles.push({ verb, what: receiptWhat(call.syscall, call.summary, activity.target), count: 1, noun, failed: call.failed });
    }
  }
  const phrases: ReceiptPhrase[] = [];
  let index = 0;
  while (index < singles.length) {
    let end = index + 1;
    while (end < singles.length && singles[end].verb === singles[index].verb && !singles[end].failed && !singles[index].failed) end += 1;
    const run = end - index;
    if (run >= RECEIPT_FOLD_AT) phrases.push({ ...singles[index], what: null, count: run });
    else phrases.push(...singles.slice(index, end));
    index = end;
  }
  return phrases;
}

/** The call still running, in the present tense, or null when nothing is. */
export function receiptRunning(moment: Moment): ReceiptPhrase | null {
  for (const activity of moment.activities) {
    if (activity.you) continue;
    const call = activity.calls.find((entry) => !entry.finished);
    if (!call) continue;
    const [verb, noun] = receiptVerb(call.syscall, true);
    return { verb, what: receiptWhat(call.syscall, call.summary, activity.target), count: 1, noun, failed: false };
  }
  return null;
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
