/**
 * A gateway that lives in this tab, so Zen's states can be looked at on demand.
 *
 * Development only. GatewayProvider installs it when the page runs on the Vite dev server with
 * `?mock=1` (http://localhost:5180/?mock=1); production builds drop this module. Any username and
 * password sign in. The real GSVClient runs unchanged over an in-memory WebSocket, so the frames,
 * statuses and signals are the ones the wire would carry. Fixtures are the plain objects below.
 *
 * Typed into the prompt:
 *   /think    Ship starts working with a tool and has no words yet; held until /reply or /stream
 *   /stream   a multi-paragraph answer streams in, word by word
 *   /reply    a plain reply is committed, finishing an open /think first
 *   anything else is committed as your message and answered briefly a second later
 */
import { GSVClient, type GsvPeerInfo } from "@humansandmachines/gsv/client";
import {
  wireFrameSchemas,
  type AccountSummary,
  type ConnectResult,
  type ConversationMessage,
  type ConversationSummary,
  type JsonValue,
  type ProcHistoryRecordsResult,
  type ProcListEntry,
  type SysTargetSummary,
  type SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export function mockGatewayRequested(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

export function createMockGatewayClient(peer: GsvPeerInfo): GSVClient {
  return new GSVClient({ peer, WebSocket: MockSocket });
}

/* ---------- fixtures ---------- */

const OWNER = { uid: 1000, username: "esteve", home: "/home/esteve" };
const SHIP = { pid: "p-ship", uid: 1001, username: "algo", home: "/home/algo" };
const HELPER = { pid: "p-helper", label: "tidy the notes archive" };
const SHIP_CONVERSATION = "c-ship";

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

/* ---------- the world the fixtures live in ---------- */

type OpenRun = { runId: string; question: ConversationMessage; tool: { callId: string; executionId: string } | null };
type World = { messages: ConversationMessage[]; sequence: number; run: OpenRun | null; connections: number; sockets: Set<MockSocket> };
const world: World = { messages: [], sequence: 0, run: null, connections: 0, sockets: new Set() };

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

function processes(): ProcListEntry[] {
  return [
    { pid: SHIP.pid, uid: OWNER.uid, username: SHIP.username, interactive: true, personal: true, parentPid: null, state: world.run ? "running" : "idle", activeRunId: world.run?.runId ?? null, queuedCount: 0, lastActiveAt: world.messages.at(-1)?.createdAt ?? null, label: "ship", createdAt: at(6, 10, 0), cwd: SHIP.home },
    { pid: HELPER.pid, uid: OWNER.uid, username: SHIP.username, interactive: false, personal: false, parentPid: SHIP.pid, state: "running", activeRunId: "run-helper", queuedCount: 0, lastActiveAt: Date.now() - 40_000, label: HELPER.label, createdAt: at(0, 7, 58), cwd: SHIP.home },
  ];
}

function conversation(pid: string): ConversationSummary {
  const ship = pid === SHIP.pid;
  return { id: ship ? SHIP_CONVERSATION : `c-${pid}`, kind: "ship", ownerUid: OWNER.uid, title: ship ? null : HELPER.label, handlerPid: pid, latestSequence: ship ? world.sequence : 0, createdAt: at(6, 10, 0), updatedAt: Date.now() };
}

function history(pid: string): ProcHistoryRecordsResult {
  const runId = pid === SHIP.pid ? world.run?.runId ?? null : null;
  return { ok: true, pid, format: 2, records: [], messages: [], messageCount: 0, hasMoreBefore: false, hasMoreAfter: false, activeRunId: runId, pendingHil: null, context: null, contextRevision: 0, historyRevision: 1, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false, cursor: "mock:1" };
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

/* ---------- what Ship does when spoken to ---------- */

function broadcast<T>(signal: string, payload: T): void {
  for (const socket of world.sockets) socket.deliver({ type: "sig", signal, payload });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

type ShipRuntime = { state: "running" | "idle"; activeRunId: string | null; queuedCount: number; lastActiveAt: number };
function announce(state: ShipRuntime["state"], runId: string | null): void {
  const runtime: ShipRuntime = { state, activeRunId: runId, queuedCount: 0, lastActiveAt: Date.now() };
  broadcast("proc.changed", { pid: SHIP.pid, changes: ["state"], runtime });
}

function startRun(question: ConversationMessage): OpenRun {
  const run: OpenRun = { runId: `run-${question.sequence}`, question, tool: null };
  world.run = run;
  announce("running", run.runId);
  broadcast("proc.run.started", { pid: SHIP.pid, runId: run.runId, timestamp: Date.now() });
  return run;
}

function startTool(run: OpenRun): void {
  run.tool = { callId: `call-${run.runId}`, executionId: `exec-${run.runId}` };
  broadcast("proc.run.tool.started", { pid: SHIP.pid, runId: run.runId, ...run.tool, name: "Shell", syscall: "shell.exec", target: "gsv", args: { command: "ls ~/notes/mara" } });
}

function finishTool(run: OpenRun): void {
  if (!run.tool) return;
  broadcast("proc.run.tool.finished", { pid: SHIP.pid, runId: run.runId, ...run.tool, outcome: "completed", timestamp: Date.now() });
  run.tool = null;
}

function commitReply(run: OpenRun, text: string): void {
  broadcast("message.committed", { message: record("ship", text, Date.now(), run.runId), directed: true });
}

function finishRun(run: OpenRun): void {
  if (world.run === run) world.run = null;
  broadcast("proc.run.finished", { pid: SHIP.pid, runId: run.runId, queuedCount: 0, timestamp: Date.now() });
  announce("idle", null);
}

async function stream(run: OpenRun, text: string): Promise<void> {
  const started = { conversationId: SHIP_CONVERSATION, messageId: `draft-${run.runId}`, processId: SHIP.pid, runId: run.runId, timestamp: Date.now() };
  broadcast("message.started", started);
  for (const word of text.split(/(?<=\s)/)) {
    await wait(45);
    if (world.run !== run) return;
    broadcast("message.delta", { ...started, delta: word });
  }
  await wait(200);
  commitReply(run, text);
}

async function answer(run: OpenRun, trigger: string): Promise<void> {
  await wait(0);
  if (trigger === "/think") {
    await wait(300);
    startTool(run);
    return;
  }
  if (trigger === "/stream") {
    await wait(600);
    await stream(run, LONG_REPLY);
  } else {
    await wait(trigger === "/reply" ? 600 : 1000);
    commitReply(run, trigger === "/reply" ? SHORT_REPLY : ECHO_REPLY);
  }
  finishRun(run);
}

async function resolve(run: OpenRun, trigger: string): Promise<void> {
  await wait(0);
  finishTool(run);
  if (trigger === "/stream") await stream(run, LONG_REPLY);
  else commitReply(run, SHORT_REPLY);
  finishRun(run);
}

type Sent = { message: ConversationMessage; runId: string };

/** A message from the prompt: a control trigger resolves an open run under the question that opened it; anything else asks anew. */
function send(text: string): Sent {
  const trigger = text.trim().toLowerCase();
  const open = world.run;
  if (open && (trigger === "/reply" || trigger === "/stream")) {
    void resolve(open, trigger);
    return { message: open.question, runId: open.runId };
  }
  if (open) void resolve(open, "/reply");
  const question = record("you", text, Date.now(), "");
  const run: OpenRun = { runId: `run-${question.sequence}`, question, tool: null };
  window.setTimeout(() => {
    broadcast("message.committed", { message: question, directed: true });
    void answer(startRun(question), trigger);
  }, 0);
  return { message: question, runId: run.runId };
}

/* ---------- the wire ---------- */

const pidArgs = z.object({ pid: z.string() });
const conversationArgs = z.object({ conversationId: z.string() });
const sendArgs = z.object({ conversationId: z.string(), text: z.string() });
const connectArgs = z.object({ protocol: z.number() });
const tokenArgs = z.object({ expiresAt: z.number().nullable().optional() });

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
      const token: SysTokenCreateResult = { token: { tokenId: "mock-session", token: "mock-session-token", tokenPrefix: "mock", uid: OWNER.uid, kind: "human", label: "gsv-ui-session", peerId: null, createdAt: Date.now(), expiresAt: tokenArgs.parse(args).expiresAt ?? null } };
      return respond(id, token);
    }
    case "sys.token.revoke": return respond(id, { revoked: true });
    case "sys.token.list": return respond(id, { tokens: [] });
    case "sys.config.get": return respond(id, { entries: [] });
    case "account.list": return respond(id, { accounts });
    case "sys.target.list": return respond(id, { targets });
    case "proc.list": return respond(id, { processes: processes() });
    case "proc.observe":
    case "proc.unobserve": return respond(id, { ok: true, pid: pidArgs.parse(args).pid, observing: call === "proc.observe" });
    case "proc.history": return respond(id, history(pidArgs.parse(args).pid));
    case "conversation.forProcess": return respond(id, { conversation: conversation(pidArgs.parse(args).pid) });
    case "conversation.history": {
      const ship = conversationArgs.parse(args).conversationId === SHIP_CONVERSATION;
      return respond(id, { conversation: conversation(ship ? SHIP.pid : HELPER.pid), messages: ship ? world.messages : [], hasMore: false });
    }
    case "conversation.send": {
      const sent = send(sendArgs.parse(args).text);
      return respond(id, { message: sent.message, handlerPid: SHIP.pid, runId: sent.runId });
    }
    case "contact.list": return respond(id, { contacts: [] });
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
    if (this.readyState !== this.OPEN) return;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
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
