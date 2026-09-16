/**
 * Dev-only in-memory gateway, so Instrument states can be tried without a real space.
 *
 * Open http://localhost:5181/?mock=1 while `npx vite` runs. The switch sticks to the tab
 * (sessionStorage) because Instrument rewrites the path on navigation; `?mock=0` turns it off.
 * The import site is gated by `import.meta.env.DEV`, so none of this reaches a production bundle.
 *
 * Type into the prompt to drive states:
 *   /approve        Ship asks before a shell.exec on my-mac, with a reason
 *   /approve-old    the same request without a reason, so the fallback sentence shows
 *   /approve-mail   a mail.send approval with recipient, subject and a reason
 *   /approve-file   an fs.write approval on my-mac with a reason
 *   y / n            (or the card's buttons) answer the pending approval; Ship replies in one line
 *   anything else   Ship replies in one line
 *
 * Fixtures are plain objects below. Keep the scaffold obvious: a sibling worktree adds
 * thinking/streaming triggers to a file of this name and the two are merged by hand.
 */
import {
  GSVClient,
  type GsvClientStatus,
  type GsvConnectOptions,
  type GsvRequestArguments,
  type GsvRequestOptions,
  type GsvResponse,
} from "@humansandmachines/gsv/client";
import type { ArgsOf, ConnectResult, JsonObject, JsonValue, ResultOf, SyscallName } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const MOCK_FLAG = "gsv.dev.mock";
const SESSION_TOKEN_KEY = "gsv.ui.session.token.v1";

const PERSON = "jessicat";
const OWNER_UID = 1000;
const SHIP_PID = "ship";
const SHIP_UID = 1001;
const CONVERSATION_ID = "canonical-ship";
const MAC = "my-mac";
const GRANOLA_COMMAND = "pgrep -fl Granola 2>/dev/null; echo \"---\"; osascript -e 'tell application \"System Events\" to tell process \"Granola\" to get name of every window' 2>&1 | head -5";

const SHIP_AUTHOR: JsonObject = { kind: "process", pid: SHIP_PID, uid: SHIP_UID };
const PERSON_AUTHOR: JsonObject = { kind: "user", uid: OWNER_UID };

const ACCOUNTS: JsonObject[] = [
  { uid: OWNER_UID, username: PERSON, displayName: "Jessica T.", relation: "self", runnable: true, capabilities: [] },
  { uid: SHIP_UID, username: "ship", displayName: "Ship", relation: "personal-agent", runnable: true, capabilities: [] },
];

const MAC_TARGET: JsonObject = {
  targetId: MAC, ownerUid: OWNER_UID, ownerUsername: PERSON, label: MAC, description: "MacBook Pro",
  implements: ["shell.exec", "fs.read", "fs.write", "fs.edit", "fs.delete", "fs.search"],
  platform: "darwin", version: "0.6.0", online: true, lastSeenAt: Date.now(),
};

const SEED_CONVERSATION: Array<[JsonObject, string]> = [
  [PERSON_AUTHOR, "What do I have tomorrow morning?"],
  [SHIP_AUTHOR, "Two things: standup at 9:30 and a call with Mike at 11. Nothing before 9."],
  [PERSON_AUTHOR, "Remind me to send Mike the contract follow-up after the call."],
  [SHIP_AUTHOR, "Will do. I'll nudge you at 11:45."],
];

type MockApproval = {
  request: JsonObject;
  approved: string;
  denied: string;
};

/** The gated call a trigger stages, before it becomes a wire-shaped approval request. */
type MockGatedCall = {
  toolName: string;
  syscall: string;
  target: string;
  args: JsonObject;
  reason?: string;
};

type SignalListener = (signal: string, payload: JsonValue | undefined) => void;

/** `?mock=1` turns the fake on for this tab and `?mock=0` off; the choice survives Instrument's path rewrites. */
export function mockGatewayRequested(): boolean {
  const browser = globalThis.window;
  if (!browser?.location) return false;
  const flag = new URLSearchParams(browser.location.search).get("mock");
  try {
    if (flag === "1") browser.sessionStorage.setItem(MOCK_FLAG, "1");
    if (flag === "0") browser.sessionStorage.removeItem(MOCK_FLAG);
    return browser.sessionStorage.getItem(MOCK_FLAG) === "1";
  } catch {
    return flag === "1";
  }
}

export function createMockGateway(): GSVClient {
  try {
    // A stored session token lets the session service connect straight away instead of asking for a login.
    globalThis.window.localStorage.setItem(
      SESSION_TOKEN_KEY,
      JSON.stringify({ username: PERSON, tokenId: "mock", token: "mock", expiresAt: null }),
    );
  } catch {
    // Without storage the login screen shows; any name and password connect.
  }
  return new MockGateway();
}

class MockGateway extends GSVClient {
  private mockStatus: GsvClientStatus = { state: "disconnected", url: null, username: null, connectionId: null, message: null };
  private readonly mockStatusListeners = new Set<(status: GsvClientStatus) => void>();
  private readonly mockSignalListeners = new Set<SignalListener>();
  private readonly messages: JsonObject[] = [];
  private pendingApproval: MockApproval | null = null;
  private activeRunId: string | null = null;
  private runCount = 0;
  private sequence = 0;

  constructor() {
    super({ peer: { id: "gsv-ui", version: "0.6.0", platform: "browser" } });
    for (const [author, text] of SEED_CONVERSATION) this.commit(author, text);
  }

  override getStatus(): GsvClientStatus {
    return this.mockStatus;
  }

  override isConnected(): boolean {
    return this.mockStatus.state === "connected";
  }

  override onStatus(listener: (status: GsvClientStatus) => void): () => void {
    this.mockStatusListeners.add(listener);
    listener(this.mockStatus);
    return () => { this.mockStatusListeners.delete(listener); };
  }

  override onSignal(listener: SignalListener): () => void {
    this.mockSignalListeners.add(listener);
    return () => { this.mockSignalListeners.delete(listener); };
  }

  override async connect(options: GsvConnectOptions = {}): Promise<ConnectResult> {
    this.setMockStatus({ state: "connected", url: options.url ?? "mock://gsv", username: PERSON, connectionId: "mock-connection", message: null });
    return {
      protocol: 4,
      server: { version: "0.6.0", release: "mock", connectionId: "mock-connection" },
      peer: {
        id: "gsv-ui",
        sessionId: "mock-session",
        principal: { kind: "human", account: { uid: OWNER_UID, gid: OWNER_UID, gids: [OWNER_UID], username: PERSON, home: `/home/${PERSON}`, cwd: `/home/${PERSON}` } },
        grant: { calls: ["*"], signals: ["*"], implements: [] },
      },
    };
  }

  override disconnect(): void {
    this.setMockStatus({ state: "disconnected", url: null, username: null, connectionId: null, message: null });
  }

  override close(): void {
    this.disconnect();
  }

  override sendSignal(): void {}

  override async request<S extends SyscallName>(call: S, args: ArgsOf<S>, options?: GsvRequestOptions): Promise<GsvResponse<ResultOf<S>>>;
  override async request<T = JsonValue>(call: string, args?: GsvRequestArguments, options?: GsvRequestOptions): Promise<GsvResponse<T>>;
  override async request<T = JsonValue>(call: string, args: GsvRequestArguments | ArgsOf<SyscallName> = {}): Promise<GsvResponse<T>> {
    // SAFETY: each answer below carries the result shape the protocol declares for its call.
    return { data: this.answer(call, args) as T };
  }

  private answer(call: string, args: GsvRequestArguments | ArgsOf<SyscallName>): JsonValue {
    switch (call) {
      case "sys.token.create":
        return { token: { tokenId: "mock", token: "mock", tokenPrefix: "mock", uid: OWNER_UID, kind: "human", label: "gsv-ui-session", peerId: "gsv-ui", createdAt: Date.now(), expiresAt: null } };
      case "sys.token.revoke": return { revoked: true };
      case "proc.list": return { processes: [this.shipProcess()] };
      case "sys.target.list": return { targets: [MAC_TARGET] };
      case "account.list": return { accounts: ACCOUNTS };
      case "sys.config.get": return { entries: [] };
      case "conversation.forProcess": return { conversation: this.conversationSummary() };
      case "conversation.history": {
        const { beforeSequence } = z.object({ beforeSequence: z.number().optional() }).parse(args);
        return { conversation: this.conversationSummary(), messages: beforeSequence === undefined ? this.messages : [], hasMore: false };
      }
      case "proc.history":
        return {
          ok: true, pid: SHIP_PID, format: 2, records: [], messages: [], messageCount: 0, cursor: "epoch:1", hasMore: false,
          historyRevision: 1, historyGeneration: 1, historyResetRevision: 0,
          activeRunId: this.activeRunId, pendingHil: this.pendingApproval?.request ?? null,
        };
      case "proc.observe": return { ok: true, pid: SHIP_PID, observing: true };
      case "proc.unobserve": return { ok: true, pid: SHIP_PID, observing: false };
      case "conversation.send": {
        const { text, selectedTarget } = z.object({ text: z.string(), selectedTarget: z.string().optional() }).parse(args);
        const message = this.commit(PERSON_AUTHOR, text, selectedTarget ? { selectedTarget } : {});
        const runId = `run-${++this.runCount}`;
        this.activeRunId = runId;
        this.later(0, () => this.emit("message.committed", { message, directed: true }));
        this.later(150, () => this.emit("proc.run.started", { pid: SHIP_PID, runId }));
        this.later(700, () => this.act(text.trim(), runId));
        return { message, handlerPid: SHIP_PID, runId };
      }
      case "proc.hil": {
        const { requestId, decision } = z.object({ requestId: z.string(), decision: z.enum(["approve", "deny"]) }).parse(args);
        const pending = this.pendingApproval;
        if (!pending || pending.request.requestId !== requestId) return { ok: false, error: "That approval is no longer pending." };
        this.pendingApproval = null;
        this.emitProcessChanged();
        const runId = z.string().parse(pending.request.runId);
        this.later(400, () => this.reply(runId, decision === "approve" ? pending.approved : pending.denied));
        return { ok: true, pid: SHIP_PID, requestId, decision, resumed: true, pendingHil: null };
      }
      case "proc.abort": {
        const runId = this.activeRunId;
        this.pendingApproval = null;
        const result: JsonObject = { ok: true, pid: SHIP_PID, aborted: runId !== null };
        if (runId) {
          this.finishRun(runId);
          result.runId = runId;
        }
        return result;
      }
      case "repo.list": return { repos: [] };
      case "contact.list": return { contacts: [] };
      case "contact.invite.list": return { invites: [] };
      case "contact.request.list": return { requests: [] };
      case "sys.link.list": return { links: [] };
      case "sys.ledger.list": return { lines: [], nextCursor: null };
      case "r12y.list": return { responsibilities: [], count: 0, revision: 0 };
      case "r12y.source.list": return { sources: [] };
      case "sched.list": return { schedules: [], count: 0 };
      case "sys.mcp.list": return { servers: [] };
      default: throw new Error(`mock gateway: no answer for ${call}`);
    }
  }

  /** The Ship's turn after a person's message: a trigger raises an approval, anything else gets one line back. */
  private act(text: string, runId: string): void {
    const approval = approvalFor(text, runId);
    if (approval) {
      this.pendingApproval = approval;
      this.emitProcessChanged();
      this.emit("proc.run.hil.requested", approval.request);
      return;
    }
    this.reply(runId, `Noted. Type /approve and I'll ask before running something on ${MAC}.`);
  }

  private reply(runId: string, text: string): void {
    const message = this.commit(SHIP_AUTHOR, text, { processId: SHIP_PID, runId });
    this.emit("message.committed", { message, directed: true });
    this.finishRun(runId);
  }

  private finishRun(runId: string): void {
    this.activeRunId = null;
    this.emit("proc.run.finished", { pid: SHIP_PID, runId, queuedCount: 0 });
    this.emitProcessChanged();
  }

  private commit(author: JsonObject, text: string, extra: JsonObject = {}): JsonObject {
    this.sequence += 1;
    const message: JsonObject = {
      id: `m-${this.sequence}`, conversationId: CONVERSATION_ID, sequence: this.sequence, author, text,
      origin: { kind: "client", clientId: "web" }, createdAt: Date.now() - (10 - this.sequence) * 60_000, ...extra,
    };
    this.messages.push(message);
    return message;
  }

  private conversationSummary(): JsonObject {
    return { id: CONVERSATION_ID, kind: "ship", ownerUid: OWNER_UID, title: null, handlerPid: SHIP_PID, latestSequence: this.sequence, createdAt: 1, updatedAt: Date.now() };
  }

  private shipProcess(): JsonObject {
    return {
      pid: SHIP_PID, uid: OWNER_UID, username: "ship", interactive: true, personal: true, parentPid: null,
      state: this.runtimeState(), activeRunId: this.activeRunId, queuedCount: 0, lastActiveAt: Date.now(),
      label: "ship", createdAt: 1, cwd: "/home/ship",
    };
  }

  private runtimeState(): string {
    return this.pendingApproval ? "waiting_hil" : this.activeRunId ? "running" : "idle";
  }

  private emitProcessChanged(): void {
    this.emit("proc.changed", {
      pid: SHIP_PID, changes: ["state"],
      runtime: { state: this.runtimeState(), activeRunId: this.activeRunId, queuedCount: 0, lastActiveAt: Date.now() },
    });
  }

  private emit(signal: string, payload: JsonValue): void {
    for (const listener of this.mockSignalListeners) listener(signal, payload);
  }

  private later(ms: number, run: () => void): void {
    globalThis.setTimeout(run, ms);
  }

  private setMockStatus(status: GsvClientStatus): void {
    this.mockStatus = status;
    for (const listener of this.mockStatusListeners) listener(status);
  }
}

function approvalFor(trigger: string, runId: string): MockApproval | null {
  switch (trigger) {
    case "/approve":
    case "/approve-old": {
      const gated: MockGatedCall = { toolName: "Shell", syscall: "shell.exec", target: MAC, args: { input: GRANOLA_COMMAND, target: MAC } };
      if (trigger === "/approve") gated.reason = "check whether Granola is running and list its windows";
      return {
        request: hilRequest(runId, gated),
        approved: "Granola is running (pid 48213) with two windows open: \"Weekly sync\" and \"Untitled note\".",
        denied: "Okay, I left Granola alone.",
      };
    }
    case "/approve-mail":
      return {
        request: hilRequest(runId, {
          toolName: "mail.send", syscall: "mail.send", target: "gsv",
          args: { to: "mike@example.com", subject: "Contract follow-up", text: "Hi Mike, as promised, here is the follow-up on the contract…" },
          reason: "email Mike the contract follow-up you asked for",
        }),
        approved: "Sent. Mike has the contract follow-up.",
        denied: "Not sent. The draft is still here if you change your mind.",
      };
    case "/approve-file":
      return {
        request: hilRequest(runId, {
          toolName: "Write", syscall: "fs.write", target: MAC,
          args: { path: `/Users/${PERSON}/Notes/granola-windows.md`, content: "# Granola windows\n\n- Weekly sync\n- Untitled note\n", target: MAC },
          reason: "save the list of Granola windows to your Notes folder",
        }),
        approved: "Saved to Notes/granola-windows.md.",
        denied: "Okay, nothing was written.",
      };
    default: return null;
  }
}

function hilRequest(runId: string, gated: MockGatedCall): JsonObject {
  const request: JsonObject = {
    pid: SHIP_PID, requestId: `hil-${runId}`, runId, conversationId: CONVERSATION_ID, callId: `call-${runId}`,
    toolName: gated.toolName, syscall: gated.syscall, target: gated.target, args: gated.args, createdAt: Date.now(),
  };
  if (gated.reason) request.reason = gated.reason;
  return request;
}
