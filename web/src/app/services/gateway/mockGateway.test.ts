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
    for (const text of ["/approve-old", "/approve-mail", "/approve-file"]) {
      await client.request("conversation.send", { conversationId: "c-ship", text, idempotencyKey: text });
      await vi.runAllTimersAsync();
      const request = hilSchema.parse(raised.at(-1));
      await client.request("proc.hil", { pid: request.pid, requestId: request.requestId, decision: "deny" });
      await vi.runAllTimersAsync();
    }
    expect(raised.map((payload) => hilSchema.parse(payload))).toMatchObject([
      { syscall: "shell.exec", target: "studio" },
      { syscall: "mail.send", purpose: expect.stringContaining("Mike") },
      { syscall: "fs.write", target: "studio", purpose: expect.stringContaining("notes") },
    ]);
    expect(hilSchema.parse(raised[0])).not.toHaveProperty("purpose");
  });
});
