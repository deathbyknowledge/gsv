import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { createMockGateway, mockGatewayRequested } from "./mockGateway";

const hilSchema = z.object({ requestId: z.string(), syscall: z.string(), target: z.string(), purpose: z.string().optional(), args: z.object({ input: z.string().optional() }) });
const committedSchema = z.object({ message: z.object({ text: z.string(), author: z.object({ kind: z.string() }) }) });
const historySchema = z.object({ pendingHil: z.object({ requestId: z.string() }).nullable() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { search: "?mock=1" }, sessionStorage: new Map<string, string>(), localStorage: { setItem: () => {} } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mock gateway", () => {
  it("answers only when asked for by the query string", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { location: { search: "" }, sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
    expect(mockGatewayRequested()).toBe(false);
    vi.stubGlobal("window", { location: { search: "?mock=1" }, sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
    expect(mockGatewayRequested()).toBe(true);
    vi.stubGlobal("window", { location: { search: "" }, sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
    expect(mockGatewayRequested()).toBe(true);
  });

  it("raises an approval with a purpose on /approve and resolves it with one reply", async () => {
    const client = createMockGateway();
    const signals: Array<[string, JsonValue | undefined]> = [];
    client.onSignal((signal, payload) => signals.push([signal, payload]));
    await client.connect({ url: "mock://gsv" });
    expect(client.getStatus().state).toBe("connected");

    const sent = await client.request("conversation.send", { conversationId: "canonical-ship", text: "/approve", idempotencyKey: "k1" });
    expect(sent.data.handlerPid).toBe("ship");
    await vi.advanceTimersByTimeAsync(1_000);
    const raised = signals.find(([signal]) => signal === "proc.run.hil.requested");
    const request = hilSchema.parse(raised?.[1]);
    expect(request).toMatchObject({ syscall: "shell.exec", target: "my-mac", purpose: "check whether Granola is running and list its windows" });
    expect(request.args.input).toContain("Granola");
    const history = await client.request("proc.history", { pid: "ship", format: 2, tail: true, limit: 50 });
    expect(historySchema.parse(history.data).pendingHil).toMatchObject({ requestId: request.requestId });

    const decided = await client.request("proc.hil", { pid: "ship", requestId: request.requestId, decision: "approve" });
    expect(decided.data).toMatchObject({ ok: true, resumed: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const replies = signals.filter(([signal]) => signal === "message.committed").map(([, payload]) => committedSchema.parse(payload).message);
    expect(replies.at(-1)).toMatchObject({ author: { kind: "process" } });
    expect(replies.at(-1)?.text).toContain("Granola is running");
    expect(signals.some(([signal]) => signal === "proc.run.finished")).toBe(true);
    const after = await client.request("proc.history", { pid: "ship", format: 2, tail: true, limit: 50 });
    expect(historySchema.parse(after.data).pendingHil).toBeNull();
  });

  it("raises the other approval shapes without a purpose where the trigger says so", async () => {
    const client = createMockGateway();
    const raised: JsonValue[] = [];
    client.onSignal((signal, payload) => { if (signal === "proc.run.hil.requested" && payload !== undefined) raised.push(payload); });
    for (const text of ["/approve-old", "/approve-mail", "/approve-file"]) {
      await client.request("conversation.send", { conversationId: "canonical-ship", text, idempotencyKey: text });
      await vi.advanceTimersByTimeAsync(1_000);
      const request = hilSchema.parse(raised.at(-1));
      await client.request("proc.hil", { pid: "ship", requestId: request.requestId, decision: "deny" });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(raised.map((payload) => hilSchema.parse(payload))).toMatchObject([
      { syscall: "shell.exec", target: "my-mac" },
      { syscall: "mail.send", purpose: expect.stringContaining("Mike") },
      { syscall: "fs.write", target: "my-mac", purpose: expect.stringContaining("Notes") },
    ]);
    expect(hilSchema.parse(raised[0])).not.toHaveProperty("purpose");
  });
});
