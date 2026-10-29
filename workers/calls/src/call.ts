import { DurableObject } from "cloudflare:workers";
import type { PhoneCall, PhoneCallOutcome, PhoneTranscriptLine, SysPhoneAnswerArgs, SysPhoneGetResult, SysPhoneJoinResult, SysPhoneNoteArgs } from "@humansandmachines/gsv/protocol";
import type { PhoneActor, PhoneChange } from "@humansandmachines/gsv/services/phone";
import { jsonVar, realtimeConfigSchema, type Environment } from "./config";
import { AGENT_OUTCOMES, agentTools, disclosed, KEYPAD_PATTERN, NUDGES, serviceRules, transcriptionLanguage, type AgentOutcome } from "./agent";
import { providers } from "./providers";
import type { RealtimeSession } from "./realtime";
import { diagnosticDetail, migrateCall } from "./schema";
import { conferenceTwiml, streamPath, streamTwiml } from "./twilio";
import { CallWatch } from "./watch";

export const CHECK_IN_MS = 15_000;
export const QUESTION_MS = 45_000;
/** After the deadline nudge, the agent has this long to end the call itself. */
export const DEADLINE_GRACE_MS = 20_000;
export const GOODBYE_MS = 15_000;
export const WRAP_UP_MS = 30_000;
/** No provider status this long after dialling means the leg was lost. */
export const DIAL_WATCHDOG_MS = 120_000;
const REPORT_RETRY_MS = 10_000;
const JOIN_TTL_SECONDS = 120;
const MAX_WATCHERS = 4;

export type CallStart = {
  installationId: string;
  call: PhoneCall;
  instructions: string;
  from: string;
  maxSeconds: number;
};

type Event = PhoneChange["event"];
export type ReportedChange = { event: Event; revision: number };
type Stored = CallStart & {
  streamToken: string;
  providerCallId?: string;
  dialledAt?: number;
  /** The agent chose to end; its goodbye plays before the line closes. */
  ending?: { at: number; outcome: AgentOutcome; summary: string; stage: "tool" | "goodbye" | "marked" };
  checkIns: number;
  deadlineNudged: boolean;
  wrapUpSent: boolean;
  join?: { identity: string; expiresAt: number };
  transcriptPath?: string;
  /** Changes the coordinator has not acknowledged yet. */
  report?: ReportedChange[];
  usage: { inputTokens: number; outputTokens: number };
};

const KEY = "call";
const LIVE = new Set<PhoneCall["state"]>(["in_progress", "asking"]);
const STREAMABLE = new Set<PhoneCall["state"]>(["dialling", "ringing", "in_progress", "asking"]);
const PROVIDER_OUTCOMES: Record<string, PhoneCallOutcome> = { busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "failed" };

export const callObjectName = (installationId: string, callId: string): string => `${installationId}#${callId}`;
const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
export const newCallId = (): string => hex(16);

/**
 * One placed call: its lease, PSTN leg, realtime session and transcript. A call
 * is never replayed; any failure after dialling ends it with an outcome.
 */
export class PhoneCallObject extends DurableObject<Environment> {
  #twilio: { socket: WebSocket; streamSid: string } | undefined;
  #realtime: RealtimeSession | undefined;
  #opening: Promise<void> | undefined;
  #flushing: Promise<void> | undefined;
  readonly #watchers = new Set<CallWatch>();

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    migrateCall(ctx.storage);
  }

  async start(input: CallStart): Promise<PhoneCall> {
    const existing = this.#load();
    if (existing) return existing.call;
    const stored: Stored = { ...input, streamToken: hex(24), checkIns: 0, deadlineNudged: false, wrapUpSent: false, usage: { inputTokens: 0, outputTokens: 0 } };
    this.#save(stored);
    await this.ctx.storage.setAlarm(Date.now());
    return stored.call;
  }

  async alarm(): Promise<void> {
    const stored = this.#load();
    if (!stored) return;
    if (stored.report) await this.#flush();
    const now = Date.now(), { call } = stored;
    if (call.state === "queued") await this.#dial(stored);
    else if ((call.state === "dialling" || call.state === "ringing") && now >= (stored.dialledAt ?? call.createdAt) + DIAL_WATCHDOG_MS) {
      await this.#finish("failed", { reason: "no_provider_status", hangUp: true });
    } else if (LIVE.has(call.state)) await this.#liveTimers(stored, now);
    await this.#schedule();
  }

  async #liveTimers(stored: Stored, now: number): Promise<void> {
    const { call } = stored;
    const cap = (call.answeredAt ?? now) + stored.maxSeconds * 1000;
    if (stored.ending && now >= stored.ending.at + GOODBYE_MS) {
      await this.#finish(stored.ending.outcome, { summary: stored.ending.summary, hangUp: true });
      return;
    }
    if (now >= cap) { await this.#finish("callback_needed", { reason: "time_limit", hangUp: true }); return; }
    const question = call.state === "asking" && call.question && !call.question.answer ? call.question : undefined;
    if (question && now >= question.deadlineAt + DEADLINE_GRACE_MS) {
      await this.#finish("callback_needed", { reason: "question_deadline", hangUp: true });
      return;
    }
    if (!stored.wrapUpSent && now >= cap - WRAP_UP_MS) {
      this.#mutateQuietly(value => { value.wrapUpSent = true; });
      this.#realtime?.inform(NUDGES.wrapUp, true);
    }
    if (!question || stored.ending) return;
    if (now >= question.deadlineAt) {
      if (!stored.deadlineNudged) {
        this.#mutateQuietly(value => { value.deadlineNudged = true; });
        this.#realtime?.inform(NUDGES.deadline, true);
      }
    } else if (stored.checkIns < 2 && now >= question.askedAt + CHECK_IN_MS * (stored.checkIns + 1)) {
      this.#mutateQuietly(value => { value.checkIns += 1; });
      this.#realtime?.inform(NUDGES.checkIn, true);
    }
  }

  async #dial(stored: Stored): Promise<void> {
    const { installationId, call } = stored;
    this.#update(value => { value.call.state = "dialling"; value.dialledAt = Date.now(); });
    const origin = new URL(this.env.PUBLIC_ORIGIN);
    const query = `i=${encodeURIComponent(installationId)}&c=${encodeURIComponent(call.callId)}`;
    const stream = new URL(streamPath(installationId, call.callId), origin);
    stream.protocol = "wss:";
    try {
      const { providerCallId } = await providers.telephony(this.env).dial({
        to: call.brief.to, from: stored.from, twiml: streamTwiml(stream.href, stored.streamToken),
        statusCallback: new URL(`/twilio/status?${query}`, origin).href,
        machineCallback: new URL(`/twilio/machine?${query}`, origin).href,
        timeLimitSeconds: stored.maxSeconds + 60,
      });
      this.#mutateQuietly(value => { value.providerCallId = providerCallId; });
      // The owner may have ended the call while it was being placed.
      if (this.#load()!.call.state === "ended") await providers.telephony(this.env).hangUp(providerCallId).catch(cause => { this.#diagnostic(cause); });
    } catch (cause) {
      // The request may have reached Twilio; a late leg finds a terminal call and is never bridged.
      await this.#finish("failed", { reason: "dial_failed", cause, hangUp: false });
    }
  }

  /** Twilio call status, already signature-verified by the Worker. */
  async providerStatus(params: Record<string, string>): Promise<void> {
    const stored = this.#load();
    if (!stored || stored.call.state === "ended" || (stored.providerCallId && params.CallSid !== stored.providerCallId)) return;
    const status = params.CallStatus;
    if (status === "ringing") {
      if (stored.call.state === "dialling") this.#update(value => { value.call.state = "ringing"; });
    } else if (status === "in-progress" || status === "answered") {
      this.#answered(stored);
    } else if (status === "completed") {
      const outcome = stored.ending?.outcome
        ?? (stored.call.state === "taken_over" ? "owner_took_over" : stored.call.answeredAt ? "dropped" : "failed");
      await this.#finish(outcome, { summary: stored.ending?.summary, hangUp: false });
    } else if (status && PROVIDER_OUTCOMES[status]) {
      await this.#finish(PROVIDER_OUTCOMES[status]!, { hangUp: false });
    }
    await this.#schedule();
  }

  /** Twilio's asynchronous answering-machine result. */
  async machineResult(params: Record<string, string>): Promise<void> {
    const stored = this.#load();
    if (!stored || stored.call.state === "ended" || params.CallSid !== stored.providerCallId) return;
    const answeredBy = params.AnsweredBy ?? "";
    if (!answeredBy.startsWith("machine") && answeredBy !== "fax") return;
    // Detection can finish late, for example behind a phone's call screening; a callee who answered the agent is a person.
    if (answeredBy !== "fax" && this.#calleeReplied()) return;
    if (stored.call.brief.voicemail === "leave_message" && answeredBy !== "fax" && this.#realtime) {
      this.#realtime.inform(NUDGES.voicemail, true);
      return;
    }
    await this.#finish("voicemail", { hangUp: true });
    await this.#schedule();
  }

  /** The bidirectional media stream Twilio opens once the callee answers. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const { 0: client, 1: socket } = new WebSocketPair();
    socket.accept();
    socket.addEventListener("message", event => {
      if (typeof event.data === "string") void this.#media(socket, event.data).catch(cause => this.#diagnostic(cause));
    });
    socket.addEventListener("close", () => { if (this.#twilio?.socket === socket) this.#twilio = undefined; });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #media(socket: WebSocket, data: string): Promise<void> {
    const message = JSON.parse(data) as { event?: string; streamSid?: string; start?: { customParameters?: Record<string, string> }; media?: { track?: string; payload?: string }; mark?: { name?: string } };
    if (message.event === "media") {
      if (this.#twilio?.socket === socket && message.media?.payload && message.media.track !== "outbound") this.#realtime?.appendAudio(message.media.payload);
    } else if (message.event === "start") {
      const stored = this.#load();
      if (!stored || !STREAMABLE.has(stored.call.state) || !message.streamSid || !tokenMatches(message.start?.customParameters?.token, stored.streamToken)) {
        socket.close(1008, "Unknown stream");
        return;
      }
      // A keypad redirect reconnects the stream; the realtime session carries on.
      this.#twilio = { socket, streamSid: message.streamSid };
      this.#answered(stored);
      await this.#openRealtime();
      await this.#schedule();
    } else if (message.event === "mark" && message.mark?.name === "hangup") {
      const ending = this.#load()?.ending;
      if (ending) await this.#finish(ending.outcome, { summary: ending.summary, hangUp: true });
    } else if (message.event === "stop") {
      if (this.#twilio?.socket === socket) this.#twilio = undefined;
    }
  }

  #answered(stored: Stored): void {
    if (stored.call.state !== "dialling" && stored.call.state !== "ringing") return;
    this.#update(value => { value.call.state = "in_progress"; value.call.answeredAt = Date.now(); });
  }

  #openRealtime(): Promise<void> {
    if (this.#realtime) return Promise.resolve();
    this.#opening ??= (async () => {
      const stored = this.#load()!;
      const config = realtimeConfigSchema.parse(jsonVar(this.env.PHONE_REALTIME));
      try {
        const credential = await this.env.REALTIME_SESSIONS.createRealtimeSession({ installationId: stored.installationId, callId: stored.call.callId, model: config.model });
        const session = await providers.realtime().open(credential, {
          instructions: `${stored.instructions}\n\n${serviceRules(stored.call.brief)}`,
          tools: agentTools(stored.call.brief), voice: config.voice,
          transcriptionModel: config.transcriptionModel, language: transcriptionLanguage(stored.call.brief),
        }, {
          audio: payload => this.#toCallee({ event: "media", media: { payload } }),
          speechStarted: () => this.#toCallee({ event: "clear" }),
          agentLine: text => this.#agentLine(text),
          calleeLine: text => this.#line("callee", text),
          toolCall: call => { void this.#tool(call).catch(cause => this.#diagnostic(cause)); },
          responseDone: usage => this.#responseDone(usage),
          closed: () => { void this.#realtimeClosed(session).catch(cause => this.#diagnostic(cause)); },
        });
        if (this.#load()?.call.state === "ended") session.close();
        else this.#realtime = session;
      } catch (cause) {
        await this.#finish("failed", { reason: "voice_session_failed", cause, hangUp: true });
      }
    })().finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  async #realtimeClosed(session: RealtimeSession): Promise<void> {
    if (this.#realtime !== session) return;
    this.#realtime = undefined;
    const stored = this.#load();
    if (stored && LIVE.has(stored.call.state)) await this.#finish("dropped", { reason: "voice_session_closed", hangUp: true });
  }

  #toCallee(message: Record<string, unknown>): void {
    const twilio = this.#twilio;
    if (twilio) twilio.socket.send(JSON.stringify({ ...message, streamSid: twilio.streamSid }));
  }

  #agentLine(text: string): void {
    this.#line("agent", text);
    const stored = this.#load();
    if (stored && stored.call.disclosed === undefined) this.#update(value => { value.call.disclosed = disclosed(text, value.call.brief); });
  }

  #responseDone(usage: { inputTokens: number; outputTokens: number }): void {
    const stored = this.#load();
    if (!stored || stored.call.state === "ended") return;
    this.#mutateQuietly(value => {
      value.usage = { inputTokens: value.usage.inputTokens + usage.inputTokens, outputTokens: value.usage.outputTokens + usage.outputTokens };
      if (value.ending?.stage === "tool") value.ending.stage = "goodbye";
      else if (value.ending?.stage === "goodbye") value.ending.stage = "marked";
    });
    const stage = this.#load()!.ending?.stage;
    // The response that called end_call is done: ask for the goodbye, then hang up once Twilio has played it.
    if (stage === "goodbye") this.#realtime?.respond();
    else if (stage === "marked") {
      if (this.#twilio) this.#toCallee({ event: "mark", mark: { name: "hangup" } });
      else void this.#finish(stored.ending!.outcome, { summary: stored.ending!.summary, hangUp: true }).catch(cause => this.#diagnostic(cause));
    }
  }

  async #tool(call: { id: string; name: string; arguments: string }): Promise<void> {
    const stored = this.#load();
    const session = this.#realtime;
    if (!stored || !session || !LIVE.has(stored.call.state)) return;
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.arguments) as Record<string, unknown>; } catch { args = {}; }
    if (call.name === "ask" && (stored.call.brief.ifOutsideLimits ?? "ask") === "ask") {
      const question = typeof args.question === "string" ? args.question.trim().slice(0, 1000) : "";
      if (!question) return session.toolResult(call.id, "Give the question to ask.", false);
      if (stored.call.state === "asking") return session.toolResult(call.id, "A question is already open; wait for its answer.", false);
      const askedAt = Date.now();
      this.#update(value => {
        value.call.state = "asking";
        value.call.question = { questionId: hex(8), question, askedAt, deadlineAt: askedAt + QUESTION_MS };
        value.checkIns = 0; value.deadlineNudged = false;
        return ["asked"];
      });
      session.toolResult(call.id, "The owner has been asked. Tell the callee you are checking, and keep the line.", true);
    } else if (call.name === "end_call") {
      const outcome = AGENT_OUTCOMES.find(value => value === args.outcome) ?? "completed";
      const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 2000) : "";
      this.#mutateQuietly(value => { value.ending = { at: Date.now(), outcome, summary, stage: "tool" }; });
      session.toolResult(call.id, "Ending the call.", false);
    } else if (call.name === "keypad") {
      const digits = typeof args.digits === "string" ? args.digits : "";
      if (!KEYPAD_PATTERN.test(digits) || !stored.providerCallId) return session.toolResult(call.id, "Use only 0-9, * and #.", false);
      // Bidirectional streams cannot carry tones, so the call briefly plays them and reconnects its stream.
      const origin = new URL(this.env.PUBLIC_ORIGIN);
      const stream = new URL(streamPath(stored.installationId, stored.call.callId), origin);
      stream.protocol = "wss:";
      try {
        await providers.telephony(this.env).redirect(stored.providerCallId, streamTwiml(stream.href, stored.streamToken, digits));
        session.toolResult(call.id, "Pressed.", false);
      } catch (cause) {
        this.#diagnostic(cause);
        session.toolResult(call.id, "The keys could not be pressed.", false);
      }
    } else session.toolResult(call.id, "Unknown tool.", false);
    await this.#schedule();
  }

  async get(actor: PhoneActor): Promise<SysPhoneGetResult> {
    const stored = this.#owned(actor);
    return { call: stored.call, ...(stored.transcriptPath ? { transcriptPath: stored.transcriptPath } : { transcript: this.#transcript() }) };
  }

  async answer(actor: PhoneActor, args: SysPhoneAnswerArgs): Promise<PhoneCall> {
    const stored = this.#owned(actor);
    const question = stored.call.question;
    if (stored.call.state !== "asking" || !question || question.questionId !== args.questionId || question.answer || Date.now() >= question.deadlineAt) {
      throw new Error("This question has already been answered or has expired");
    }
    this.#update(value => {
      value.call.state = "in_progress";
      value.call.question = { ...question, answer: args.answer, answeredBy: actor.human ? "owner" : "ship", answeredAt: Date.now() };
    });
    this.#line("answer", args.answer);
    this.#realtime?.inform(NUDGES.answer(args.answer), true);
    await this.#schedule();
    return this.#load()!.call;
  }

  async note(actor: PhoneActor, args: SysPhoneNoteArgs): Promise<PhoneCall> {
    const stored = this.#owned(actor);
    if (!LIVE.has(stored.call.state) || !this.#realtime) throw new Error("This call is not in progress");
    this.#line("note", args.note);
    this.#realtime.inform(NUDGES.note(args.note), false);
    return stored.call;
  }

  async end(actor: PhoneActor): Promise<PhoneCall> {
    this.#owned(actor);
    await this.#finish("ended_by_owner", { hangUp: true });
    await this.#schedule();
    return this.#load()!.call;
  }

  async watch(actor: PhoneActor) {
    const stored = this.#owned(actor);
    if (this.#watchers.size >= MAX_WATCHERS) throw new Error("This call already has four open viewers");
    const initial = [{ kind: "call" as const, call: stored.call }, ...this.#transcript().map(line => ({ kind: "line" as const, line }))];
    const watch: CallWatch = new CallWatch(initial, () => { this.#watchers.delete(watch); });
    if (stored.call.state === "ended") watch.close();
    else this.#watchers.add(watch);
    return { data: { call: stored.call }, body: watch.body };
  }

  async join(actor: PhoneActor): Promise<SysPhoneJoinResult> {
    const stored = this.#owned(actor);
    if (!actor.human || actor.processId) throw new Error("Only the owner can take over a call");
    if (!LIVE.has(stored.call.state) || !this.#twilio) throw new Error("This call is not in progress");
    const identity = `owner_${hex(12)}`;
    const { token, expiresAt } = await providers.telephony(this.env).joinToken(identity, JOIN_TTL_SECONDS);
    this.#mutateQuietly(value => { value.join = { identity, expiresAt }; });
    return {
      call: stored.call, provider: "twilio", token, identity, expiresAt,
      connectParams: { installation: stored.installationId, call: stored.call.callId },
    };
  }

  /** The owner's client connected through the TwiML App; returns TwiML for that leg. */
  async joinConnected(identity: string): Promise<string> {
    const stored = this.#load();
    const join = stored?.join;
    if (!stored || !join || join.identity !== identity || join.expiresAt <= Date.now() || !LIVE.has(stored.call.state) || !stored.providerCallId) {
      throw new Error("No take-over is pending for this call");
    }
    const room = conferenceTwiml(`call-${stored.call.callId}`);
    await providers.telephony(this.env).redirect(stored.providerCallId, room);
    this.#update(value => { value.call.state = "taken_over"; delete value.join; delete value.ending; });
    this.#realtime?.close();
    this.#realtime = undefined;
    await this.#schedule();
    return room;
  }

  /** The Kernel wrote the transcript file; only the record remains here. */
  async transcriptFiled(actor: PhoneActor, path: string): Promise<void> {
    const stored = this.#owned(actor);
    if (stored.call.state !== "ended") throw new Error("This call has not ended");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM transcript");
      this.#mutateQuietly(value => { value.transcriptPath = path; });
    });
  }

  async #finish(outcome: PhoneCallOutcome, options: { summary?: string; reason?: string; cause?: unknown; hangUp: boolean }): Promise<void> {
    const stored = this.#load();
    if (!stored || stored.call.state === "ended") return;
    const diagnosticRef = options.cause === undefined ? undefined : this.#diagnostic(options.cause);
    const endedAt = Date.now();
    this.#update(value => {
      const call = value.call;
      call.state = "ended"; call.outcome = outcome; call.endedAt = endedAt;
      call.durationSeconds = call.answeredAt ? Math.max(0, Math.round((endedAt - call.answeredAt) / 1000)) : 0;
      if (options.summary && (outcome === "completed" || outcome === "callback_needed")) call.summary = options.summary;
      if (options.reason) call.reason = options.reason;
      if (diagnosticRef) call.diagnosticRef = diagnosticRef;
      delete value.ending; delete value.join;
      return ["ended"];
    });
    const realtime = this.#realtime;
    this.#realtime = undefined;
    realtime?.close();
    if (options.hangUp && stored.providerCallId) {
      try { await providers.telephony(this.env).hangUp(stored.providerCallId); } catch (cause) { this.#diagnostic(cause); }
    }
    const twilio = this.#twilio;
    this.#twilio = undefined;
    try { twilio?.socket.close(1000, "call ended"); } catch { /* already closed */ }
    for (const watch of [...this.#watchers]) watch.close();
  }

  #line(speaker: PhoneTranscriptLine["speaker"], text: string): void {
    const line = { at: Date.now(), speaker, text: text.slice(0, 4000) };
    this.ctx.storage.sql.exec("INSERT INTO transcript (at, speaker, text) VALUES (?, ?, ?)", line.at, line.speaker, line.text);
    for (const watch of this.#watchers) watch.send({ kind: "line", line });
  }

  #calleeReplied(): boolean {
    let agentSpoke = false;
    for (const line of this.#transcript()) {
      if (line.speaker === "agent") agentSpoke = true;
      else if (agentSpoke && line.speaker === "callee") return true;
    }
    return false;
  }

  #transcript(): PhoneTranscriptLine[] {
    return this.ctx.storage.sql.exec<PhoneTranscriptLine>("SELECT at, speaker, text FROM transcript ORDER BY seq").toArray()
      .map(row => ({ at: row.at, speaker: row.speaker, text: row.text }));
  }

  #owned(actor: PhoneActor): Stored {
    const stored = this.#load();
    if (!stored || stored.call.ownerUid !== actor.ownerUid) throw new Error("Call does not exist");
    return stored;
  }

  #load(): Stored | undefined { return this.ctx.storage.kv.get<Stored>(KEY); }
  #save(stored: Stored): void { this.ctx.storage.kv.put(KEY, stored); }

  /** Private bookkeeping that is not part of the public record. */
  #mutateQuietly(mutate: (stored: Stored) => void): void {
    const stored = this.#load()!;
    mutate(stored);
    this.#save(stored);
  }

  /** A public state change: bumps the revision, reaches viewers, and is reported to the coordinator. */
  #update(mutate: (stored: Stored) => Event[] | void): void {
    const stored = this.#load()!;
    if (stored.call.state === "ended") return;
    const events = mutate(stored) ?? ["changed"];
    const revision = stored.call.revision += 1;
    stored.report = [...(stored.report ?? []).filter(change => !events.includes(change.event)), ...events.map(event => ({ event, revision }))];
    this.#save(stored);
    for (const watch of this.#watchers) watch.send({ kind: "call", call: stored.call });
    this.ctx.waitUntil(this.#flush());
  }

  #flush(): Promise<void> {
    this.#flushing ??= (async () => {
      for (let stored = this.#load(); stored?.report; stored = this.#load()) {
        const { call, report, installationId } = stored;
        try {
          await this.env.CALL_COORDINATORS.getByName(installationId).recordCall(call, report);
        } catch (cause) {
          this.#diagnostic(cause);
          return;
        }
        const latest = this.#load()!;
        const remaining = latest.report?.filter(change => change.revision > call.revision) ?? [];
        if (remaining.length) latest.report = remaining;
        else delete latest.report;
        this.#save(latest);
      }
    })().finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }

  async #schedule(): Promise<void> {
    const stored = this.#load();
    if (!stored) return;
    const { call } = stored, now = Date.now(), times: number[] = [];
    if (stored.report) times.push(now + REPORT_RETRY_MS);
    if (call.state === "queued") times.push(now);
    if (call.state === "dialling" || call.state === "ringing") times.push((stored.dialledAt ?? call.createdAt) + DIAL_WATCHDOG_MS);
    if (LIVE.has(call.state)) {
      const cap = (call.answeredAt ?? now) + stored.maxSeconds * 1000;
      times.push(cap);
      if (!stored.wrapUpSent) times.push(cap - WRAP_UP_MS);
      if (stored.ending) times.push(stored.ending.at + GOODBYE_MS);
      const question = call.state === "asking" && call.question && !call.question.answer ? call.question : undefined;
      if (question) {
        if (stored.checkIns < 2) times.push(question.askedAt + CHECK_IN_MS * (stored.checkIns + 1));
        if (!stored.deadlineNudged) times.push(question.deadlineAt);
        times.push(question.deadlineAt + DEADLINE_GRACE_MS);
      }
    }
    if (times.length) await this.ctx.storage.setAlarm(Math.max(now, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  #diagnostic(cause: unknown): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO diagnostics (id, occurred_at, detail) VALUES (?, ?, ?)", id, Date.now(), diagnosticDetail(cause));
    console.warn(`[Calls] call operation failed; diagnostic ${id}`);
    return id;
  }
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = new TextEncoder().encode(actual), b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
