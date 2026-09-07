import { z } from "zod";
import type { AsciiPlanetVariant } from "../../../components/ui/AsciiPlanet";
import type { ChatTranscriptRow, ChatTranscriptValue } from "../../chat/domain/transcript";
import type { ConsoleProcess, ConsoleProcessState, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import type { FleetRow } from "../Instrument";

/** The cloud home is a place too; the target list does not carry it, so Fleet adds it. */
export const CLOUD_TARGET_ID = "gsv";
export const CLOUD_TARGET_LABEL = "your cloud home";

export type PlaceKind = "machine" | "cloud" | "browser" | "contact" | "unknown";

export type Place = {
  id: string;
  label: string;
  kind: PlaceKind;
  online: boolean;
  lastSeenAt: number | null;
  platform: string;
  version: string;
  description: string;
};

export type LedgerLine = {
  id: string;
  timestamp: number | null;
  processId: string;
  place: string;
  syscall: string;
  /** What happened, in a person's words: "read a file", "sent a message". */
  what: string;
  /** The argument that matters, one line: a path, a command, a query. */
  detail: string;
  outcome: string;
  runId: string | null;
};

export function placeFromTarget(target: ConsoleTarget): Place {
  return {
    id: target.deviceId,
    label: target.label || target.deviceId,
    kind: target.kind === "native-device" ? "machine" : target.kind === "browser" ? "browser" : "unknown",
    online: target.online,
    lastSeenAt: target.lastSeenAt,
    platform: target.platform,
    version: target.version,
    description: target.description,
  };
}

export function cloudPlace(): Place {
  return {
    id: CLOUD_TARGET_ID,
    label: CLOUD_TARGET_LABEL,
    kind: "cloud",
    online: true,
    lastSeenAt: null,
    platform: "cloudflare",
    version: "",
    description: "The gateway's own filesystem, memory, and inference.",
  };
}

/** Machines first, then the cloud home, then browsers and the rest, each group alphabetical. */
export function orderPlaces(targets: readonly ConsoleTarget[]): Place[] {
  const places = targets.map(placeFromTarget);
  if (!places.some((place) => place.id === CLOUD_TARGET_ID)) {
    places.push(cloudPlace());
  }
  const rank = (kind: PlaceKind) => (kind === "machine" ? 0 : kind === "cloud" ? 1 : kind === "browser" ? 2 : 3);
  return places.sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
}

export function planetVariantForKind(kind: PlaceKind): AsciiPlanetVariant {
  switch (kind) {
    case "machine":
      return "orbit";
    case "cloud":
      return "giant";
    case "browser":
      return "disc";
    case "contact":
      return "crescent";
    default:
      return "moon";
  }
}

export function placeStateLabel(place: Place): string {
  return place.online ? "connected" : "offline";
}

export function processStateLabel(state: ConsoleProcessState): string {
  switch (state) {
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "waiting_hil":
      return "waiting for approval";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

export function processStateTone(state: ConsoleProcessState): "on" | "live" | "warn" | "idle" {
  switch (state) {
    case "running":
      return "live";
    case "queued":
      return "on";
    case "waiting_hil":
      return "warn";
    default:
      return "idle";
  }
}

/** Most recently active first; the personal process (the ship) always leads. */
export function orderProcesses(processes: readonly ConsoleProcess[]): ConsoleProcess[] {
  return processes.slice().sort((a, b) => {
    if (a.personal !== b.personal) return a.personal ? -1 : 1;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.label.localeCompare(b.label);
  });
}

export function targetRow(placeId: string): FleetRow {
  return `target:${placeId}`;
}

export function processRow(pid: string): FleetRow {
  return `proc:${pid}`;
}

export function ledgerRow(lineId: string): FleetRow {
  return `ledger:${lineId}`;
}

/** Every selectable row in manifest order: places, then processes. */
export function rowKeys(places: readonly Place[], processes: readonly ConsoleProcess[], ledger: readonly LedgerLine[] = []): FleetRow[] {
  return [...places.map((place) => targetRow(place.id)), ...processes.map((process) => processRow(process.pid)), ...ledger.map((line) => ledgerRow(line.id))];
}

const toolArgsSchema = z.object({
  target: z.string().optional(),
  input: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  code: z.string().optional(),
  script: z.string().optional(),
});

type ToolArgs = z.infer<typeof toolArgsSchema>;

/** The arguments people recognize, parsed at the boundary; anything else is an empty set. */
function parseToolArgs(value: ChatTranscriptValue | undefined): ToolArgs {
  const parsed = toolArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The place a tool call ran on: its `target` argument, else the cloud home. */
export function targetFromToolArgs(args: ChatTranscriptValue | undefined): string {
  return parseToolArgs(args).target ?? CLOUD_TARGET_ID;
}

/** The argument that matters, collapsed to one line, so a heredoc or a long path never breaks a row. */
export function describeToolCall(syscall: string, args: ChatTranscriptValue | undefined): string {
  const parsed = parseToolArgs(args);
  const raw = parsed.input || parsed.path || parsed.url || parsed.query || parsed.code || parsed.script || syscall;
  return raw.replace(/\s+/g, " ").trim();
}

const SHELL_VERBS: readonly [RegExp, string][] = [
  [/^(gsv\s+)?message\b/, "sent a message"],
  [/^(ls|find|tree|du|pwd)\b/, "looked around"],
  [/^(cat|head|tail|less|more|bat)\b/, "read a file"],
  [/^(grep|rg|ag)\b/, "searched files"],
  [/^cp\b/, "copied files"],
  [/^mv\b/, "moved files"],
  [/^(rm|rmdir|trash)\b/, "removed files"],
  [/^(mkdir|touch)\b/, "made a place for files"],
  [/^git\b/, "used git"],
  [/^(curl|wget|http)\b/, "fetched from the web"],
  [/^(python|python3|node|npm|npx|cargo|go|make|bun|deno)\b/, "ran a program"],
  [/^(open|xdg-open)\b/, "opened something"],
];

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const name = trimmed.split(/[/\\]/).pop() ?? trimmed;
  return name || path;
}

function hostOf(url: string): string {
  const match = url.match(/^[a-z]+:\/\/([^/]+)/i);
  return match ? match[1] : url;
}

/** What a call did, in the words a person would use, with the raw syscall left for the technical view. */
export function humanCall(syscall: string, args: ChatTranscriptValue | undefined): string {
  const parsed = parseToolArgs(args);
  if (syscall === "shell.exec") {
    const input = (parsed.input ?? "").replace(/\s+/g, " ").trim();
    for (const [pattern, verb] of SHELL_VERBS) if (pattern.test(input)) return verb;
    return "ran a command";
  }
  const name = parsed.path ? basename(parsed.path) : "";
  if (syscall === "fs.read") return name ? `read ${name}` : "read a file";
  if (syscall === "fs.write") return name ? `wrote ${name}` : "wrote a file";
  if (syscall === "fs.delete") return name ? `removed ${name}` : "removed a file";
  if (syscall === "fs.copy") return name ? `copied ${name}` : "copied a file";
  if (syscall === "fs.search") return parsed.query ? `searched for ${parsed.query}` : "searched files";
  if (syscall.startsWith("fs.transfer")) return "moved a file between places";
  if (syscall.startsWith("fs.")) return "worked with files";
  if (syscall === "net.fetch") return parsed.url ? `fetched ${hostOf(parsed.url)}` : "fetched from the web";
  if (syscall.startsWith("codemode.")) return "ran a script";
  if (syscall.startsWith("ai.")) return "thought about it";
  if (syscall === "adapter.send") return "sent a message";
  if (syscall.startsWith("adapter.")) return "used a messenger";
  if (syscall === "proc.spawn") return "started a helper";
  if (syscall.startsWith("proc.")) return "checked on a helper";
  if (syscall.startsWith("contact.")) return "worked with a contact";
  if (syscall.startsWith("sys.")) return "checked the system";
  return syscall;
}

export function ledgerFromRows(rows: readonly ChatTranscriptRow[], processId: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const row of rows) {
    const syscall = row.toolSyscall ?? row.toolName;
    if (!syscall) continue;
    lines.push({
      id: `${processId}:${row.id}`,
      timestamp: row.timestamp,
      processId,
      place: targetFromToolArgs(row.toolArgs),
      syscall,
      what: humanCall(syscall, row.toolArgs),
      detail: describeToolCall(syscall, row.toolArgs),
      outcome: row.toolOutcome ?? (row.status === "error" ? "failed" : row.status === "running" ? "running" : "completed"),
      runId: row.runId ?? null,
    });
  }
  return lines;
}

/** Newest first, capped. Lines without a timestamp sort last. */
export function mergeLedger(lists: readonly (readonly LedgerLine[])[], cap: number): LedgerLine[] {
  const merged = lists.flat();
  merged.sort((a, b) => (b.timestamp ?? -1) - (a.timestamp ?? -1));
  return merged.slice(0, cap);
}

export function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function runsTodayByPlace(ledger: readonly LedgerLine[], now: number): Map<string, number> {
  const since = startOfToday(now);
  const counts = new Map<string, number>();
  for (const line of ledger) {
    if (line.timestamp === null || line.timestamp < since) continue;
    counts.set(line.place, (counts.get(line.place) ?? 0) + 1);
  }
  return counts;
}

/** Files a run touched, newest first, one entry per path. */
export function recentlyTouched(ledger: readonly LedgerLine[], limit: number): LedgerLine[] {
  const seen = new Set<string>();
  const touched: LedgerLine[] = [];
  for (const line of ledger) {
    if (!line.syscall.startsWith("fs.")) continue;
    const key = `${line.place}:${line.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    touched.push(line);
    if (touched.length >= limit) break;
  }
  return touched;
}

export function relativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function clockTime(timestamp: number | null): string {
  if (timestamp === null) return "--:--:--";
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatUsd(total: number | null | undefined): string {
  if (total === null || total === undefined) return "—";
  return total < 0.01 ? "<$0.01" : `$${total.toFixed(2)}`;
}

export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** A process id is a long opaque string on the wire; people read the label and a six-character tail. */
export function shortPid(pid: string): string {
  const compact = pid.replace(/[^a-z0-9]/gi, "");
  return compact.length <= 8 ? compact : compact.slice(-6);
}

/* ---------- the Kernel's own ledger, when the gateway has it ---------- */
const sysLedgerLineSchema = z.object({
  seq: z.number(),
  timestamp: z.number(),
  principalKind: z.string(),
  uid: z.number(),
  pid: z.string().nullable(),
  runId: z.string().nullable(),
  target: z.string(),
  call: z.string(),
  detail: z.string(),
  outcome: z.enum(["ok", "failed", "denied", "cancelled"]).nullable(),
  durationMs: z.number().nullable(),
});
export const sysLedgerListResultSchema = z.object({ lines: z.array(sysLedgerLineSchema), nextCursor: z.string().nullable() });
export type SysLedgerListResult = z.infer<typeof sysLedgerListResultSchema>;

function argsFromDetail(call: string, detail: string): { input?: string; path?: string; url?: string; query?: string } {
  if (call === "shell.exec" || call.startsWith("codemode.")) return { input: detail };
  if (call === "fs.search") return { query: detail };
  if (call.startsWith("fs.")) return { path: detail };
  if (call === "net.fetch") return { url: `https://${detail}` };
  return {};
}

/** Lines from `sys.ledger.list`, in the same shape Fleet draws, so the two sources are interchangeable. */
export function ledgerFromSysLines(lines: readonly z.infer<typeof sysLedgerLineSchema>[]): LedgerLine[] {
  return lines.map((line) => ({
    id: `sys:${line.seq}`,
    timestamp: line.timestamp,
    processId: line.pid ?? (line.principalKind === "user" ? "you" : "gsv"),
    place: line.target,
    syscall: line.call,
    what: humanCall(line.call, argsFromDetail(line.call, line.detail)),
    detail: line.detail,
    outcome: line.outcome === null ? "running" : line.outcome === "ok" ? "completed" : line.outcome,
    runId: line.runId,
  }));
}
