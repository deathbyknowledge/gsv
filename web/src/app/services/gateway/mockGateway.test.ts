import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { createMockGatewayClient, mockGatewayRequested } from "./mockGateway";

const hilSchema = z.object({ pid: z.string(), requestId: z.string(), syscall: z.string(), target: z.string(), purpose: z.string().optional(), args: z.object({ input: z.string().optional() }) });
const committedSchema = z.object({ message: z.object({ text: z.string(), author: z.object({ kind: z.string() }) }) });
const historySchema = z.object({ pendingHil: z.object({ requestId: z.string() }).nullable() });
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
});
