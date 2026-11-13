import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { createMockGatewayClient, mockGatewayRequested } from "./mockGateway";
import { requestFsRead } from "./fsRead";
import { readChatResource } from "../chat/backend/chatService";
import { bodyToText, type FsReadResult } from "@humansandmachines/gsv/protocol";

const hilSchema = z.object({ pid: z.string(), requestId: z.string(), syscall: z.string(), target: z.string(), purpose: z.string().optional(), args: z.object({ input: z.string().optional() }) });
const committedSchema = z.object({ message: z.object({ text: z.string(), author: z.object({ kind: z.string() }) }) });
const historySchema = z.object({ pendingHil: z.object({ requestId: z.string() }).nullable() });
const offeredSchema = z.object({ message: z.object({ text: z.string(), author: z.object({ kind: z.string() }), choices: z.array(z.string()).optional() }) });
const clients = new Set<ReturnType<typeof createMockGatewayClient>>();

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function connectedClient() {
  const client = createMockGatewayClient({ id: "web-mock-test", version: "0.6.0", platform: "browser" });
  clients.add(client);
  await client.connect({ url: "ws://mock", username: "esteve", password: "mock-password" });
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: { search: "?mock=1" }, sessionStorage: memoryStorage(), localStorage: memoryStorage(),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("CloseEvent", class extends Event {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
    constructor(type: string, init: CloseEventInit = {}) {
      super(type, init);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? "";
      this.wasClean = init.wasClean ?? false;
    }
  });
});
afterEach(async () => {
  for (const client of clients) {
    if (client.getStatus().state === "connected") await client.request("proc.abort", { pid: "p-ship" });
    client.disconnect();
  }
  clients.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mock gateway", () => {
  it("answers only when asked for by the query string", () => {
    window.location.search = "";
    expect(mockGatewayRequested()).toBe(false);
    window.location.search = "?mock=1";
    expect(mockGatewayRequested()).toBe(true);
    window.location.search = "";
    expect(mockGatewayRequested()).toBe(true);
  });

  it("transcribes voice without losing the contact fixtures", async () => {
    const client = await connectedClient();
    const transcript = await client.request("ai.transcription.create", { pid: "p-ship", audio: { mimeType: "audio/webm" }, mode: "transcribe" });
    expect(transcript.data).toEqual({
      text: "Can you check the studio backup and tell me if it finished",
      language: "en", duration: 3.2, provider: "mock", model: "mock-transcribe",
    });
    const contacts = await client.request("contact.list", {});
    expect(contacts.data.contacts).toHaveLength(1);
    const inbox = await client.request("conversation.inbox", {});
    expect(inbox.data.entries).toHaveLength(1);
  });

  it("lets the owner choose a language, kept in this browser, and refuses other config", async () => {
    const client = await connectedClient();
    const accounts = z.object({ accounts: z.array(z.object({ relation: z.string(), capabilities: z.array(z.string()).optional() })) })
      .parse((await client.request("account.list", {})).data).accounts;
    expect(accounts.find((account) => account.relation === "self")?.capabilities).toContain("sys.config.set");

    const key = "users/1000/locale/language";
    await client.request("sys.config.set", { key, value: "es" });
    expect((await client.request("sys.config.get", { key })).data).toEqual({ entries: [{ key, value: "es" }] });
    expect((await client.request("sys.config.get", {})).data).toEqual({ entries: [{ key, value: "es" }] });
    expect(window.localStorage.getItem("gsv.mock.language")).toBe("es");
    await expect(client.request("sys.config.set", { key: "users/1000/locale/timezone", value: "Europe/Madrid" }))
      .rejects.toThrow("does not implement sys.config.set");
  });

  it("creates, lists and cancels a place invitation, answering a retried create with the same one", async () => {
    const client = await connectedClient();
    const request = { id: "6f1c2e4a-0b3d-4c5e-8f70-9a1b2c3d4e5f", secret: "a".repeat(64), targetId: "studio-pc", label: "Studio PC" };
    const { pairing } = await client.sys.pair.create(request);
    expect(pairing).toMatchObject({ id: request.id, username: "esteve", targetId: "studio-pc", label: "Studio PC", state: "pending" });
    expect(pairing.expiresAt - pairing.createdAt).toBe(10 * 60 * 1000);
    expect((await client.sys.pair.create(request)).pairing).toEqual(pairing);
    expect((await client.sys.pair.list({})).pairings).toContainEqual(pairing);
    expect((await client.sys.pair.cancel({ id: request.id })).pairing.state).toBe("cancelled");
    expect((await client.sys.pair.list({})).pairings.find((item) => item.id === request.id)?.state).toBe("cancelled");
  });

  it("raises an approval with a purpose on /approve and resolves it with one reply", async () => {
    const client = await connectedClient();
    const signals: Array<[string, JsonValue | undefined]> = [];
    client.onSignal((signal, payload) => signals.push([signal, payload]));
    expect(client.getStatus().state).toBe("connected");

    const sent = await client.request("conversation.send", { conversationId: "c-ship", text: "/approve", idempotencyKey: "k1" });
    expect(sent.data.handlerPid).toBe("p-ship");
    await vi.runAllTimersAsync();
    const raised = signals.find(([signal]) => signal === "proc.run.hil.requested");
    const request = hilSchema.parse(raised?.[1]);
    expect(request).toMatchObject({ syscall: "shell.exec", target: "studio", purpose: "check whether Granola is running and list its windows" });
    expect(request.args.input).toContain("Granola");
    const history = await client.request("proc.history", { pid: request.pid, format: 2, tail: true, limit: 50 });
    expect(historySchema.parse(history.data).pendingHil).toMatchObject({ requestId: request.requestId });

    const decided = await client.request("proc.hil", { pid: request.pid, requestId: request.requestId, decision: "approve" });
    expect(decided.data).toMatchObject({ ok: true, resumed: true });
    await vi.runAllTimersAsync();
    const replies = signals.filter(([signal]) => signal === "message.committed").map(([, payload]) => committedSchema.parse(payload).message);
    expect(replies.at(-1)).toMatchObject({ author: { kind: "process" } });
    expect(replies.at(-1)?.text).toContain("Granola is running");
    expect(signals.some(([signal]) => signal === "proc.run.finished")).toBe(true);
    const after = await client.request("proc.history", { pid: request.pid, format: 2, tail: true, limit: 50 });
    expect(historySchema.parse(after.data).pendingHil).toBeNull();
  });

  it("raises the other approval shapes without a purpose where the trigger says so", async () => {
    const client = await connectedClient();
    const raised: JsonValue[] = [];
    client.onSignal((signal, payload) => { if (signal === "proc.run.hil.requested" && payload !== undefined) raised.push(payload); });
    for (const text of ["/approve-old", "/approve-mail", "/approve-file", "/approve-publish"]) {
      await client.request("conversation.send", { conversationId: "c-ship", text, idempotencyKey: text });
      await vi.runAllTimersAsync();
      const request = hilSchema.parse(raised.at(-1));
      await client.request("proc.hil", { pid: request.pid, requestId: request.requestId, decision: "deny" });
      await vi.runAllTimersAsync();
    }
    expect(raised).toMatchObject([
      { syscall: "shell.exec", target: "studio" },
      { syscall: "mail.send", purpose: expect.stringContaining("Mike") },
      { syscall: "fs.write", target: "studio", purpose: expect.stringContaining("notes") },
      { syscall: "atproto.write", target: "gsv", args: expect.objectContaining({ handle: "esteve", address: "esteve.ship.space" }) },
    ]);
    expect(hilSchema.parse(raised[0])).not.toHaveProperty("purpose");
  });

  it("reads fixture files the way the gateway does: limited text, images, references, and refused binaries", async () => {
    const client = await connectedClient();
    const settle = async <T>(work: Promise<T>) => { await vi.advanceTimersByTimeAsync(1); return await work; };

    const head = await client.request<FsReadResult>("fs.read", { path: "~/notes/sync.log", limit: 50 });
    const text = await settle(bodyToText(head.body!));
    expect(head.data).toMatchObject({ ok: true, path: "/home/esteve/notes/sync.log", kind: "text", contentType: "text/plain", lines: 50, truncated: true, nextOffset: 50 });
    expect(text.split("\n")).toHaveLength(50);
    expect(head.data.ok && "size" in head.data && head.data.size).toBeGreaterThan(new TextEncoder().encode(text).byteLength);

    const capped = await client.request<FsReadResult>("fs.read", { path: "~/notes/sync.log", maxBytes: 200 });
    expect(new TextEncoder().encode(await settle(bodyToText(capped.body!))).byteLength).toBeLessThanOrEqual(200);
    expect(capped.data).toMatchObject({ truncated: true });

    const whole = await settle(requestFsRead(client, { path: "~/notes/backup.sh" }));
    expect(whole).toMatchObject({ kind: "text", contentType: "text/x-shellscript", lines: 25 });
    expect(whole).not.toHaveProperty("truncated");

    const image = await settle(requestFsRead(client, { path: "~/notes/drive.png" }));
    expect(image).toMatchObject({ kind: "image", contentType: "image/png", content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] });

    expect((await client.request("fs.read", { path: "~/notes/studio.pdf" })).data)
      .toEqual({ ok: false, error: "Binary file (application/pdf, 1.2 MB) — not readable as text" });

    const reference = await client.request<FsReadResult>("fs.read", { target: "gsv", path: "/home/esteve/notes/drive.png", representation: "reference" });
    expect(reference.body).toBeUndefined();
    if (!reference.data.ok || !("resource" in reference.data) || !reference.data.resource) throw new Error("no reference");
    expect(reference.data.resource).toEqual({ type: "file", target: "gsv", path: "/home/esteve/notes/drive.png", revision: "mock-1", contentType: "image/png", size: reference.data.size });
    const resource = await settle(readChatResource(client, reference.data.resource));
    expect(resource.blob.size).toBe(reference.data.size);
    expect(Array.from(new Uint8Array(await resource.blob.arrayBuffer()).subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);

    const pdf = await client.request<FsReadResult>("fs.read", { path: "~/notes/studio.pdf", representation: "reference" });
    expect(pdf.data).toMatchObject({ ok: true, kind: "file", contentType: "application/pdf", size: 1_258_291, resource: { revision: "mock-1" } });
  });

  /* The starters sketch keeps its place in the module, so each walk ends it; these stay last in the file. */
  async function startersWalk() {
    const client = await connectedClient();
    const signals: Array<[string, JsonValue | undefined]> = [];
    client.onSignal((signal, payload) => signals.push([signal, payload]));
    const offered: string[][] = [];
    /** Sends one message, tapped or typed, and returns what Ship committed for it and how many runs that took. */
    const say = async (text: string) => {
      const from = signals.length;
      await client.request("conversation.send", { conversationId: "c-ship", text, idempotencyKey: `starters-${from}` });
      await vi.runAllTimersAsync();
      const heard = signals.slice(from);
      const ship = heard.filter(([signal]) => signal === "message.committed")
        .map(([, payload]) => offeredSchema.parse(payload).message).filter((message) => message.author.kind === "process");
      for (const message of ship) if (message.choices) offered.push(message.choices);
      return { ship, text: ship.map((message) => message.text), choices: ship.at(-1)?.choices, runs: heard.filter(([signal]) => signal === "proc.run.finished").length };
    };
    return { say, offered };
  }

  it("walks the starters welcome by taps: a starter, one question, a result in the same run, then where to tell them", async () => {
    const { say, offered } = await startersWalk();

    const opener = await say("/starters");
    expect(opener.text).toEqual(["Hi, I'm Ship.", expect.stringMatching(/Where do we start\? Or just tell me what's on your mind\.$/)]);
    expect(opener.choices).toEqual(["Plan my weekend", "Find the best deal", "Don't let me forget"]);
    expect(opener.runs).toBe(1);

    const where = await say("Plan my weekend");
    expect(where.text).toEqual(["Where will you be?"]);
    expect(where.choices).toEqual([expect.any(String), "Somewhere else"]);
    expect(await say("Somewhere else")).toMatchObject({ text: ["Which city?"], choices: undefined });

    // Ship says what it is doing, keeps working, and the result lands in that same run
    const result = await say("Valencia");
    expect(result.text).toEqual(["Looking at what's on in Valencia this weekend…", expect.stringMatching(/^Three for Saturday in Valencia:/)]);
    expect(result.runs).toBe(1);
    expect(result.choices).toEqual(["Book the first", "Remind me Friday", "Other ideas"]);
    const others = await say("Other ideas");
    expect(others.text).toHaveLength(1);
    expect(others.text[0]).not.toBe(result.text[1]);
    expect(others.choices).toEqual(result.choices);

    const reminder = await say("Remind me Friday");
    expect(reminder.text).toEqual(["Friday at 18:00 I'll send you the plan, and I'll check the forecast first. Where should I tell you?"]);
    expect(reminder.choices).toEqual(["WhatsApp", "Telegram", "Keep it here"]);

    const more = await say("WhatsApp");
    expect(more.text).toEqual(["Done. You'll hear from me on WhatsApp.\n\nWant me to take something else?"]);
    expect(more.choices).toEqual(["Find the best deal", "Don't let me forget", "That's all for now"]);

    expect(await say("That's all for now")).toMatchObject({ text: ["All set. I'm here when you need me."], choices: undefined });
    // the sketch is over: the next message gets the mock's ordinary reply
    expect((await say("thanks")).text).toEqual(["Noted. I will take care of it and let you know when it is done."]);

    // every set of replies fits a messenger's buttons
    expect(offered.every((choices) => choices.length <= 3 && choices.every((choice) => choice.length <= 20))).toBe(true);
  });

  it("takes a typed first answer as the thing to remember, then the other starters until none are left", async () => {
    const { say, offered } = await startersWalk();
    await say("/starters");

    const when = await say("call the dentist");
    expect(when).toMatchObject({ text: ["When should I bring it up?"], choices: ["Tomorrow morning", "This weekend", "Next week"] });
    expect((await say("Next week")).text).toEqual(["Got it. I'll bring it up next week and keep asking until it's done. Where should I tell you?"]);
    const afterReminder = await say("Keep it here");
    expect(afterReminder.text[0]).toMatch(/^Done\. You'll hear from me here\./);
    expect(afterReminder.choices).toEqual(["Plan my weekend", "Find the best deal", "That's all for now"]);

    expect(await say("Find the best deal")).toMatchObject({ text: ["What are you looking to buy?"], choices: undefined });
    const picks = await say("running shoes");
    expect(picks.text).toEqual(["Comparing prices and reviews for running shoes…", expect.stringMatching(/^Three picks for running shoes:/)]);
    expect(picks.runs).toBe(1);
    expect(picks.choices).toEqual(["Watch the price", "Buy the first", "Other options"]);
    expect((await say("Watch the price")).text).toEqual(["I'll check every morning and tell you the moment it drops. Where should I tell you?"]);
    const afterDeal = await say("Telegram");
    expect(afterDeal.text[0]).toMatch(/^Done\. You'll hear from me on Telegram\./);
    expect(afterDeal.choices).toEqual(["Plan my weekend", "That's all for now"]);

    // a typed city is as good as the offered one, and a typed wish about the result still gets a next step
    await say("Plan my weekend");
    expect((await say("Porto")).text[1]).toMatch(/^Three for Saturday in Porto:/);
    const booked = await say("the second one, but later in the day");
    expect(booked.text[0]).toMatch(/Where should I tell you\?$/);
    // with all three taken there is nothing left to offer, and the sketch ends
    expect(await say("Keep it here")).toMatchObject({ text: [expect.stringMatching(/^Done\. You'll hear from me here\./)], choices: undefined });
    expect((await say("thanks")).text).toEqual(["Noted. I will take care of it and let you know when it is done."]);

    expect(offered.every((choices) => choices.length <= 3 && choices.every((choice) => choice.length <= 20))).toBe(true);
  });

  it("wakes a fresh space with the starters welcome: two messages in one run, then the waiting step after the question", async () => {
    // a fresh space is chosen when the module loads, so this one loads its own copy
    vi.resetModules();
    window.location.search = "?mock=1&fresh=starters";
    const freshMock = await import("./mockGateway");
    const client = freshMock.createMockGatewayClient({ id: "web-mock-test", version: "0.6.0", platform: "browser" });
    clients.add(client);
    const signals: Array<[string, JsonValue | undefined]> = [];
    client.onSignal((signal, payload) => signals.push([signal, payload]));
    await client.connect({ url: "ws://mock", username: "esteve", password: "mock-password" });
    await vi.runAllTimersAsync();

    const ship = signals.filter(([signal]) => signal === "message.committed").map(([, payload]) => offeredSchema.parse(payload).message);
    expect(ship.map((message) => message.text)).toEqual(["Hi, I'm Ship.", expect.stringMatching(/Where do we start\? Or just tell me what's on your mind\.$/)]);
    expect(ship[1].choices).toEqual(["Plan my weekend", "Find the best deal", "Don't let me forget"]);
    // the brief's waiting step runs after the question, in the same run: work, not a message
    const order = signals.map(([signal]) => signal);
    expect(order.indexOf("proc.run.tool.started")).toBeGreaterThan(order.lastIndexOf("message.committed"));
    expect(order.filter((signal) => signal === "proc.run.finished")).toHaveLength(1);
    expect(order.indexOf("proc.run.finished")).toBeGreaterThan(order.indexOf("proc.run.tool.finished"));

    // and the question still takes its answer
    await client.request("conversation.send", { conversationId: "c-ship", text: "Plan my weekend", idempotencyKey: "fresh-starters" });
    await vi.runAllTimersAsync();
    const reply = offeredSchema.parse(signals.filter(([signal]) => signal === "message.committed").at(-1)?.[1]).message;
    expect(reply).toMatchObject({ text: "Where will you be?", author: { kind: "process" } });
  });
});
