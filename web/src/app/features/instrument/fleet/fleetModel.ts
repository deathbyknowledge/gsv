import { z } from "zod";
import { ledgerLabel } from "./ledgerLabels";
import type { ProcHilRequest } from "@humansandmachines/gsv";
import type { AsciiPlanetVariant } from "../../../components/ui/AsciiPlanet";
import type { ChatTranscriptValue } from "../../chat/domain/transcript";
import type { ConsoleProcess, ConsoleProcessState, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import type { FleetRow } from "../Instrument";

/** The cloud home is a place too; the target list does not carry it, so Fleet adds it. */
export const CLOUD_TARGET_ID = "gsv";
export const CLOUD_TARGET_LABEL = "your cloud home";

export type FleetApprovalReference = { kind: "approval"; pid: string; requestId: string };
export type FleetConnectReference = { kind: "connect"; to: "place" | "contact" };
export type FleetReference = FleetRow | FleetApprovalReference | FleetConnectReference;

export function isApprovalReference(reference: FleetReference | null): reference is FleetApprovalReference {
  return reference !== null && typeof reference === "object" && reference.kind === "approval";
}

export function fleetReferenceRow(reference: FleetReference | null): FleetRow | null {
  return isApprovalReference(reference) ? processRow(reference.pid) : typeof reference === "object" ? null : reference;
}

/** A link must never authorize a different request that subsequently occupies the same process. */
export function referencedApproval(pending: ProcHilRequest | null | undefined, pid: string, requestId?: string): ProcHilRequest | null {
  return pending?.pid === pid && (requestId === undefined || pending.requestId === requestId) ? pending : null;
}

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
  ownerUid: number | null;
};

type PlaceActions = { pair: boolean; forget: boolean };

export function placeActions(place: Place, uid: number | null): PlaceActions {
  const supported = place.kind === "machine" || place.kind === "browser";
  const owner = uid !== null && uid === place.ownerUid;
  return { pair: supported && owner && !place.online, forget: supported && uid !== null && (owner || uid === 0) };
}

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
  /** The call's arguments as the Kernel recorded them, JSON text; empty for a line made here. */
  args: string;
  outcome: string;
  runId: string | null;
  costNanoUsd: number | null;
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
    ownerUid: target.ownerUid,
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
    ownerUid: null,
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

/** An explicitly selected process stays visible even beyond the current page. */
export function visibleProcesses(processes: readonly ConsoleProcess[], selected: FleetRow | null, limit: number): ConsoleProcess[] {
  const selectedIndex = processes.findIndex((process) => processRow(process.pid) === selected);
  return processes.slice(0, Math.max(limit, selectedIndex + 1));
}

/** A linked process or target keeps its identity when unavailable; ordinary row navigation can leave it. */
export function reconcileFleetSelection(selected: FleetRow | null, initialRow: FleetRow | null, visibleRows: readonly FleetRow[]): FleetRow | null {
  if (selected && (visibleRows.includes(selected) || (selected === initialRow && (selected.startsWith("proc:") || selected.startsWith("target:"))))) return selected;
  return initialRow && visibleRows.includes(initialRow) ? initialRow : visibleRows[0] ?? null;
}

export function ledgerRow(lineId: string): FleetRow {
  return `ledger:${lineId}`;
}

/** Every selectable row in manifest order: places, then processes. */
export function rowKeys(places: readonly Place[], processes: readonly ConsoleProcess[], ledger: readonly LedgerLine[] = []): FleetRow[] {
  return [...places.map((place) => targetRow(place.id)), ...processes.map((process) => processRow(process.pid)), ...ledger.map((line) => ledgerRow(line.id))];
}

const toolArgsSchema = z.object({
  input: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  code: z.string().optional(),
  script: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  key: z.string().optional(),
  id: z.string().optional(),
  pid: z.string().optional(),
  targetId: z.string().optional(),
  label: z.string().optional(),
  alias: z.string().nullable().optional(),
  source: z.object({ path: z.string(), target: z.string().optional() }).optional(),
  destination: z.object({ path: z.string(), target: z.string().optional() }).optional(),
  provider: z.string().optional(),
  username: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  serverId: z.string().optional(),
  contactId: z.string().optional(),
  adapter: z.string().optional(),
  states: z.array(z.string()).optional(),
});

type ToolArgs = z.infer<typeof toolArgsSchema>;

/** The arguments people recognize, parsed at the boundary; anything else is an empty set. */
function parseToolArgs(value: ChatTranscriptValue | undefined): ToolArgs {
  const parsed = toolArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The place a tool call ran on: its `target` argument, else the cloud home. */
/** The argument that matters, collapsed to one line, so a heredoc or a long path never breaks a row. */
export function describeToolCall(syscall: string, args: ChatTranscriptValue | undefined): string {
  const parsed = parseToolArgs(args);
  let detail = "";
  if (syscall === "shell.exec") detail = parsed.input ?? "";
  else if (syscall === "fs.copy") detail = [parsed.source, parsed.destination].map((endpoint) => endpoint ? `${endpoint.target ? `${endpoint.target}:` : ""}${endpoint.path}` : "").filter(Boolean).join(" → ");
  else if (syscall.startsWith("fs.")) detail = [parsed.path, syscall === "fs.search" ? parsed.query : null].filter(Boolean).join(" · ");
  else if (syscall.startsWith("net.")) detail = parsed.url ?? "";
  else if (syscall.startsWith("codemode.")) detail = parsed.code || parsed.script || "";
  else if (syscall.startsWith("ai.")) detail = parsed.model ?? "";
  else if (syscall.startsWith("sys.config.")) detail = parsed.key ?? "";
  else if (syscall.startsWith("r12y.")) detail = parsed.title || parsed.id || parsed.states?.join(" · ") || "";
  else if (syscall.startsWith("repo.")) detail = [parsed.repo, parsed.ref, parsed.path, parsed.query].filter(Boolean).join(" · ");
  else if (syscall.startsWith("proc.")) detail = parsed.label || parsed.pid || "";
  else if (syscall.startsWith("sched.")) detail = parsed.name || parsed.id || "";
  else if (syscall.startsWith("contact.")) detail = parsed.alias || parsed.contactId || "";
  else if (syscall.startsWith("account.")) detail = parsed.username ?? "";
  else if (syscall.startsWith("sys.target.")) detail = [parsed.targetId, parsed.label].filter(Boolean).join(" · ");
  else if (syscall.startsWith("sys.mcp.")) detail = parsed.name || parsed.serverId || "";
  else if (syscall.startsWith("sys.oauth.")) detail = parsed.provider ?? "";
  else if (syscall.startsWith("adapter.") || syscall.startsWith("sys.link") || syscall === "sys.unlink") detail = parsed.adapter ?? "";
  return detail.replace(/\s+/g, " ").trim();
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
  if (syscall === "fs.edit") return name ? `edited ${name}` : "edited a file";
  if (syscall === "fs.write") return name ? `wrote ${name}` : "wrote a file";
  if (syscall === "fs.delete") return name ? `removed ${name}` : "removed a file";
  if (syscall === "fs.copy") return name ? `copied ${name}` : "copied a file";
  if (syscall === "fs.search") return parsed.query ? `searched for ${parsed.query}` : "searched files";
  if (syscall === "net.fetch") return parsed.url ? `fetched ${hostOf(parsed.url)}` : "fetched from the web";
  return ledgerLabel(syscall);
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

const NANO_USD = 1_000_000_000;

/** What each process spent today, in USD, from the ledger's ai lines. */
export function costTodayByProcess(ledger: readonly LedgerLine[], now: number): Map<string, number> {
  const since = startOfToday(now);
  const totals = new Map<string, number>();
  for (const line of ledger) {
    if (line.costNanoUsd === null || line.timestamp === null || line.timestamp < since) continue;
    totals.set(line.processId, (totals.get(line.processId) ?? 0) + line.costNanoUsd / NANO_USD);
  }
  return totals;
}

/** The model each process last thought with, from the newest ai line that names one. */
export function modelByProcess(ledger: readonly LedgerLine[]): Map<string, string> {
  const models = new Map<string, string>();
  for (const line of ledger) {
    if (!line.syscall.startsWith("ai.") || models.has(line.processId)) continue;
    const model = parseToolArgs(parseLedgerArgs(line.args)).model;
    if (model) models.set(line.processId, model);
  }
  return models;
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

/* ---------- the Kernel's ledger ---------- */
const sysLedgerLineSchema = z.object({
  seq: z.number(),
  timestamp: z.number(),
  principalKind: z.string(),
  uid: z.number(),
  pid: z.string().nullable(),
  runId: z.string().nullable(),
  target: z.string(),
  call: z.string(),
  args: z.string(),
  outcome: z.enum(["ok", "failed", "denied", "cancelled"]).nullable(),
  durationMs: z.number().nullable(),
  tokens: z.number().nullable().optional(),
  costNanoUsd: z.number().nullable().optional(),
});
export const sysLedgerListResultSchema = z.object({ lines: z.array(sysLedgerLineSchema), nextCursor: z.string().nullable() });
export type SysLedgerListResult = z.infer<typeof sysLedgerListResultSchema>;

/** The Kernel records arguments as JSON text, cut at a size bound; a cut line is kept as its text. */
export function parseLedgerArgs(args: string): ChatTranscriptValue | undefined {
  try {
    const parsed = JSON.parse(args);
    return jsonValueSchema.parse(parsed);
  } catch {
    return undefined;
  }
}

const jsonValueSchema: z.ZodType<ChatTranscriptValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/** Lines from `sys.ledger.list`, in the shape Fleet draws. */
export function ledgerFromSysLines(lines: readonly z.infer<typeof sysLedgerLineSchema>[]): LedgerLine[] {
  return lines.map((line) => {
    const args = parseLedgerArgs(line.args);
    return {
      id: `sys:${line.seq}`,
      timestamp: line.timestamp,
      processId: line.pid ?? (line.principalKind === "human" ? "you" : "gsv"),
      place: line.target,
      syscall: line.call,
      what: humanCall(line.call, args),
      detail: describeToolCall(line.call, args),
      args: line.args,
      outcome: line.outcome === null ? "running" : line.outcome === "ok" ? "completed" : line.outcome,
      runId: line.runId,
      costNanoUsd: line.costNanoUsd ?? null,
    };
  });
}
