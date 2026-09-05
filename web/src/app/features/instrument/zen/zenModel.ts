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
  role: "human" | "ship";
  text: string;
  streaming: boolean;
  thinking: boolean;
  runId: string | null;
  timestamp: number | null;
  activities: Activity[];
};

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

function callFromRow(row: ChatTranscriptRow): ActivityCall {
  const syscall = row.toolSyscall ?? row.toolName ?? "call";
  const finished = row.role === "toolResult" || row.status === "done" || row.status === "error";
  const summary = argumentThatMatters(syscall, row.toolArgs) || (row.toolName ?? syscall);
  return {
    callId: row.toolCallId ?? row.id,
    syscall,
    summary,
    output: finished ? trimOutput(row.text) : "",
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
export function activitiesForRows(rows: readonly ChatTranscriptRow[], runKey: string, active: boolean): Activity[] {
  const activities: Activity[] = [];
  for (const row of rows) {
    if (!isToolRow(row)) continue;
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
      };
      shipByRun.set(runKey, moment);
      moments.push(moment);
      return;
    }
    if (row.role === "system" && row.text.trim()) {
      moments.push({
        id: row.id,
        role: "ship",
        text: row.text,
        streaming: false,
        thinking: false,
        runId: row.runId ?? null,
        timestamp: row.timestamp ?? null,
        activities: [],
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
