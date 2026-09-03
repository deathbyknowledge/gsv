import { describe, expect, it } from "vitest";
import {
  okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq,
} from "./do-test-harness";

describe("proc.history", () => {
  it("respects limit and offset", async () => {
    const pid = "mech-history-2";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      for (let i = 0; i < 10; i++) {
        store.messages.appendMessage("user", `msg-${i}`);
      }
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", { limit: 3, offset: 2 }));

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.messages).toHaveLength(3);
    expect(data.messageCount).toBe(10);
    expect(data.truncated).toBe(true);
  });

  it("keeps proc.history paged by default", async () => {
    const pid = "mech-history-default-page";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      for (let i = 0; i < 205; i++) {
        store.messages.appendMessage("user", `msg-${i}`);
      }
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", {}));

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.messages).toHaveLength(200);
    expect(data.messageCount).toBe(205);
    expect(data.truncated).toBe(true);
  });

  it("returns runtime status without reading Process activity", async () => {
    const stub = await initProcess("mech-history-status-only", ROOT_IDENTITY);
    await runInProcess(stub, (process) => {
      process.store.messages.appendMessage("user", "private Process activity", {
        runId: "run-status-only",
      });
      process.runs.active = { runId: "run-status-only" };
    });

    const response = await okProcessResponse(
      stub,
      makeReq("proc.history", {
        includeMessages: false,
        tail: true,
        limit: 50,
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(response.data).toMatchObject({
      ok: true,
      activeRunId: "run-status-only",
      messageCount: 1,
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it("supports tail-first and cursor history pagination", async () => {
    const pid = "mech-history-tail-page";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      for (let i = 0; i < 10; i++) {
        store.messages.appendMessage("user", `msg-${i}`);
      }
    });

    const tailRes = await okProcessResponse(
      stub,
      makeReq("proc.history", { tail: true, limit: 3 }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const tailData = tailRes.data as any;
    expect(tailData.messages.map((message: any) => message.content)).toEqual([
      "msg-7",
      "msg-8",
      "msg-9",
    ]);
    expect(tailData.hasMoreBefore).toBe(true);
    expect(tailData.hasMoreAfter).toBe(false);
    expect(tailData.truncated).toBe(true);

    const beforeRes = await okProcessResponse(
      stub,
      makeReq("proc.history", { beforeMessageId: tailData.messages[0].id, limit: 3 }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const beforeData = beforeRes.data as any;
    expect(beforeData.messages.map((message: any) => message.content)).toEqual([
      "msg-4",
      "msg-5",
      "msg-6",
    ]);
    expect(beforeData.hasMoreBefore).toBe(true);
    expect(beforeData.hasMoreAfter).toBe(true);

    const afterRes = await okProcessResponse(
      stub,
      makeReq("proc.history", { afterMessageId: beforeData.messages[2].id, limit: 2 }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const afterData = afterRes.data as any;
    expect(afterData.messages.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
    expect(afterData.hasMoreBefore).toBe(true);
    expect(afterData.hasMoreAfter).toBe(true);
  });

  it("exposes active run metadata for restore-time controls", async () => {
    const pid = "mech-history-active-run";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      process.runs.active = {
        runId: "run-history-active",
      };
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", {}));

    expect(res.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.activeRunId).toBe("run-history-active");
    expect(data).not.toHaveProperty("activeConversationId");
  });

  it("includes full toolResult payload (metadata + output)", async () => {
    const pid = "mech-history-toolresult";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendToolResult(
        "call-1",
        "fs.read",
        "file contents here",
        false,
        "run-history-tool",
        "completed",
      );
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", {}));

    expect(res.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe("toolResult");
    expect(data.messages[0].runId).toBe("run-history-tool");
    expect(data.messages[0].content).toEqual({
      toolName: "Read",
      isError: false,
      outcome: "completed",
      toolCallId: "call-1",
      output: "file contents here",
    });
  });

  it("normalizes legacy user-controlled tool outcomes", async () => {
    const pid = "mech-history-toolresult-legacy-outcomes";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendToolResult(
        "call-cancelled",
        "fs.read",
        "Error: User interrupted tool execution",
        true,
      );
      store.messages.appendToolResult(
        "call-denied",
        "fs.write",
        "Error: Tool execution denied by user",
        true,
      );
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", {}));

    expect(res.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.messages.map((message: any) => message.content.outcome)).toEqual([
      "cancelled",
      "denied",
    ]);
  });

  it("includes assistant thinking blocks when present", async () => {
    const pid = "mech-history-thinking";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("assistant", "Let me inspect that.", {
        runId: "run-history-thinking",
        toolCalls: JSON.stringify({
          thinking: [{ type: "thinking", thinking: "Need to inspect config before answering." }],
          toolCalls: [
            { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
          ],
        }),
      });
    });

    const res = await okProcessResponse(stub, makeReq("proc.history", {}));

    expect(res.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe("assistant");
    expect(data.messages[0].runId).toBe("run-history-thinking");
    expect(data.messages[0].content).toEqual({
      text: "Let me inspect that.",
      thinking: [{ type: "thinking", thinking: "Need to inspect config before answering." }],
      toolCalls: [
        { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
      ],
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
  });
});
