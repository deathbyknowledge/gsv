import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { formatContextProjectionEvent } from "../../workers/gateway/src/prompts/context-events";
import { parseRunControlCommand } from "../../workers/gateway/src/process/run-control-command";
import { withRunControlInstructions } from "../../workers/gateway/src/process/run-control-tool";
import { intoSyscallTool } from "../../workers/gateway/src/syscalls";
import { SHELL_EXEC_DEFINITION } from "../../workers/gateway/src/syscalls/shell";
import type {
  GsvSemanticLogEntry,
  GsvSurfaceArtifact,
  GsvSurfaceObservation,
  GsvSurfaceScenario,
} from "./schema";

export type GsvSurfaceModel = (context: Context) => Promise<AssistantMessage>;

const surfaceShellArgsSchema = z.object({ input: z.string() }).passthrough();

export async function runGsvSurfaceScenario(
  scenario: GsvSurfaceScenario,
  generate: GsvSurfaceModel,
): Promise<GsvSurfaceArtifact> {
  const log: GsvSemanticLogEntry[] = [];
  const observations: GsvSurfaceObservation[] = [];
  const committedMessages: string[] = [];
  const messages: Message[] = [{
    role: "user",
    content: scenario.prompt,
    timestamp: 0,
  }];
  const tools = buildSurfaceTools();
  let transitionInjected = false;

  for (let turn = 1; turn <= scenario.maxTurns; turn += 1) {
    const context: Context = {
      systemPrompt: scenario.systemPrompt,
      messages: structuredClone(messages),
      tools,
    };
    observations.push(observation(turn, context));
    const assistant = await generate(context);
    messages.push({ ...assistant, timestamp: turn * 3 - 2 });
    const toolCalls = assistant.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCalls.length !== 1) {
      return failedArtifact(
        scenario.id,
        transitionInjected,
        committedMessages,
        observations,
        log,
        `Expected exactly one tool call, received ${toolCalls.length}`,
      );
    }

    const call = toolCalls[0];
    const input = shellInput(call);
    if (input === null) {
      return failedArtifact(
        scenario.id,
        transitionInjected,
        committedMessages,
        observations,
        log,
        "Expected a Shell tool call with a string input",
      );
    }
    log.push({ type: "tool.call", name: "Shell", input });

    const runControl = parseRunControlCommand(input);
    if (runControl) {
      if (!runControl.ok) {
        appendToolResult(messages, call, runControl.error, true, turn * 3 - 1);
        log.push({
          type: "tool.result",
          name: "Shell",
          content: runControl.error,
          isError: true,
        });
        continue;
      }
      if (runControl.command.action === "message") {
        committedMessages.push(runControl.command.text);
        log.push({
          type: "message.committed",
          text: runControl.command.text,
        });
        const content = runControl.command.finish
          ? "Message committed and run yielded"
          : "Message committed; run remains active";
        appendToolResult(messages, call, content, false, turn * 3 - 1);
        log.push({
          type: "tool.result",
          name: "Shell",
          content,
          isError: false,
        });
        if (runControl.command.finish) {
          log.push({ type: "run.yielded" });
          return {
            schemaVersion: 1,
            scenarioId: scenario.id,
            status: "yielded",
            transitionInjected,
            committedMessages,
            observations,
            log,
          };
        }
        continue;
      }

      appendToolResult(messages, call, "Run yielded", false, turn * 3 - 1);
      log.push({
        type: "tool.result",
        name: "Shell",
        content: "Run yielded",
        isError: false,
      });
      log.push({ type: "run.yielded" });
      return {
        schemaVersion: 1,
        scenarioId: scenario.id,
        status: "yielded",
        transitionInjected,
        committedMessages,
        observations,
        log,
      };
    }

    const configuredResult = scenario.shellResults[input];
    const isError = configuredResult === undefined;
    const content = configuredResult
      ?? `Synthetic Shell has no result configured for: ${input}`;
    appendToolResult(messages, call, content, isError, turn * 3 - 1);
    log.push({
      type: "tool.result",
      name: "Shell",
      content,
      isError,
    });

    if (
      !transitionInjected
      && call.name === scenario.transition.trigger.tool
      && input === scenario.transition.trigger.input
    ) {
      const event = formatContextProjectionEvent(
        scenario.initialProjection,
        scenario.transition.projection,
      );
      if (!event) throw new Error("Scenario transition produced no context event");
      const content = `[GSV EVENT]\n${event}`;
      messages.push({ role: "user", content, timestamp: turn * 3 });
      log.push({ type: "context.delta", content });
      transitionInjected = true;
    }
  }

  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    status: "max_turns",
    transitionInjected,
    committedMessages,
    observations,
    log,
    error: `Model did not yield within ${scenario.maxTurns} turns`,
  };
}

function buildSurfaceTools(): Tool[] {
  const definition = intoSyscallTool(SHELL_EXEC_DEFINITION);
  // SAFETY: the protocol-owned syscall definition contains the JSON Schema shape
  // accepted by pi-ai's Tool boundary; the production Process uses the same adapter.
  return withRunControlInstructions([{
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
  } as Tool]);
}

function shellInput(call: ToolCall): string | null {
  if (call.name !== "Shell") return null;
  const parsed = surfaceShellArgsSchema.safeParse(call.arguments);
  return parsed.success ? parsed.data.input : null;
}

function appendToolResult(
  messages: Message[],
  call: ToolCall,
  content: string,
  isError: boolean,
  timestamp: number,
): void {
  messages.push({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: content }],
    isError,
    timestamp,
  } satisfies ToolResultMessage);
}

function observation(turn: number, context: Context): GsvSurfaceObservation {
  return {
    turn,
    systemPromptSha256: createHash("sha256")
      .update(context.systemPrompt ?? "")
      .digest("hex"),
    messages: structuredClone(context.messages),
    tools: structuredClone(context.tools ?? []),
  };
}

function failedArtifact(
  scenarioId: string,
  transitionInjected: boolean,
  committedMessages: string[],
  observations: GsvSurfaceObservation[],
  log: GsvSemanticLogEntry[],
  error: string,
): GsvSurfaceArtifact {
  return {
    schemaVersion: 1,
    scenarioId,
    status: "invalid_action",
    transitionInjected,
    committedMessages,
    observations,
    log,
    error,
  };
}
