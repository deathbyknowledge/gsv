import { reset, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneCall, PhoneWatchEvent } from "@humansandmachines/gsv/protocol";
import { callObjectName, DEADLINE_GRACE_MS, type PhoneCallObject } from "../src/call";
import type { CallCoordinator } from "../src/coordinator";
import { PhonePolicy } from "../src/config";
import { twilioSignature } from "../src/twilio";
import { fakeProviders } from "./fakes";
import type { RealtimeHandlers } from "../src/realtime";
import type { TestDirectory, TestPhoneEvents } from "./worker";

const owner = { ownerUid: 1000, human: true };
const ship = { ownerUid: 1000, human: false, processId: "proc-1" };
const brief = { to: "+14155550123", business: "Lúa", onBehalfOf: "Esteve Jamez", goal: "Book a table for four on Friday at 21:00", mayShare: ["The name is Esteve"] };
const INSTRUCTIONS = "You are calling a restaurant to book a table.";
// SAFETY: The test Wrangler configuration binds these exact test-only entrypoints.
const events = env.PHONE_EVENTS as unknown as Service<TestPhoneEvents>;
const directory = env.INSTALLATION_DIRECTORY as unknown as Service<TestDirectory>;

afterEach(async () => {
  await reset();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
});

type Stored = { streamToken: string; call: PhoneCall; providerCallId?: string };

async function placed(requestId = "request-1", extra: Partial<typeof brief> & Record<string, unknown> = {}, options: { failDial?: boolean; dialGate?: Promise<void> } = {}) {
  const installationId = crypto.randomUUID();
  const fakes = fakeProviders();
  Object.assign(fakes.telephony, options);
  const coordinator = env.CALL_COORDINATORS.getByName(installationId);
  const { call } = await coordinator.call(ship, { requestId, brief: { ...brief, ...extra } }, INSTRUCTIONS);
  const object = env.CALLS.getByName(callObjectName(installationId, call.callId));
  return { installationId, coordinator, object, call, ...fakes };
}

async function stored(object: DurableObjectStub): Promise<Stored> {
  // SAFETY: The call object's only KV record is its Stored state.
  return runInDurableObject(object, async (_instance, ctx) => ctx.storage.kv.get("call") as Stored);
}
async function patch(object: DurableObjectStub, mutate: (value: Stored & Record<string, unknown>) => void): Promise<void> {
  await runInDurableObject(object, async (_instance, ctx) => {
    // SAFETY: Tests rewrite timing fields of the call object's own Stored record.
    const value = ctx.storage.kv.get("call") as Stored & Record<string, unknown>;
    mutate(value);
    ctx.storage.kv.put("call", value);
  });
}

/** Provider events arrive in the call object's own I/O context, as its sockets would deliver them. */
async function emit(setup: { object: DurableObjectStub; realtime: { handlers?: RealtimeHandlers } }, fire: (handlers: RealtimeHandlers) => void): Promise<void> {
  await runInDurableObject(setup.object, async () => { fire(setup.realtime.handlers!); });
}

async function signed(path: string, fields: Record<string, string>): Promise<Response> {
  const url = `https://calls.example.test${path}`;
  const signature = await twilioSignature("test-auth-token", url, Object.entries(fields));
  return SELF.fetch(url, { method: "POST", body: new URLSearchParams(fields), headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" } });
}

/** The start alarm may already be running when the test asks for it, so wait for its outcome. */
async function dialled(setup: Awaited<ReturnType<typeof placed>>): Promise<void> {
  await runDurableObjectAlarm(setup.object);
  await vi.waitFor(async () => expect((await stored(setup.object)).call.state).not.toBe("queued"));
  await vi.waitFor(async () => expect((await stored(setup.object)).call.state === "dialling" && !(await stored(setup.object)).providerCallId).toBe(false));
}

/** Dials, answers and connects the media stream, returning the Twilio side of the socket. */
async function live(setup: Awaited<ReturnType<typeof placed>>) {
  await dialled(setup);
  const { streamToken, providerCallId } = await stored(setup.object);
  const response = await SELF.fetch(`https://calls.example.test/twilio/stream?i=${setup.installationId}&c=${setup.call.callId}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  socket.accept();
  const received: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", event => { received.push(JSON.parse(String(event.data))); });
  socket.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: { customParameters: { token: streamToken } } }));
  await vi.waitFor(() => expect(setup.realtime.handlers).toBeDefined());
  return { socket, received, providerCallId: providerCallId! };
}

describe("admission", () => {
  it("refuses calls when the allowance is off, the space is inactive, or the country has no number", async () => {
    const installationId = crypto.randomUUID();
    fakeProviders();
    const coordinator = env.CALL_COORDINATORS.getByName(installationId);
    await expect(runInDurableObject(coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "r1", brief: { ...brief, to: "+31201234567" } }, INSTRUCTIONS))).rejects.toThrow(/not available/);
    await expect(runInDurableObject(coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "r2", brief: { ...brief, to: "+19005550123" } }, INSTRUCTIONS))).rejects.toThrow(/cannot be called/);
    await directory.setState(installationId, "restricted");
    await expect(runInDurableObject(coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "r3", brief }, INSTRUCTIONS))).rejects.toThrow(/not active/);
    await directory.setState(installationId, "active");
    vi.spyOn(PhonePolicy.prototype, "limits").mockResolvedValue({ enabled: false, concurrentCalls: 1, dailyCalls: 10, maxCallSeconds: 360 });
    await expect(runInDurableObject(coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "r4", brief }, INSTRUCTIONS))).rejects.toThrow(/not available for this space/);
  });

  it("returns the same call for a retried request and enforces concurrency and the daily limit", async () => {
    const setup = await placed();
    const again = await setup.coordinator.call(ship, { requestId: "request-1", brief }, INSTRUCTIONS);
    expect(again.call.callId).toBe(setup.call.callId);
    await expect(runInDurableObject(setup.coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "request-1", brief: { ...brief, goal: "Something else" } }, INSTRUCTIONS))).rejects.toThrow(/different call/);
    await expect(runInDurableObject(setup.coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "request-2", brief }, INSTRUCTIONS))).rejects.toThrow(/already in progress/);
    await setup.coordinator.end(owner, setup.call.callId);
    await vi.waitFor(async () => expect((await setup.coordinator.list(owner, {})).calls).toHaveLength(0));
    await setup.coordinator.call(ship, { requestId: "request-2", brief }, INSTRUCTIONS).then(({ call }) => setup.coordinator.end(owner, call.callId));
    await vi.waitFor(async () => expect((await setup.coordinator.list(owner, {})).usage.activeCalls).toBe(0));
    await setup.coordinator.call(ship, { requestId: "request-3", brief }, INSTRUCTIONS).then(({ call }) => setup.coordinator.end(owner, call.callId));
    await vi.waitFor(async () => expect((await setup.coordinator.list(owner, {})).usage).toMatchObject({ activeCalls: 0, callsToday: 3, dailyLimit: 3 }));
    await expect(runInDurableObject(setup.coordinator, (instance: CallCoordinator) => instance.call(ship, { requestId: "request-4", brief }, INSTRUCTIONS))).rejects.toThrow(/daily call limit/);
  });

  it("hides calls from other owners", async () => {
    const setup = await placed();
    await expect(runInDurableObject(setup.coordinator, (instance: CallCoordinator) => instance.get({ ownerUid: 1001, human: true }, setup.call.callId))).rejects.toThrow(/does not exist/);
  });
});

describe("a call", () => {
  it("dials the pool number, bridges the stream and the agent, and records the transcript", async () => {
    const setup = await placed();
    await dialled(setup);
    const dial = setup.telephony.dials[0]!;
    expect(dial).toMatchObject({ to: "+14155550123", from: "+13213604274", timeLimitSeconds: 420 });
    expect(dial.twiml).toContain(`wss://calls.example.test/twilio/stream?i=${setup.installationId}&#38;c=${setup.call.callId}`);
    expect(dial.twiml).toContain((await stored(setup.object)).streamToken);
    expect((await signed(`/twilio/status?i=${setup.installationId}&c=${setup.call.callId}`, { CallSid: "CA" + "1".padStart(32, "0"), CallStatus: "ringing" })).status).toBe(204);
    expect((await stored(setup.object)).call.state).toBe("ringing");

    const forged = await SELF.fetch(`https://calls.example.test/twilio/status?i=${setup.installationId}&c=${setup.call.callId}`, { method: "POST", body: new URLSearchParams({ CallStatus: "busy" }) });
    expect(forged.status).toBe(403);

    const response = await SELF.fetch(`https://calls.example.test/twilio/stream?i=${setup.installationId}&c=${setup.call.callId}`, { headers: { Upgrade: "websocket" } });
    const intruder = response.webSocket!;
    intruder.accept();
    const closed = new Promise<number>(resolve => intruder.addEventListener("close", event => resolve(event.code)));
    intruder.send(JSON.stringify({ event: "start", streamSid: "MZ0", start: { customParameters: { token: "wrong" } } }));
    expect(await closed).toBe(1008);

    const { socket, received } = await live(setup);
    expect((await stored(setup.object)).call.state).toBe("in_progress");
    expect(setup.realtime.setup?.instructions).toContain(INSTRUCTIONS);
    expect(setup.realtime.setup?.instructions).toContain("calling for Esteve Jamez and that you are their AI assistant");
    socket.send(JSON.stringify({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: "AAAA" } }));
    await vi.waitFor(() => expect(setup.realtime.audio).toEqual(["AAAA"]));
    await emit(setup, h => h.audio("BBBB"));
    await vi.waitFor(() => expect(received).toContainEqual({ event: "media", streamSid: "MZ1", media: { payload: "BBBB" } }));
    await emit(setup, h => h.speechStarted());
    await vi.waitFor(() => expect(received).toContainEqual({ event: "clear", streamSid: "MZ1" }));

    await emit(setup, h => h.agentLine("Hi! I'm calling for Esteve, I'm his AI assistant. Could I book a table for four?"));
    await emit(setup, h => h.calleeLine("Sure, what time?"));
    await vi.waitFor(async () => expect((await stored(setup.object)).call.disclosed).toBe(true));
    const { transcript } = await setup.coordinator.get(owner, setup.call.callId);
    expect(transcript?.map(line => line.speaker)).toEqual(["agent", "callee"]);
  });

  it("asks the owner, accepts exactly one answer, and ends with the agent's summary after the goodbye plays", async () => {
    const setup = await placed();
    const { socket, received, providerCallId } = await live(setup);
    await events.take(setup.installationId);
    await emit(setup, h => h.toolCall({ id: "t1", name: "ask", arguments: JSON.stringify({ question: "Only 21:30 is free. Take it?" }) }));
    await vi.waitFor(async () => expect((await stored(setup.object)).call.state).toBe("asking"));
    await vi.waitFor(async () => expect((await events.take(setup.installationId)).map(change => change.event)).toContain("asked"));
    expect(setup.realtime.toolResults[0]).toMatchObject({ callId: "t1", respond: true });

    const { question } = (await stored(setup.object)).call;
    const answered = await setup.coordinator.answer(ship, { callId: setup.call.callId, questionId: question!.questionId, answer: "Yes, 21:30 is fine" });
    expect(answered.call).toMatchObject({ state: "in_progress", question: { answer: "Yes, 21:30 is fine", answeredBy: "ship" } });
    await expect(runInDurableObject(setup.object, (instance: PhoneCallObject) => instance.answer(owner, { callId: setup.call.callId, questionId: question!.questionId, answer: "No" }))).rejects.toThrow(/already been answered/);
    expect(setup.realtime.informs.at(-1)).toMatchObject({ text: expect.stringContaining("Yes, 21:30 is fine"), respond: true });

    await setup.coordinator.note(owner, { callId: setup.call.callId, note: "Saturday also works" });
    expect(setup.realtime.informs.at(-1)).toMatchObject({ text: expect.stringContaining("Saturday also works"), respond: false });

    await emit(setup, h => h.toolCall({ id: "t2", name: "end_call", arguments: JSON.stringify({ outcome: "completed", summary: "Booked for 21:30 under Esteve" }) }));
    await vi.waitFor(() => expect(setup.realtime.toolResults.at(-1)).toMatchObject({ callId: "t2", respond: false }));
    await emit(setup, h => h.responseDone({ inputTokens: 10, outputTokens: 5 }));
    expect(setup.realtime.responds).toBe(1);
    await emit(setup, h => h.responseDone({ inputTokens: 3, outputTokens: 4 }));
    await vi.waitFor(() => expect(received).toContainEqual({ event: "mark", streamSid: "MZ1", mark: { name: "hangup" } }));
    expect((await stored(setup.object)).call.state).toBe("in_progress");
    socket.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "hangup" } }));
    await vi.waitFor(async () => expect((await stored(setup.object)).call).toMatchObject({ state: "ended", outcome: "completed", summary: "Booked for 21:30 under Esteve" }));
    expect(setup.telephony.hangUps).toEqual([providerCallId]);
    expect(setup.realtime.closed).toBe(true);

    await signed(`/twilio/status?i=${setup.installationId}&c=${setup.call.callId}`, { CallSid: providerCallId, CallStatus: "busy" });
    expect((await stored(setup.object)).call.outcome).toBe("completed");
    await vi.waitFor(async () => expect((await events.take(setup.installationId)).map(change => change.event)).toContain("ended"));
    const listed = await setup.coordinator.list(owner, { includeEnded: true });
    expect(listed.calls[0]).toMatchObject({ state: "ended", outcome: "completed" });
  });

  it("checks in while a question is open and calls back when the owner does not answer", async () => {
    const setup = await placed();
    const { providerCallId } = await live(setup);
    await emit(setup, h => h.toolCall({ id: "t1", name: "ask", arguments: JSON.stringify({ question: "Deposit of 10 euros?" }) }));
    await vi.waitFor(async () => expect((await stored(setup.object)).call.state).toBe("asking"));
    const shift = (ms: number) => patch(setup.object, value => {
      value.call.question = { ...value.call.question!, askedAt: value.call.question!.askedAt - ms, deadlineAt: value.call.question!.deadlineAt - ms };
    });
    await shift(16_000);
    await runDurableObjectAlarm(setup.object);
    expect(setup.realtime.informs.at(-1)?.text).toMatch(/still checking/);
    await shift(30_000);
    await runDurableObjectAlarm(setup.object);
    expect(setup.realtime.informs.at(-1)?.text).toMatch(/will call back/);
    const { question } = (await stored(setup.object)).call;
    await expect(runInDurableObject(setup.object, (instance: PhoneCallObject) => instance.answer(owner, { callId: setup.call.callId, questionId: question!.questionId, answer: "Yes" }))).rejects.toThrow(/expired/);
    await shift(DEADLINE_GRACE_MS);
    await runDurableObjectAlarm(setup.object);
    expect((await stored(setup.object)).call).toMatchObject({ state: "ended", outcome: "callback_needed", reason: "question_deadline" });
    expect(setup.telephony.hangUps).toEqual([providerCallId]);
  });

  it("hangs up at the time cap", async () => {
    const setup = await placed("request-1", { maxMinutes: 2 });
    await live(setup);
    await patch(setup.object, value => { value.call.answeredAt = Date.now() - 100_000; });
    await runDurableObjectAlarm(setup.object);
    expect(setup.realtime.informs.at(-1)?.text).toMatch(/Wrap up/);
    await patch(setup.object, value => { value.call.answeredAt = Date.now() - 121_000; });
    await runDurableObjectAlarm(setup.object);
    expect((await stored(setup.object)).call).toMatchObject({ state: "ended", outcome: "callback_needed", reason: "time_limit" });
  });

  it("ends when the owner ends it, and late provider callbacks change nothing", async () => {
    const setup = await placed();
    const { providerCallId } = await live(setup);
    const { call } = await setup.coordinator.end(owner, setup.call.callId);
    expect(call).toMatchObject({ state: "ended", outcome: "ended_by_owner" });
    expect(setup.telephony.hangUps).toEqual([providerCallId]);
    await signed(`/twilio/status?i=${setup.installationId}&c=${setup.call.callId}`, { CallSid: providerCallId, CallStatus: "completed" });
    expect((await stored(setup.object)).call).toMatchObject({ outcome: "ended_by_owner", revision: call.revision });
  });

  it("hangs up a call the owner ended while it was being placed", async () => {
    let release!: () => void;
    const setup = await placed("request-1", {}, { dialGate: new Promise<void>(resolve => { release = resolve; }) });
    void runDurableObjectAlarm(setup.object);
    await vi.waitFor(async () => expect((await stored(setup.object)).call.state).toBe("dialling"));
    await setup.coordinator.end(owner, setup.call.callId);
    release();
    await vi.waitFor(() => expect(setup.telephony.hangUps).toHaveLength(1));
    expect((await stored(setup.object)).call).toMatchObject({ state: "ended", outcome: "ended_by_owner" });
  });

  it("maps provider outcomes before answer and hangs up on voicemail", async () => {
    const busy = await placed();
    await dialled(busy);
    const sid = (await stored(busy.object)).providerCallId!;
    await signed(`/twilio/status?i=${busy.installationId}&c=${busy.call.callId}`, { CallSid: sid, CallStatus: "busy" });
    expect((await stored(busy.object)).call).toMatchObject({ state: "ended", outcome: "busy", durationSeconds: 0 });

    const machine = await placed("request-2");
    const { providerCallId } = await live(machine);
    await signed(`/twilio/machine?i=${machine.installationId}&c=${machine.call.callId}`, { CallSid: providerCallId, AnsweredBy: "machine_end_beep" });
    expect((await stored(machine.object)).call).toMatchObject({ state: "ended", outcome: "voicemail" });
    expect(machine.telephony.hangUps).toEqual([providerCallId]);
  });

  it("leaves a message when the brief asks for one", async () => {
    const setup = await placed("request-1", { voicemail: "leave_message" });
    const { providerCallId } = await live(setup);
    await signed(`/twilio/machine?i=${setup.installationId}&c=${setup.call.callId}`, { CallSid: providerCallId, AnsweredBy: "machine_end_beep" });
    expect(setup.realtime.informs.at(-1)?.text).toMatch(/voicemail/);
    expect((await stored(setup.object)).call.state).toBe("in_progress");
  });

  it("fails with a diagnostic when dialling fails, and drops when the voice session closes", async () => {
    const failed = await placed("request-1", {}, { failDial: true });
    await dialled(failed);
    expect((await stored(failed.object)).call).toMatchObject({ state: "ended", outcome: "failed", reason: "dial_failed", diagnosticRef: expect.any(String) });

    const dropped = await placed("request-2");
    await live(dropped);
    await emit(dropped, h => h.closed());
    await vi.waitFor(async () => expect((await stored(dropped.object)).call).toMatchObject({ state: "ended", outcome: "dropped" }));
  });

  it("presses keys by replaying the stream with tones", async () => {
    const setup = await placed();
    const { providerCallId } = await live(setup);
    await emit(setup, h => h.toolCall({ id: "k1", name: "keypad", arguments: JSON.stringify({ digits: "1w2" }) }));
    await vi.waitFor(() => expect(setup.telephony.redirects).toHaveLength(1));
    expect(setup.telephony.redirects[0]).toMatchObject({ providerCallId, twiml: expect.stringContaining('<Play digits="1w2"/><Connect><Stream') });
    await emit(setup, h => h.toolCall({ id: "k2", name: "keypad", arguments: JSON.stringify({ digits: "call me" }) }));
    await vi.waitFor(() => expect(setup.realtime.toolResults.at(-1)).toMatchObject({ callId: "k2", output: expect.stringMatching(/only/) }));
  });

  it("lets only the owner take over, then moves the callee into the owner's conference", async () => {
    const setup = await placed();
    const { providerCallId } = await live(setup);
    await expect(runInDurableObject(setup.object, (instance: PhoneCallObject) => instance.join(ship))).rejects.toThrow(/Only the owner/);
    const join = await setup.coordinator.join(owner, setup.call.callId);
    expect(join).toMatchObject({ provider: "twilio", connectParams: { installation: setup.installationId, call: setup.call.callId } });
    const forged = await signed("/twilio/join", { From: "client:owner_someoneelse", installation: setup.installationId, call: setup.call.callId });
    expect(await forged.text()).toBe("<Response><Hangup/></Response>");
    const accepted = await signed("/twilio/join", { From: `client:${join.identity}`, ...join.connectParams });
    expect(await accepted.text()).toContain(`call-${setup.call.callId}</Conference>`);
    expect(setup.telephony.redirects[0]).toMatchObject({ providerCallId, twiml: expect.stringContaining("<Conference") });
    expect((await stored(setup.object)).call.state).toBe("taken_over");
    expect(setup.realtime.closed).toBe(true);
    await signed(`/twilio/status?i=${setup.installationId}&c=${setup.call.callId}`, { CallSid: providerCallId, CallStatus: "completed" });
    expect((await stored(setup.object)).call.outcome).toBe("owner_took_over");
  });

  it("streams state and transcript to viewers and closes the stream at the end", async () => {
    const setup = await placed();
    await live(setup);
    await emit(setup, h => h.agentLine("Hi! I'm calling for Esteve, I'm his AI assistant."));
    await vi.waitFor(async () => expect((await setup.coordinator.get(owner, setup.call.callId)).transcript).toHaveLength(1));
    const { body } = await setup.coordinator.watch(owner, setup.call.callId);
    await emit(setup, h => h.calleeLine("Hello?"));
    await setup.coordinator.end(owner, setup.call.callId);
    const text = await new Response(body.stream).text();
    const lines = text.trim().split("\n").map(line => JSON.parse(line) as PhoneWatchEvent);
    expect(lines[0]).toMatchObject({ kind: "call", call: { state: "in_progress" } });
    expect(lines.filter(event => event.kind === "line").map(event => event.kind === "line" && event.line.speaker)).toEqual(["agent", "callee"]);
    expect(lines.at(-1)).toMatchObject({ kind: "call", call: { state: "ended" } });
  });

  it("drops the transcript once the Kernel has filed it", async () => {
    const setup = await placed();
    await live(setup);
    await emit(setup, h => h.calleeLine("Hello?"));
    await expect(runInDurableObject(setup.object, (instance: PhoneCallObject) => instance.transcriptFiled(owner, "/home/ship/calls/x.md"))).rejects.toThrow(/not ended/);
    await setup.coordinator.end(owner, setup.call.callId);
    await setup.coordinator.transcriptFiled(owner, setup.call.callId, "/home/ship/calls/x.md");
    const result = await setup.coordinator.get(owner, setup.call.callId);
    expect(result).toMatchObject({ transcriptPath: "/home/ship/calls/x.md" });
    expect(result.transcript).toBeUndefined();
  });
});
