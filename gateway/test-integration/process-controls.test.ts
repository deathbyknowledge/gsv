import { describe, expect, it } from "vitest";
import type { ProcHistoryResult } from "@humansandmachines/gsv/protocol";
import {
  startProcessRuntimeHarness,
  type ProcessRuntimeHarness,
} from "./process-runtime-harness";

describe("gateway process controls integration", () => {
  it("executes a deterministic Read tool call before the final response", async () => {
    await withRuntime(async (runtime) => {
      const path = "/tmp/process-integration-read.txt";
      const fileContent = "The deterministic word is banana.";
      const written = await runtime.client.fs.write({ path, content: fileContent });
      expect(written).toMatchObject({ ok: true, path });

      runtime.ai.enqueue(
        {
          kind: "tool-calls",
          calls: [{
            id: "read-call-1",
            name: "Read",
            arguments: { path },
          }],
        },
        { kind: "message", text: "banana" },
      );

      const process = await runtime.spawn("deterministic read journey");
      await runtime.configureAi(process.pid);
      const sent = await runtime.client.proc.send({
        pid: process.pid,
        message: "Read the deterministic file.",
      });
      if (!sent.ok) throw new Error(sent.error);

      await waitForFinished(runtime, sent.runId);

      expect(runtime.signals).toContainEqual(expect.objectContaining({
        signal: "proc.run.tool.started",
        payload: expect.objectContaining({
          pid: process.pid,
          runId: sent.runId,
          callId: "read-call-1",
          name: "Read",
          syscall: "fs.read",
          args: expect.objectContaining({ path }),
        }),
      }));
      const streamEvents = runtime.signals
        .filter(({ signal, payload }) => signal === "proc.run.stream" && payload.runId === sent.runId)
        .map(({ payload }) => asRecord(payload.event)?.type);
      expect(streamEvents.filter((type) => type === "toolcall_start")).toHaveLength(2);
      expect(streamEvents.filter((type) => type === "toolcall_end")).toHaveLength(2);
      expect(streamEvents.filter((type) => type === "done")).toHaveLength(2);

      const history = await processHistory(runtime, process.pid);
      expect(history).toMatchObject({
        messageCount: 5,
        activeRunId: null,
        pendingHil: null,
      });
      expect(history.messages).toEqual([
        expect.objectContaining({
          role: "user",
          runId: sent.runId,
          content: "Read the deterministic file.",
        }),
        expect.objectContaining({
          role: "assistant",
          runId: sent.runId,
          content: expect.objectContaining({
            toolCalls: [{
              type: "toolCall",
              id: "read-call-1",
              name: "Read",
              arguments: { path },
            }],
          }),
        }),
        expect.objectContaining({
          role: "toolResult",
          runId: sent.runId,
          content: expect.objectContaining({
            toolName: "Read",
            toolCallId: "read-call-1",
            isError: false,
            outcome: "completed",
            output: expect.stringContaining("banana"),
          }),
        }),
        expect.objectContaining({
          role: "assistant",
          runId: sent.runId,
          content: expect.objectContaining({
            toolCalls: [expect.objectContaining({
              name: "Message",
              arguments: { text: "banana" },
            })],
          }),
        }),
        expect.objectContaining({
          role: "toolResult",
          runId: sent.runId,
          content: expect.objectContaining({
            toolName: "Message",
            outcome: "completed",
            output: "Message committed",
          }),
        }),
      ]);

      expect(runtime.ai.requests).toHaveLength(2);
      expect(runtime.ai.requests[0]).toMatchObject({
        usesFixtureCredential: true,
        model: "integration-model",
        stream: true,
        messageCount: expect.any(Number),
        toolCount: expect.any(Number),
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "Read" }),
          }),
        ]),
      });
      expect(runtime.ai.requests[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [expect.objectContaining({
            id: "read-call-1",
            function: expect.objectContaining({ name: "Read" }),
          })],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "read-call-1",
          content: expect.stringContaining("banana"),
        }),
      ]));
    });
  });

  const hilCases = [
    {
      title: "approves a Shell syscall nested in CodeMode",
      decision: "approve" as const,
      toolCall: {
        id: "codemode-call-1",
        name: "CodeMode",
        arguments: {
          code: 'return await shell("printf codemode-approved");',
        },
      },
      pendingInput: "printf codemode-approved",
      expectedToolName: "CodeMode",
      expectedOutcome: "completed",
      expectedToolOutput: "codemode-approved",
      finalText: "approved",
    },
    {
      title: "denies a direct Shell syscall",
      decision: "deny" as const,
      toolCall: {
        id: "shell-call-1",
        name: "Shell",
        arguments: {
          input: "printf should-not-run",
        },
      },
      pendingInput: "printf should-not-run",
      expectedToolName: "Shell",
      expectedOutcome: "denied",
      expectedToolOutput: "Tool execution denied by user",
      finalText: "denied",
    },
  ];

  for (const scenario of hilCases) {
    it(scenario.title, async () => {
      await withRuntime(async (runtime) => {
        runtime.ai.enqueue(
          { kind: "tool-calls", calls: [scenario.toolCall] },
          { kind: "message", text: scenario.finalText },
        );

        const process = await runtime.spawn(`HIL ${scenario.decision} journey`);
        await runtime.configureAi(process.pid);
        const sent = await runtime.client.proc.send({
          pid: process.pid,
          message: `Exercise the ${scenario.decision} path.`,
        });
        if (!sent.ok) throw new Error(sent.error);

        await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
          signal === "proc.run.hil.requested" && payload.runId === sent.runId
        ), "HIL request signal");

        const paused = await processHistory(runtime, process.pid);
        expect(paused.activeRunId).toBe(sent.runId);
        expect(paused.pendingHil).toMatchObject({
          pid: process.pid,
          runId: sent.runId,
          toolName: "Shell",
          syscall: "shell.exec",
          args: expect.objectContaining({
            input: scenario.pendingInput,
          }),
        });
        if (!paused.pendingHil) throw new Error("Process did not expose its pending HIL request");

        const decided = await runtime.client.proc.hil({
          pid: process.pid,
          requestId: paused.pendingHil.requestId,
          decision: scenario.decision,
        });
        expect(decided).toMatchObject({
          ok: true,
          pid: process.pid,
          requestId: paused.pendingHil.requestId,
          decision: scenario.decision,
          resumed: true,
          pendingHil: null,
        });

        await waitForFinished(runtime, sent.runId);
        const history = await processHistory(runtime, process.pid);
        expect(history.pendingHil).toBeNull();
        expect(history.activeRunId).toBeNull();
        const toolResult = history.messages.find(({ role }) => role === "toolResult");
        expect(toolResult).toMatchObject({
          role: "toolResult",
          runId: sent.runId,
          content: expect.objectContaining({
            toolName: scenario.expectedToolName,
            outcome: scenario.expectedOutcome,
            output: expect.stringContaining(scenario.expectedToolOutput),
          }),
        });
        expect(history.messages.at(-2)).toMatchObject({
          role: "assistant",
          runId: sent.runId,
          content: expect.objectContaining({
            toolCalls: [expect.objectContaining({
              name: "Message",
              arguments: { text: scenario.finalText },
            })],
          }),
        });
        expect(history.messages.at(-1)).toMatchObject({
          role: "toolResult",
          runId: sent.runId,
          content: expect.objectContaining({
            toolName: "Message",
            output: "Message committed",
          }),
        });
        expect(runtime.ai.requests).toHaveLength(2);
        expect(runtime.ai.requests[1]?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            content: expect.stringContaining(scenario.expectedToolOutput),
          }),
        ]));
      });
    });
  }

  it("queues process IPC while the target generation is blocked", async () => {
    await withRuntime(async (runtime) => {
      const held = runtime.ai.hold({
        kind: "message",
        text: "foreground complete",
      });
      runtime.ai.enqueue({
        kind: "message",
        text: "queued complete",
      });

      const target = await runtime.spawn("blocked IPC target");
      const sender = await runtime.spawn("IPC sender");
      await runtime.client.proc.observe({ pid: target.pid });
      await runtime.configureAi(target.pid);
      const foreground = await runtime.client.proc.send({
        pid: target.pid,
        message: "hold the foreground generation",
      });
      if (!foreground.ok) throw new Error(foreground.error);

      await runtime.ai.waitForRequests(1);
      await held.started;
      expect(await processHistory(runtime, target.pid)).toMatchObject({
        activeRunId: foreground.runId,
        messageCount: 1,
      });

      const ipcMessage = "queued process input";
      const ipcCommand = `proc send ${target.pid} ${ipcMessage}`;
      const delivered = await runtime.client.codemode.run({
        pid: sender.pid,
        target: "gsv",
        code: `return await shell(${JSON.stringify(ipcCommand)});`,
      });
      expect(delivered).toMatchObject({
        status: "completed",
        result: expect.objectContaining({
          status: "completed",
          exitCode: 0,
          output: expect.stringContaining("queued=true"),
        }),
      });
      const output = String(asRecord(delivered.status === "completed" ? delivered.result : null)?.output ?? "");
      const queuedRunId = /run_id=([^\s]+)/.exec(output)?.[1];
      expect(queuedRunId).toEqual(expect.any(String));
      if (!queuedRunId) throw new Error("proc send did not report the queued run id");
      expect(queuedRunId).not.toBe(foreground.runId);

      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.changed"
        && payload.pid === target.pid
        && payload.enqueuedRunId === queuedRunId
      ), "queued process change signal");
      expect(runtime.signals).toContainEqual(expect.objectContaining({
        signal: "proc.changed",
        payload: expect.objectContaining({
          pid: target.pid,
          changes: ["queue"],
          enqueuedRunId: queuedRunId,
          queuedCount: 1,
        }),
      }));
      expect(await processHistory(runtime, target.pid)).toMatchObject({
        activeRunId: foreground.runId,
        messageCount: 1,
      });

      held.release();
      await runtime.waitFor(() => [foreground.runId, queuedRunId].every((runId) =>
        runtime.signals.some(({ signal, payload }) =>
          signal === "proc.run.finished" && payload.runId === runId
        )
      ), "foreground and queued process runs to finish");

      const history = await processHistory(runtime, target.pid);
      expect(history).toMatchObject({
        activeRunId: null,
        messageCount: 6,
      });
      expect(history.messages[0]).toMatchObject({
        role: "user",
        runId: foreground.runId,
        content: "hold the foreground generation",
      });
      expect(history.messages[1]).toMatchObject({
        role: "assistant",
        runId: foreground.runId,
        content: expect.objectContaining({
          toolCalls: [expect.objectContaining({ name: "Message" })],
        }),
      });
      expect(history.messages[2]).toMatchObject({
        role: "toolResult",
        runId: foreground.runId,
        content: expect.objectContaining({ toolName: "Message" }),
      });
      expect(history.messages[3]).toMatchObject({
        role: "user",
        runId: queuedRunId,
        content: expect.stringContaining(ipcMessage),
        origin: expect.objectContaining({
          kind: "process",
          sourcePid: sender.pid,
        }),
      });
      expect(history.messages[4]).toMatchObject({
        role: "assistant",
        runId: queuedRunId,
        content: expect.objectContaining({
          toolCalls: [expect.objectContaining({ name: "Message" })],
        }),
      });
      expect(history.messages[5]).toMatchObject({
        role: "toolResult",
        runId: queuedRunId,
        content: expect.objectContaining({ toolName: "Message" }),
      });
      expect(runtime.ai.requests).toHaveLength(2);
      expect(runtime.ai.requests[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(ipcMessage),
        }),
      ]));
    });
  });

  it("finishes a run after a deterministic provider error", async () => {
    await withRuntime(async (runtime) => {
      runtime.ai.enqueue({
        kind: "error",
        status: 401,
        message: "fixture rejected credential",
        code: "invalid_api_key",
      });
      const process = await runtime.spawn("provider error journey");
      await runtime.configureAi(process.pid);
      const sent = await runtime.client.proc.send({
        pid: process.pid,
        message: "trigger the fixture error",
      });
      if (!sent.ok) throw new Error(sent.error);

      await waitForFinished(runtime, sent.runId);
      expect(runtime.signals).toContainEqual(expect.objectContaining({
        signal: "proc.run.finished",
        payload: expect.objectContaining({
          pid: process.pid,
          runId: sent.runId,
          status: "error",
          text: null,
        }),
      }));
      const history = await processHistory(runtime, process.pid);
      expect(history).toMatchObject({
        activeRunId: null,
        messageCount: 2,
      });
      expect(history.messages).toEqual([
        expect.objectContaining({ role: "user", runId: sent.runId }),
        expect.objectContaining({
          role: "system",
          runId: sent.runId,
          content: expect.stringContaining("Generation failed"),
        }),
      ]);
      expect(runtime.ai.requests).toHaveLength(1);
      expect(runtime.ai.requests[0]).toMatchObject({
        usesFixtureCredential: true,
        model: "integration-model",
        stream: true,
      });
    });
  });
});

async function withRuntime(
  test: (runtime: ProcessRuntimeHarness) => Promise<void>,
): Promise<void> {
  const runtime = await startProcessRuntimeHarness();
  try {
    await test(runtime);
  } finally {
    await runtime.close();
  }
}

async function waitForFinished(
  runtime: ProcessRuntimeHarness,
  runId: string,
): Promise<void> {
  await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
    signal === "proc.run.finished" && payload.runId === runId
  ), `process run ${runId} to finish`);
}

async function processHistory(
  runtime: ProcessRuntimeHarness,
  pid: string,
): Promise<Extract<ProcHistoryResult, { ok: true }>> {
  const history = await runtime.client.proc.history({ pid });
  if (!history.ok) throw new Error(history.error);
  return history;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
