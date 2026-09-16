/**
 * A gateway that lives in this tab, so Zen's states can be looked at on demand.
 *
 * Development only. GatewayProvider installs it when the page runs on the Vite dev server with
 * `?mock=1` (http://localhost:5180/?mock=1); production builds drop this module. The choice sticks to
 * the tab, since Instrument rewrites the URL on navigation, and `?mock=0` turns it off again. A seeded
 * session lands straight in Zen signed in; with storage cleared, any username and password sign in.
 * The real GSVClient runs unchanged over an in-memory WebSocket, so the frames, statuses and signals
 * are the ones the wire would carry, in the order the gateway emits them: stream events, run output,
 * typed history records, tool signals, ledger rows and the message stream. Fixtures are the plain
 * objects below.
 *
 * Typed into the prompt:
 *   /run       a scripted run: Ship thinks, checks the studio disk, reads your backup notes, dry-runs
 *              the sync, then streams a reply about what it found (one to three seconds a step)
 *   /run-long  nine steps across both places, one of them failing and retried, then the reply
 *   /run-old   the short run with no recorded purposes, to compare the generated descriptions
 *   /think     Ship starts the first step and holds it, with no words yet, until /reply or /stream
 *   /stream    a multi-paragraph answer streams in, word by word (finishing an open step first)
 *   /reply     a plain reply is committed (finishing an open step first)
 *   /approve, /approve-old   a shell approval, with and without a purpose
 *   /approve-mail, /approve-file   an email or file approval; y/n decides, a new message interrupts
 *   anything else is committed as your message and answered briefly a second later
 */
import { GSVClient, type GsvPeerInfo } from "@humansandmachines/gsv/client";
import {
  wireFrameSchemas,
  type AccountSummary,
  type AiTextContent,
  type AiThinkingContent,
  type AiToolCall,
  type ConnectResult,
  type ConversationMessage,
  type ConversationSummary,
  type JsonObject,
  type JsonValue,
  type ProcContextState,
  type ProcHilRequest,
  type ProcHistoryRecord,
  type ProcHistoryRecordData,
  type ProcHistoryRecordsResult,
  type ProcListEntry,
  type ProcMessageMetadata,
  type SysLedgerLine,
  type SysTargetSummary,
  type SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const MOCK_FLAG = "gsv.ui.mock";
/** The session service's persisted token (sessionService.ts); seeding one is how the mock signs in without the form. */
const SESSION_TOKEN_KEY = "gsv.ui.session.token.v1";
const SEEDED_TOKEN_ID = "mock-session";

/** Without a browser and its storage (tests, for instance) there is no mock. */
export function mockGatewayRequested(): boolean {
  try {
    const asked = new URLSearchParams(window.location.search).get("mock");
    if (asked === "1") window.sessionStorage.setItem(MOCK_FLAG, "1");
    if (asked === "0") {
      window.sessionStorage.removeItem(MOCK_FLAG);
      forgetSeededSession();
    }
    return window.sessionStorage.getItem(MOCK_FLAG) === "1";
  } catch {
    return false;
  }
}

export function createMockGatewayClient(peer: GsvPeerInfo): GSVClient {
  try {
    if (!window.localStorage.getItem(SESSION_TOKEN_KEY)) {
      window.localStorage.setItem(SESSION_TOKEN_KEY, JSON.stringify({ username: "esteve", tokenId: SEEDED_TOKEN_ID, token: "mock-session-token", expiresAt: null }));
    }
  } catch {
    // Without storage the form still signs in.
  }
  return new GSVClient({ peer, WebSocket: MockSocket });
}

/** The real gateway would only reject the mock's token; drop it so leaving mock mode goes straight to the form. */
function forgetSeededSession(): void {
  const stored = window.localStorage.getItem(SESSION_TOKEN_KEY);
  if (stored && z.object({ tokenId: z.literal(SEEDED_TOKEN_ID) }).safeParse(JSON.parse(stored)).success) window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

/* ---------- fixtures ---------- */

const OWNER = { uid: 1000, username: "esteve", home: "/home/esteve" };
const SHIP = { pid: "p-ship", uid: 1001, username: "algo", home: "/home/algo" };
const HELPER = { pid: "p-helper", label: "tidy the notes archive" };
const SHIP_CONVERSATION = "c-ship";
const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", responseModel: "claude-sonnet-4-5-20250929" };

/** A wall-clock instant some days back, so the conversation always spans yesterday and today. */
function at(daysAgo: number, hour: number, minute: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

const LINES: [who: "you" | "ship", createdAt: number, text: string][] = [
  ["you", at(1, 9, 12), "Can you pull the notes from yesterday's call with Mara and put the action items somewhere I'll find them?"],
  ["ship", at(1, 9, 13), "Done. Three action items are in your notes under Mara: the deck for Thursday, the intro to Lena, and the follow-up on pricing. I set a reminder for the deck on Wednesday evening."],
  ["you", at(1, 18, 40), "What's still open from this week?"],
  ["ship", at(1, 18, 40), "Two things. The pricing follow-up with Mara, and the studio backup, which has failed since Monday because the drive is nearly full."],
  ["you", at(0, 8, 5), "Morning. Anything I should know before the standup?"],
  ["ship", at(0, 8, 6), "Nothing urgent. The studio backup ran clean overnight after I cleared the old build caches, and Lena replied about the intro; she is in. Standup is at 9:30."],
];

const SHORT_REPLY = "Done. The action items are in your notes under Mara, and the reminder is set for Wednesday evening.";
const ECHO_REPLY = "Noted. I will take care of it and let you know when it is done.";
const LONG_REPLY = [
  "Here is where things stand with the studio backup.",
  "The drive filled up because the build caches from the last three releases were never cleared; together they took about 140 GB. I removed the ones older than a week, which brought free space back to a third of the disk, and the overnight run completed in forty minutes.",
  "Two things would keep this from happening again. A weekly clean of caches older than fourteen days, which I can add as a routine, and a warning when free space drops under a tenth of the disk. Say the word and I will set both up.",
].join("\n\n");

const targets: SysTargetSummary[] = [
  { targetId: "studio", ownerUid: OWNER.uid, ownerUsername: OWNER.username, label: "studio", description: "MacBook Pro", implements: ["fs.*", "shell.*"], platform: "darwin", version: "0.6.0", online: true, lastSeenAt: Date.now() },
  { targetId: "garage-pi", ownerUid: OWNER.uid, ownerUsername: OWNER.username, label: "garage pi", description: "Raspberry Pi", implements: ["fs.*", "shell.*"], platform: "linux", version: "0.5.9", online: false, lastSeenAt: at(2, 22, 10) },
];

const accounts: AccountSummary[] = [
  { uid: OWNER.uid, username: OWNER.username, displayName: "Esteve", relation: "self", runnable: false },
  { uid: SHIP.uid, username: SHIP.username, displayName: "algo", relation: "personal-agent", runnable: true },
];

/* ---------- the scripted runs: what Ship does, step by step ---------- */

type Step = {
  /** What Ship says to itself before the call; shown folded under the receipt. Empty when it goes straight to the tool. */
  think: string;
  /** Hidden reasoning, a thinking block on the note record. */
  thought: string;
  place: "studio" | "gsv";
  tool: "Shell" | "Read" | "Write" | "Search" | "mail.send";
  syscall: "shell.exec" | "fs.read" | "fs.write" | "fs.search" | "mail.send";
  args: JsonObject;
  purpose?: string;
  /** How long the tool runs, before a little jitter. */
  ms: number;
  output: JsonValue;
  /** When set the call fails with this message; the output is what the tool reported. */
  failure?: string;
};

const NOTES = "# Backups\n\nStudio drive: /Volumes/Studio, 1.8 TB.\nNightly rsync to /Volumes/Backups at 02:00 (launchd).\nKeep 30 days; caches under Library/Caches/Builds are not backed up.\n\nFailing since Monday: drive at 95%, rsync exits before finishing.\n";

const DF = "Filesystem      Size   Used  Avail Capacity  Mounted on\n/dev/disk4s1   1.8Ti  1.7Ti   96Gi    95%    /Volumes/Studio";
const RSYNC_STATS = "Number of files: 48,211 (reg: 44,930, dir: 3,281)\nNumber of created files: 2,140\nNumber of regular files transferred: 2,140\nTotal file size: 1,412,377,190,144 bytes\nTotal transferred file size: 38,116,482,048 bytes\n\nsent 2,893,114 bytes  received 12,406 bytes  1,163,808.00 bytes/sec\ntotal size is 1,412,377,190,144  speedup is 486,150.03 (DRY RUN)";
const RSYNC_MISSING = "rsync: [sender] link_stat \"/Volumes/Studio/Projects\" failed: No such file or directory (2)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]";

function shell(command: string, output: string, exitCode = 0): JsonValue {
  return { status: "completed", output, exitCode, ok: true, stdout: exitCode === 0 ? output : "", stderr: exitCode === 0 ? "" : output, pid: 40_000 + Math.floor(Math.random() * 999), command };
}

const RUN: Step[] = [
  { think: "The backup complaint mentions the drive; check how full it is first.", thought: "df on the studio volume tells me whether space is the problem before I read anything.", purpose: "check how much free space is left on the studio drive", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "df -h /Volumes/Studio", target: "studio" }, ms: 1600, output: shell("df -h /Volumes/Studio", DF) },
  { think: "Your notes describe the backup layout; read them before touching anything.", thought: "The notes say where the nightly sync writes and what is excluded.", purpose: "read your notes about the nightly backup", place: "gsv", tool: "Read", syscall: "fs.read", args: { path: "/home/esteve/notes/backups.md" }, ms: 1100, output: { ok: true, path: "/home/esteve/notes/backups.md", kind: "text", contentType: "text/markdown", lines: 8, size: NOTES.length, content: NOTES } },
  { think: "A dry run of the sync shows what the next real run would move.", thought: "Dry-run with --stats to size the pending transfer without writing.", purpose: "estimate the next backup without copying any files", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "rsync -a --dry-run --stats /Volumes/Studio/Work/ /Volumes/Backups/Work/", target: "studio" }, ms: 3100, output: shell("rsync -a --dry-run --stats /Volumes/Studio/Work/ /Volumes/Backups/Work/", RSYNC_STATS) },
];
const RUN_REPLY = [
  "The studio drive is the problem: /Volumes/Studio is at 95%, with 96 GB free of 1.8 TB, which is why the nightly sync has been dying before it finishes.",
  "Your backup notes say the nightly rsync goes to /Volumes/Backups at 02:00 and keeps 30 days, with the build caches deliberately left out. A dry run of the sync shows 2,140 files waiting to move, about 38 GB, so the backup itself is healthy; it just has nowhere to breathe.",
  "The build caches under Library/Caches/Builds are the usual culprit and are not backed up anyway. I can clear the ones older than a week tonight, which should free well over 100 GB, and add a weekly clean so this does not come back. Say the word.",
].join("\n\n");

const RUN_LONG: Step[] = [
  RUN[0],
  { ...RUN[1], think: "" },
  { think: "See what the last backups looked like before deciding anything.", thought: "Newest first; the dates show when it stopped landing.", purpose: "check when the last successful backups finished", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "ls -lt /Volumes/Backups | head -5", target: "studio" }, ms: 1200, output: shell("ls -lt /Volumes/Backups | head -5", "total 0\ndrwxr-xr-x  14 esteve  staff  448 Sep 12 02:41 Work\ndrwxr-xr-x   9 esteve  staff  288 Sep 12 02:03 Photos\ndrwxr-xr-x   6 esteve  staff  192 Sep 11 02:12 Music\ndrwxr-xr-x   3 esteve  staff   96 Sep  9 02:00 Archive") },
  { think: "", thought: "Any other note about rsync exclusions.", purpose: "find your notes about backup exclusions", place: "gsv", tool: "Search", syscall: "fs.search", args: { query: "rsync", path: "/home/esteve/notes" }, ms: 1000, output: { ok: true, matches: [{ path: "/home/esteve/notes/backups.md", line: 4, content: "Nightly rsync to /Volumes/Backups at 02:00 (launchd)." }, { path: "/home/esteve/notes/backups.md", line: 7, content: "Failing since Monday: drive at 95%, rsync exits before finishing." }, { path: "/home/esteve/notes/studio-setup.md", line: 22, content: "rsync excludes: Library/Caches, node_modules, *.tmp" }], count: 3 } },
  { think: "Dry-run the sync to size what is pending.", thought: "Same flags as the nightly job.", purpose: "estimate the pending backup for your projects", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "rsync -a --dry-run --stats /Volumes/Studio/Projects/ /Volumes/Backups/Projects/", target: "studio" }, ms: 1300, output: shell("rsync -a --dry-run --stats /Volumes/Studio/Projects/ /Volumes/Backups/Projects/", RSYNC_MISSING, 23), failure: "shell.exec exited with code 23" },
  { think: "The projects live under Work, not Projects. Again with the right path.", thought: "The ls above showed Work; Projects was the old name.", purpose: "retry the backup estimate using the current Work folder", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "rsync -a --dry-run --stats /Volumes/Studio/Work/ /Volumes/Backups/Work/", target: "studio" }, ms: 3400, output: shell("rsync -a --dry-run --stats /Volumes/Studio/Work/ /Volumes/Backups/Work/", RSYNC_STATS) },
  { think: "", thought: "How much the caches take.", purpose: "measure how much space the build caches use", place: "studio", tool: "Shell", syscall: "shell.exec", args: { command: "du -sh /Volumes/Studio/Library/Caches/Builds", target: "studio" }, ms: 1500, output: shell("du -sh /Volumes/Studio/Library/Caches/Builds", "141G\t/Volumes/Studio/Library/Caches/Builds") },
  { think: "Note what I found so next time is faster.", thought: "Append today's numbers to the backup notes.", purpose: "save these findings in your backup notes", place: "gsv", tool: "Write", syscall: "fs.write", args: { path: "/home/esteve/notes/backups.md", content: `${NOTES}\n## 16 Sep\n\nDrive 95% (96 GB free). Pending sync 2,140 files / 38 GB. Build caches 141 GB, not backed up.\n` }, ms: 800, output: { ok: true, path: "/home/esteve/notes/backups.md", size: 812 } },
  { think: "", thought: "Whether a routine already covers cache cleaning.", purpose: "check whether you already have a cache-cleaning routine", place: "gsv", tool: "Read", syscall: "fs.read", args: { path: "/home/esteve/notes/routines.md" }, ms: 900, output: { ok: true, path: "/home/esteve/notes/routines.md", kind: "text", contentType: "text/markdown", lines: 5, size: 188, content: "# Routines\n\n- Monday 08:00: week plan\n- Daily 02:00: studio backup (launchd on studio)\n- Friday 17:00: inbox sweep\n" } },
];
const RUN_LONG_REPLY = [
  "The backup is failing for a simple reason: /Volumes/Studio is at 95%, with 96 GB free, and the build caches alone take 141 GB that the backup never copies.",
  "The nightly sync itself is fine. The last complete runs landed on the 12th, the exclusions in your notes still match the job, and a dry run of Work shows 2,140 files, about 38 GB, waiting to move. My first dry run pointed at the old Projects path and failed; Work is the current name, and I have written today's numbers into backups.md.",
  "There is no routine for cache cleaning yet. I can clear caches older than a week tonight and add a weekly clean next to the backup entry, which should keep the drive under 80%. Say the word.",
].join("\n\n");

const GRANOLA_COMMAND = "pgrep -fl Granola 2>/dev/null; echo \"---\"; osascript -e 'tell application \"System Events\" to tell process \"Granola\" to get name of every window' 2>&1 | head -5";

function approvalFor(trigger: string): ApprovalScenario | null {
  if (trigger === "/approve" || trigger === "/approve-old") {
    return {
      step: {
        think: "", thought: "Ask before inspecting the windows on your Mac.", place: "studio", tool: "Shell", syscall: "shell.exec",
        args: { input: GRANOLA_COMMAND, target: "studio" },
        ...(trigger === "/approve" ? { purpose: "check whether Granola is running and list its windows" } : {}),
        ms: 900, output: shell(GRANOLA_COMMAND, '48213 Granola\n---\nWeekly sync, Untitled note'),
      },
      approved: 'Granola is running (pid 48213) with two windows open: "Weekly sync" and "Untitled note".',
      denied: "Okay, I left Granola alone.",
    };
  }
  if (trigger === "/approve-mail") {
    return {
      step: {
        think: "", thought: "Ask before sending the follow-up.", place: "gsv", tool: "mail.send", syscall: "mail.send",
        purpose: "email Mike to follow up on the contract",
        args: { to: "mike@example.com", subject: "Contract follow-up", text: "Hi Mike, checking in on the contract we discussed. Let me know if you need anything from me." },
        ms: 900, output: { ok: true, messageId: "mock-mail-1" },
      },
      approved: "Sent Mike the contract follow-up.", denied: "Not sent. The draft is still here if you want to change it.",
    };
  }
  if (trigger === "/approve-file") {
    const path = "/Users/esteve/Notes/granola-windows.md";
    const content = "# Granola windows\n\n- Weekly sync\n- Untitled note\n";
    return {
      step: {
        think: "", thought: "Ask before saving the window list.", place: "studio", tool: "Write", syscall: "fs.write",
        purpose: "save the Granola window list in your notes", args: { path, content, target: "studio" },
        ms: 700, output: { ok: true, path, size: content.length },
      },
      approved: "Saved the window list in your Notes folder.", denied: "Okay, I left your notes unchanged.",
    };
  }
  return null;
}

/* ---------- the world the fixtures live in ---------- */

type OpenStep = { step: Step; callId: string; executionId: string; startedAt: number; seq: number };
type ApprovalScenario = { step: Step; approved: string; denied: string };
type PendingApproval = ApprovalScenario & { request: ProcHilRequest };
type OpenRun = { runId: string; question: ConversationMessage; open: OpenStep | null; approval: PendingApproval | null; superseded: boolean };
type Revised = { revision: number; record: ProcHistoryRecord };
type World = {
  messages: ConversationMessage[]; sequence: number;
  records: Revised[]; revision: number; messageId: number; recordId: number;
  ledger: SysLedgerLine[];
  /** The last context the Process announced and its monotonic revision; history reads return it, as the gateway's do. */
  context: ProcContextState | null; contextRevision: number;
  run: OpenRun | null; connections: number; sockets: Set<MockSocket>;
};
const world: World = { messages: [], sequence: 0, records: [], revision: 1, messageId: 0, recordId: 0, ledger: [], context: null, contextRevision: 0, run: null, connections: 0, sockets: new Set() };
let streamSeq = 0;

function record(who: "you" | "ship", text: string, createdAt: number, runId: string): ConversationMessage {
  const sequence = ++world.sequence;
  const message: ConversationMessage = {
    id: `m-${sequence}`,
    conversationId: SHIP_CONVERSATION,
    sequence,
    author: who === "you" ? { kind: "user", uid: OWNER.uid } : { kind: "process", pid: SHIP.pid, uid: SHIP.uid },
    text,
    origin: who === "you" ? { kind: "client", clientId: "gsv-ui", platform: "browser" } : { kind: "process", pid: SHIP.pid, runId },
    ...(who === "ship" ? { processId: SHIP.pid, runId } : undefined),
    createdAt,
  };
  world.messages.push(message);
  return message;
}
for (const [who, createdAt, text] of LINES) record(who, text, createdAt, `run-${world.sequence + 1}`);

/** One history group: the records share a messageId and land in one revision, the way a Process appends them. */
function appendGroup(runId: string, data: ProcHistoryRecordData[], metadata?: ProcMessageMetadata): number {
  const messageId = ++world.messageId;
  const revision = ++world.revision;
  const createdAt = Date.now();
  data.forEach((entry, index) => {
    const base = { id: ++world.recordId, messageId, index, generation: 1, runId, createdAt, source: "typed" as const, ...(metadata ? { metadata } : undefined) };
    world.records.push({ revision, record: { ...base, ...entry } });
  });
  return messageId;
}

function processes(): ProcListEntry[] {
  return [
    { pid: SHIP.pid, uid: OWNER.uid, username: SHIP.username, interactive: true, personal: true, parentPid: null, state: world.run ? (world.run.approval ? "waiting_hil" : world.run.open ? "waiting_tool" : "running") : "idle", activeRunId: world.run?.runId ?? null, queuedCount: 0, lastActiveAt: world.messages.at(-1)?.createdAt ?? null, label: "ship", createdAt: at(6, 10, 0), cwd: SHIP.home },
    { pid: HELPER.pid, uid: OWNER.uid, username: SHIP.username, interactive: false, personal: false, parentPid: SHIP.pid, state: "running", activeRunId: "run-helper", queuedCount: 0, lastActiveAt: Date.now() - 40_000, label: HELPER.label, createdAt: at(0, 7, 58), cwd: SHIP.home },
  ];
}

function conversation(pid: string): ConversationSummary {
  const ship = pid === SHIP.pid;
  return { id: ship ? SHIP_CONVERSATION : `c-${pid}`, kind: "ship", ownerUid: OWNER.uid, title: ship ? null : HELPER.label, handlerPid: pid, latestSequence: ship ? world.sequence : 0, createdAt: at(6, 10, 0), updatedAt: Date.now() };
}

/** A tail snapshot, or the groups changed since a cursor; either way the head cursor is the current revision. */
function history(pid: string, since: string | undefined): ProcHistoryRecordsResult {
  const from = since ? Number(/^mock:(\d+)$/.exec(since)?.[1] ?? 0) : 0;
  const records = pid === SHIP.pid ? world.records.filter((entry) => entry.revision > from).map((entry) => entry.record) : [];
  return {
    ok: true, pid, format: 2, records, messages: [], messageCount: pid === SHIP.pid ? world.messageId : 0,
    hasMoreBefore: false, hasMoreAfter: false, activeRunId: pid === SHIP.pid ? world.run?.runId ?? null : null,
    pendingHil: pid === SHIP.pid ? world.run?.approval?.request ?? null : null, context: pid === SHIP.pid ? world.context : null, contextRevision: world.context?.revision ?? 0,
    historyRevision: world.revision, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false, cursor: `mock:${world.revision}`,
  };
}

function connectResult(protocol: number): ConnectResult {
  const connection = `mock-${++world.connections}`;
  return {
    protocol,
    server: { version: "0.6.0", release: "mock", connectionId: connection },
    peer: {
      id: "gsv-ui", sessionId: connection,
      principal: { kind: "human", account: { uid: OWNER.uid, gid: OWNER.uid, gids: [OWNER.uid], username: OWNER.username, home: OWNER.home, cwd: OWNER.home } },
      grant: { calls: ["*"], signals: ["*"], implements: [] },
    },
  };
}

/* ---------- the signals, in the gateway's order ---------- */

function broadcast<T>(signal: string, payload: T): void {
  for (const socket of world.sockets) socket.deliver({ type: "sig", signal, payload });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

/** Realistic timing: the given duration, give or take a fifth. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

type ShipRuntime = { state: "running" | "waiting_tool" | "waiting_hil" | "idle"; activeRunId: string | null; queuedCount: number; lastActiveAt: number };
/** The Kernel's registry patch, as notifyProcessChanged sends it: no history fields, so only process lists move. */
function announce(state: ShipRuntime["state"], runId: string | null): void {
  const runtime: ShipRuntime = { state, activeRunId: runId, queuedCount: 0, lastActiveAt: Date.now() };
  broadcast("proc.changed", { pid: SHIP.pid, changes: ["state"], runtime });
}

/** The Process's own proc.changed, which always carries the history revision so clients read the delta. */
function changed(changes: string[], payload: JsonObject): void {
  broadcast("proc.changed", { pid: SHIP.pid, changes, queuedCount: 0, timestamp: Date.now(), ...payload, historyRevision: world.revision, historyGeneration: 1, historyResetRevision: 0 });
}

function contextState(run: OpenRun): ProcContextState {
  const inputTokens = 14_200 + world.messageId * 310;
  world.context = {
    revision: ++world.contextRevision, runId: run.runId, messageCount: world.messageId, lastMessageId: world.messageId,
    provider: MODEL.provider, model: MODEL.model, reasoning: "medium",
    contextWindowTokens: 200_000, maxOutputTokens: 8_192,
    estimatedInputTokens: inputTokens, inputTokens, confirmedInputTokens: inputTokens,
    estimatedTrailingInputTokens: 0, inputBudgetTokens: 200_000 - 8_192, remainingInputTokens: 200_000 - 8_192 - inputTokens,
    availableInputTokens: 200_000 - inputTokens, pressure: inputTokens / 200_000, level: "ok", source: "estimate", updatedAt: Date.now(),
  };
  return world.context;
}

type AssistantContent = AiTextContent | AiThinkingContent | AiToolCall;
type Partial = { role: "assistant"; content: AssistantContent[]; stopReason: "pending" };
function partial(content: AssistantContent[]): Partial {
  return { role: "assistant", content, stopReason: "pending" };
}

function stream(run: OpenRun, event: JsonObject): void {
  broadcast("proc.run.stream", { pid: SHIP.pid, runId: run.runId, seq: ++streamSeq, event, timestamp: Date.now() });
}

function live(run: OpenRun): boolean {
  return world.run === run && !run.superseded;
}

function startRun(question: ConversationMessage): OpenRun {
  const run: OpenRun = { runId: `run-${question.sequence}`, question, open: null, approval: null, superseded: false };
  world.run = run;
  announce("running", run.runId);
  broadcast("proc.run.started", { pid: SHIP.pid, runId: run.runId, reason: "message", queuedCount: 0, timestamp: Date.now() });
  appendGroup(run.runId, [{ kind: "message", payload: { direction: "in", text: question.text, media: [], origin: { kind: "conversation", provenance: { source: "conversation" } }, conversationId: SHIP_CONVERSATION, conversationMessageId: question.id } }]);
  changed(["context"], { context: contextState(run) });
  return run;
}

const thinkingBlock = z.object({ thinking: z.string() });
const textBlock = z.object({ text: z.string() });

/** One generation tick that ends in a tool call: the model streams, its output is announced, the note and call are recorded. */
async function think(run: OpenRun, step: Step, callId: string): Promise<void> {
  const call: AiToolCall = { type: "toolCall", id: callId, name: step.tool, arguments: { ...(step.purpose ? { purpose: step.purpose } : {}), ...step.args } };
  const content: AssistantContent[] = [{ type: "thinking", thinking: "" }];
  stream(run, { type: "thinking_start", contentIndex: 0, partial: partial(content) });
  for (const piece of step.thought.split(/(?<=[,.;] )/)) {
    await wait(jitter(140));
    if (!live(run)) return;
    content[0] = { type: "thinking", thinking: `${thinkingBlock.parse(content[0]).thinking}${piece}` };
    stream(run, { type: "thinking_delta", contentIndex: 0, delta: piece, partial: partial(content) });
  }
  stream(run, { type: "thinking_end", contentIndex: 0, content: step.thought, partial: partial(content) });
  if (step.think) {
    content.push({ type: "text", text: "" });
    stream(run, { type: "text_start", contentIndex: 1, partial: partial(content) });
    for (const piece of step.think.split(/(?<=\s)/)) {
      await wait(jitter(35));
      if (!live(run)) return;
      content[1] = { type: "text", text: `${textBlock.parse(content[1]).text}${piece}` };
      stream(run, { type: "text_delta", contentIndex: 1, delta: piece, partial: partial(content) });
    }
    stream(run, { type: "text_end", contentIndex: 1, content: step.think, partial: partial(content) });
  }
  const index = content.length;
  content.push({ type: "toolCall", id: callId, name: step.tool, arguments: {} });
  stream(run, { type: "toolcall_start", contentIndex: index, partial: partial(content) });
  await wait(jitter(260));
  if (!live(run)) return;
  content[index] = call;
  stream(run, { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: partial(content) });
  stream(run, { type: "toolcall_end", contentIndex: index, toolCall: call, partial: partial(content) });
  stream(run, { type: "done", reason: "toolUse", message: { ...partial(content), stopReason: "toolUse" } });
  if (step.think) broadcast("proc.run.output", { text: step.think, thinking: [step.thought], pid: SHIP.pid, runId: run.runId });
  appendGroup(run.runId, [
    { kind: "note", payload: { text: step.think, thinking: [{ type: "thinking", thinking: step.thought }] } },
    { kind: "call", payload: { callId, tool: step.tool, syscall: step.syscall, args: step.args, target: step.place, runId: run.runId, ...(step.purpose ? { purpose: step.purpose } : {}) } },
  ], { provider: MODEL });
  changed(["context"], { context: contextState(run) });
}

/** The Kernel's ledger row for a call: open at dispatch, then the same seq closed with its outcome. */
function ledgerLine(open: OpenStep, runId: string, outcome: SysLedgerLine["outcome"], error: string | null): SysLedgerLine {
  const existing = world.ledger.findIndex((line) => line.runId === runId && line.args === JSON.stringify(open.step.args) && line.outcome === null);
  const seq = existing >= 0 ? existing + 1 : world.ledger.length + 1;
  const line: SysLedgerLine = {
    seq, timestamp: open.startedAt, principalKind: "process", uid: SHIP.uid, pid: SHIP.pid, runId,
    target: open.step.place, call: open.step.syscall, args: JSON.stringify(open.step.args), outcome, error,
    purpose: open.step.purpose ?? null,
    durationMs: outcome === null ? null : Date.now() - open.startedAt, tokens: null, costNanoUsd: null,
  };
  world.ledger[seq - 1] = line;
  return line;
}

/** The tool starts: the Process announces it (no target; that is on the call record), the Kernel notes the wait, the ledger opens a row. */
function startTool(run: OpenRun, step: Step, callId: string): void {
  const open: OpenStep = { step, callId, executionId: `exec-${callId}`, startedAt: Date.now(), seq: 0 };
  run.open = open;
  broadcast("proc.run.tool.started", { name: step.tool, syscall: step.syscall, args: step.args, purpose: step.purpose, callId, executionId: open.executionId, pid: SHIP.pid, runId: run.runId });
  announce("waiting_tool", run.runId);
  broadcast("ledger.changed", { lines: [ledgerLine(open, run.runId, null, null)] });
}

/** The tool ends: the result is recorded, then announced, then the changed history is pointed at, and the ledger row closes. */
function finishTool(run: OpenRun, cancelled = false): void {
  const open = run.open;
  if (!open) return;
  run.open = null;
  const { step } = open;
  const outcome = cancelled ? "cancelled" : step.failure ? "failed" : "completed";
  const error = cancelled ? "Interrupted by user" : step.failure;
  appendGroup(run.runId, [{ kind: "result", payload: { callId: open.callId, tool: step.tool, outcome, output: cancelled ? null : step.output, media: [], resources: [], ...(error ? { error: { message: error } } : undefined) } }]);
  broadcast("proc.run.tool.finished", { pid: SHIP.pid, runId: run.runId, executionId: open.executionId, callId: open.callId, outcome, timestamp: Date.now() });
  changed(["messages"], { runId: run.runId, messageId: world.messageId });
  broadcast("ledger.changed", { lines: [ledgerLine(open, run.runId, cancelled ? "cancelled" : step.failure ? "failed" : "ok", error ?? null)] });
}

/** A whole step: think, run the tool for its time, record the result. */
async function play(run: OpenRun, step: Step): Promise<void> {
  const callId = `call-${run.runId}-${world.recordId + 1}`;
  await think(run, step, callId);
  if (!live(run)) return;
  startTool(run, step, callId);
  await wait(jitter(step.ms));
  if (!live(run)) return;
  finishTool(run);
  announce("running", run.runId);
  await wait(jitter(350));
}

async function askApproval(run: OpenRun, scenario: ApprovalScenario): Promise<void> {
  const callId = `call-${run.runId}-${world.recordId + 1}`;
  await think(run, scenario.step, callId);
  if (!live(run)) return;
  const step = scenario.step;
  const request: ProcHilRequest = {
    pid: SHIP.pid, requestId: `hil-${callId}`, runId: run.runId, conversationId: SHIP_CONVERSATION,
    callId, toolName: step.tool, syscall: step.syscall, target: step.place, args: step.args, createdAt: Date.now(),
    ...(step.purpose ? { purpose: step.purpose } : {}),
  };
  run.approval = { ...scenario, request };
  announce("waiting_hil", run.runId);
  changed(["hil"], { runId: run.runId, pendingHil: request });
  broadcast("proc.run.hil.requested", request);
}

/** A denied or interrupted approval records an outcome without dispatching the call. */
function declineApproval(run: OpenRun, approval: PendingApproval, outcome: "denied" | "cancelled"): void {
  const message = outcome === "denied" ? "Denied by user" : "Interrupted by user";
  appendGroup(run.runId, [{ kind: "result", payload: {
    callId: approval.request.callId, tool: approval.step.tool, outcome, output: null,
    media: [], resources: [], error: { message },
  } }]);
  changed(["messages", "hil"], { runId: run.runId, pendingHil: null });
}

async function resumeApproval(run: OpenRun, approval: PendingApproval, decision: "approve" | "deny"): Promise<void> {
  if (!live(run)) return;
  if (decision === "approve") {
    startTool(run, approval.step, approval.request.callId);
    await wait(jitter(approval.step.ms));
    if (!live(run)) return;
    finishTool(run);
    announce("running", run.runId);
  } else {
    declineApproval(run, approval, "denied");
  }
  await send(run, decision === "approve" ? approval.approved : approval.denied, true);
}

function interrupt(run: OpenRun): void {
  run.superseded = true;
  if (run.approval) {
    const approval = run.approval;
    run.approval = null;
    declineApproval(run, approval, "cancelled");
  }
  finishTool(run, true);
  finishRun(run, null);
}

/** The reply is a Send: its text streams to the conversation while the tool call streams to observers; the commit records both. */
async function send(run: OpenRun, text: string, streamed: boolean): Promise<void> {
  const callId = `call-${run.runId}-send`;
  const content: AssistantContent[] = [{ type: "toolCall", id: callId, name: "Send", arguments: {} }];
  stream(run, { type: "toolcall_start", contentIndex: 0, partial: partial(content) });
  const started = { conversationId: SHIP_CONVERSATION, messageId: `draft-${run.runId}`, processId: SHIP.pid, runId: run.runId, timestamp: Date.now() };
  broadcast("message.started", started);
  if (streamed) {
    let written = "";
    for (const piece of text.split(/(?<=\s)/)) {
      await wait(jitter(45));
      if (!live(run)) return;
      written += piece;
      content[0] = { type: "toolCall", id: callId, name: "Send", arguments: { text: written } };
      stream(run, { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(piece), partial: partial(content) });
      broadcast("message.delta", { ...started, delta: piece });
    }
    await wait(200);
  } else {
    await wait(jitter(500));
    if (!live(run)) return;
    broadcast("message.delta", { ...started, delta: text });
  }
  if (!live(run)) return;
  const call: AiToolCall = { type: "toolCall", id: callId, name: "Send", arguments: { text } };
  content[0] = call;
  stream(run, { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: partial(content) });
  stream(run, { type: "done", reason: "toolUse", message: { ...partial(content), stopReason: "toolUse" } });
  appendGroup(run.runId, [
    { kind: "note", payload: { text: "", thinking: [{ type: "thinking", thinking: "I have what I need; tell them plainly." }] } },
    { kind: "call", payload: { callId, tool: "Send", syscall: null, args: { text }, target: null, runId: run.runId } },
  ], { provider: MODEL });
  const message = record("ship", text, Date.now(), run.runId);
  broadcast("message.committed", { message, directed: true });
  appendGroup(run.runId, [
    { kind: "message", payload: { direction: "out", text, media: [], origin: { kind: "run-control", provenance: { source: "process" } }, conversationId: SHIP_CONVERSATION, conversationMessageId: message.id, deliveryId: `send-${run.runId}` } },
    { kind: "result", payload: { callId, tool: "Send", outcome: "completed", output: { ok: true, action: "message", delivered: true }, media: [], resources: [] } },
  ]);
  finishRun(run, text);
}

function finishRun(run: OpenRun, text: string | null): void {
  if (world.run === run) world.run = null;
  broadcast("proc.run.finished", { pid: SHIP.pid, runId: run.runId, status: "ok", result: { text }, delivery: { kind: "none" }, queuedCount: 0, timestamp: Date.now(), reason: "yield" });
  changed(["messages"], { runId: run.runId, messageId: world.messageId });
  announce("idle", null);
}

async function answer(run: OpenRun, trigger: string): Promise<void> {
  await wait(0);
  if (!live(run)) return;
  const approval = approvalFor(trigger);
  if (approval) {
    await askApproval(run, approval);
    return;
  }
  if (trigger === "/think") {
    const callId = `call-${run.runId}-${world.recordId + 1}`;
    await think(run, RUN[0], callId);
    if (live(run)) startTool(run, RUN[0], callId);
    return; // held until /reply or /stream
  }
  if (trigger === "/run" || trigger === "/run-long" || trigger === "/run-old") {
    const steps = trigger === "/run-long" ? RUN_LONG : trigger === "/run-old" ? RUN.map((step) => ({ ...step, purpose: undefined })) : RUN;
    for (const step of steps) {
      if (!live(run)) return;
      await play(run, step);
    }
    if (live(run)) await send(run, trigger === "/run-long" ? RUN_LONG_REPLY : RUN_REPLY, true);
    return;
  }
  await wait(jitter(trigger === "/stream" || trigger === "/reply" ? 600 : 1000));
  if (!live(run)) return;
  await send(run, trigger === "/stream" ? LONG_REPLY : trigger === "/reply" ? SHORT_REPLY : ECHO_REPLY, trigger === "/stream");
}

/** A control trigger while a run is open: the open step finishes and the run replies under the question that opened it. */
async function resolve(run: OpenRun, trigger: string): Promise<void> {
  await wait(0);
  if (!live(run)) return;
  finishTool(run);
  await send(run, trigger === "/stream" ? LONG_REPLY : SHORT_REPLY, trigger === "/stream");
}

type Sent = { message: ConversationMessage; runId: string };

function receive(text: string): Sent {
  const trigger = text.trim().toLowerCase();
  const open = world.run;
  if (open && !open.approval && (trigger === "/reply" || trigger === "/stream")) {
    // The script stops at its next check; a continuation of the same run answers instead.
    const tail: OpenRun = { ...open, superseded: false };
    open.superseded = true;
    world.run = tail;
    void resolve(tail, trigger);
    return { message: open.question, runId: open.runId };
  }
  if (open) {
    // A new message while Ship is busy: the open run yields without a word, then the new one starts.
    interrupt(open);
  }
  const question = record("you", text, Date.now(), "");
  const runId = `run-${question.sequence}`;
  window.setTimeout(() => {
    broadcast("message.committed", { message: question, directed: true });
    void answer(startRun(question), trigger);
  }, 0);
  return { message: question, runId };
}

/* ---------- the wire ---------- */

const pidArgs = z.object({ pid: z.string() });
const historyArgs = z.object({ pid: z.string(), since: z.string().optional() });
const conversationArgs = z.object({ conversationId: z.string() });
const sendArgs = z.object({ conversationId: z.string(), text: z.string() });
const connectArgs = z.object({ protocol: z.number() });
const tokenArgs = z.object({ expiresAt: z.number().nullable().optional() });
const hilArgs = z.object({ pid: z.string().optional(), requestId: z.string(), decision: z.enum(["approve", "deny"]) });
const abortArgs = z.object({ pid: z.string().optional() });

function respond<T>(id: string, data: T): string {
  return JSON.stringify({ type: "res", id, ok: true, data });
}

function refuse(id: string, code: number, message: string): string {
  return JSON.stringify({ type: "res", id, ok: false, error: { code, message } });
}

function route(socket: MockSocket, id: string, call: string, args: JsonValue): string {
  switch (call) {
    case "sys.connect":
      world.sockets.add(socket);
      return respond(id, connectResult(connectArgs.safeParse(args).data?.protocol ?? 4));
    case "sys.token.create": {
      const token: SysTokenCreateResult = { token: { tokenId: SEEDED_TOKEN_ID, token: "mock-session-token", tokenPrefix: "mock", uid: OWNER.uid, kind: "human", label: "gsv-ui-session", peerId: null, createdAt: Date.now(), expiresAt: tokenArgs.parse(args).expiresAt ?? null } };
      return respond(id, token);
    }
    case "sys.token.revoke": return respond(id, { revoked: true });
    case "sys.token.list": return respond(id, { tokens: [] });
    case "sys.config.get": return respond(id, { entries: [] });
    case "account.list": return respond(id, { accounts });
    case "sys.target.list": return respond(id, { targets });
    case "sys.ledger.list": return respond(id, { lines: [...world.ledger].reverse(), nextCursor: null });
    case "proc.list": return respond(id, { processes: processes() });
    case "proc.observe":
    case "proc.unobserve": return respond(id, { ok: true, pid: pidArgs.parse(args).pid, observing: call === "proc.observe" });
    case "proc.history": {
      const { pid, since } = historyArgs.parse(args);
      return respond(id, history(pid, since));
    }
    case "proc.hil": {
      const { pid = SHIP.pid, requestId, decision } = hilArgs.parse(args);
      const run = world.run;
      const approval = run?.approval;
      if (pid !== SHIP.pid || !run || !approval || approval.request.requestId !== requestId) {
        return respond(id, { ok: false, error: "That approval is no longer pending." });
      }
      run.approval = null;
      announce("running", run.runId);
      changed(["hil"], { runId: run.runId, pendingHil: null });
      void resumeApproval(run, approval, decision);
      return respond(id, { ok: true, pid, requestId, decision, resumed: true, pendingHil: null });
    }
    case "proc.abort": {
      const { pid = SHIP.pid } = abortArgs.parse(args);
      if (pid !== SHIP.pid) return respond(id, { ok: false, error: "Only Ship runs are scripted in this mock." });
      const run = world.run;
      if (run) interrupt(run);
      return respond(id, { ok: true, pid, aborted: run !== null, ...(run ? { runId: run.runId } : {}) });
    }
    case "conversation.forProcess": return respond(id, { conversation: conversation(pidArgs.parse(args).pid) });
    case "conversation.history": {
      const ship = conversationArgs.parse(args).conversationId === SHIP_CONVERSATION;
      return respond(id, { conversation: conversation(ship ? SHIP.pid : HELPER.pid), messages: ship ? world.messages : [], hasMore: false });
    }
    case "conversation.send": {
      const sent = receive(sendArgs.parse(args).text);
      return respond(id, { message: sent.message, handlerPid: SHIP.pid, runId: sent.runId });
    }
    case "contact.list": return respond(id, { contacts: [] });
    case "contact.invite.list": return respond(id, { invites: [] });
    case "contact.request.list": return respond(id, { requests: [] });
    case "sys.link.list": return respond(id, { links: [] });
    case "r12y.list": return respond(id, { responsibilities: [], count: 0, revision: 0 });
    case "r12y.source.list": return respond(id, { sources: [] });
    case "sched.list": return respond(id, { schedules: [], count: 0 });
    case "sys.mcp.list": return respond(id, { servers: [] });
    case "repo.list": return respond(id, { repos: [] });
    default: return refuse(id, 501, `The mock gateway does not implement ${call}.`);
  }
}

/** The WebSocket the client thinks it opened; the other end is this module. */
class MockSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  /** A frame from the gateway's side of the wire. */
  deliver<T>(frame: T): void {
    this.deliverText(JSON.stringify(frame));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const text = z.string().safeParse(data);
    if (!text.success) return; // bodies are not carried here
    const frame = wireFrameSchemas.request.safeParse(JSON.parse(text.data));
    if (!frame.success) return; // cancels and other signals need no answer
    const { id, call, args } = frame.data;
    let reply: string;
    try {
      reply = route(this, id, call, args);
    } catch (error) {
      reply = refuse(id, 400, error instanceof Error ? error.message : "Bad request");
    }
    queueMicrotask(() => this.deliverText(reply));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    world.sockets.delete(this);
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  private deliverText(data: string): void {
    if (this.readyState !== this.OPEN) return;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
