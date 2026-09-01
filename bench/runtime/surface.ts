import { createHash } from "node:crypto";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
  type ToolDefinition,
} from "@humansandmachines/gsv/protocol";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { hasCapability } from "../../workers/gateway/src/kernel/capabilities";
import { formatContextProjectionEvent } from "../../workers/gateway/src/prompts/context-events";
import {
  contextProjectionsEqual,
  type ContextProjection,
} from "../../workers/gateway/src/process/context/projection";
import {
  missingRunControlCorrectionMessage,
  runControlShellCall,
  type RunControlShellCall,
  withRunControlInstructions,
} from "../../workers/gateway/src/process/run-control-tool";
import { intoSyscallTool } from "../../workers/gateway/src/syscalls";
import { FS_DELETE_DEFINITION } from "../../workers/gateway/src/syscalls/delete";
import { FS_EDIT_DEFINITION } from "../../workers/gateway/src/syscalls/edit";
import { FS_READ_DEFINITION } from "../../workers/gateway/src/syscalls/read";
import { FS_SEARCH_DEFINITION } from "../../workers/gateway/src/syscalls/search";
import { SHELL_EXEC_DEFINITION } from "../../workers/gateway/src/syscalls/shell";
import { FS_WRITE_DEFINITION } from "../../workers/gateway/src/syscalls/write";
import { TOOL_TO_SYSCALL } from "../../workers/gateway/src/syscalls/constants";
import { SyntheticKernel } from "./kernel";
import type {
  GsvSemanticLogEntry,
  GsvSurfaceArtifact,
  GsvSurfaceObservation,
  GsvSurfaceScenario,
} from "./schema";

export type GsvSurfaceModel = (context: Context) => Promise<AssistantMessage>;

const SURFACE_DEFINITIONS: ToolDefinition[] = [
  FS_READ_DEFINITION,
  FS_WRITE_DEFINITION,
  FS_EDIT_DEFINITION,
  FS_DELETE_DEFINITION,
  FS_SEARCH_DEFINITION,
  SHELL_EXEC_DEFINITION,
];

type SurfaceTools = {
  modelTools: Tool[];
  workToolNames: Set<string>;
};

export async function runGsvSurfaceScenario(
  scenario: GsvSurfaceScenario,
  generate: GsvSurfaceModel,
): Promise<GsvSurfaceArtifact> {
  const kernel = SyntheticKernel.fromSpec(scenario.world, scenario.transitions);
  return runSyntheticProcess(
    kernel,
    scenario.entryProcessId,
    scenario.id,
    scenario.systemPrompt,
    scenario.prompt,
    scenario.maxTurns,
    generate,
  );
}

export async function runSyntheticProcess(
  kernel: SyntheticKernel,
  processId: string,
  scenarioId: string,
  systemPrompt: string,
  prompt: string,
  maxTurns: number,
  generate: GsvSurfaceModel,
): Promise<GsvSurfaceArtifact> {
  const process = kernel.process(processId);
  const log: GsvSemanticLogEntry[] = [];
  const observations: GsvSurfaceObservation[] = [];
  const committedMessages: string[] = [];
  const messages: Message[] = [{
    role: "user",
    content: prompt,
    timestamp: 0,
  }];
  const { modelTools, workToolNames } = buildSurfaceTools(process.capabilities);
  let lastProjection = kernel.projection(processId);
  let correctionRounds = 0;
  let timestamp = 1;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const nextProjection = kernel.projection(processId);
    if (!contextProjectionsEqual(lastProjection, nextProjection)) {
      appendContextDelta(
        processId,
        messages,
        log,
        lastProjection,
        nextProjection,
        timestamp,
      );
      timestamp += 1;
      lastProjection = nextProjection;
    }

    const context: Context = {
      systemPrompt,
      messages: structuredClone(messages),
      tools: modelTools,
    };
    observations.push(observation(turn, processId, lastProjection, context));
    const assistant = await generate(context);
    messages.push({ ...assistant, timestamp });
    timestamp += 1;
    const toolCalls = assistant.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    if (toolCalls.length === 0) {
      const text = assistant.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (process.role === "worker") {
        log.push({ type: "run.returned", processId, text });
        return artifact(
          kernel,
          scenarioId,
          processId,
          "returned",
          committedMessages,
          observations,
          log,
          { resultText: text },
        );
      }
      if (correctionRounds === 0) {
        correctionRounds += 1;
        messages.push({
          role: "user",
          content: missingRunControlCorrectionMessage(),
          timestamp,
        });
        timestamp += 1;
        continue;
      }
      return artifact(
        kernel,
        scenarioId,
        processId,
        "invalid_action",
        committedMessages,
        observations,
        log,
        { error: "The model did not yield after correction" },
      );
    }

    const runControlCalls = toolCalls
      .map(runControlShellCall)
      .filter((call): call is RunControlShellCall => call !== null);
    const runControlIds = new Set(
      runControlCalls.map(({ toolCall }) => toolCall.id),
    );
    const workCalls = toolCalls.filter((call) => !runControlIds.has(call.id));
    const combinationInvalid = runControlCalls.length > 1
      || (runControlCalls.length === 1 && workCalls.length > 0);
    if (combinationInvalid) {
      for (const call of toolCalls) {
        const args = parsedArguments(call.arguments);
        log.push({ type: "tool.call", processId, name: call.name, arguments: args });
        appendToolResult(
          messages,
          call,
          "message send and yield must be issued separately from other tool actions",
          true,
          timestamp,
        );
        timestamp += 1;
        log.push({
          type: "tool.result",
          processId,
          name: call.name,
          content: "message send and yield must be issued separately from other tool actions",
          isError: true,
        });
      }
      continue;
    }

    const runControl = runControlCalls[0];
    if (runControl) {
      const args = parsedArguments(runControl.toolCall.arguments);
      log.push({
        type: "tool.call",
        processId,
        name: runControl.toolCall.name,
        arguments: args,
      });
      const result = runControl.parsed;
      if (!result.ok) {
        appendToolResult(
          messages,
          runControl.toolCall,
          result.error,
          true,
          timestamp,
        );
        timestamp += 1;
        log.push({
          type: "tool.result",
          processId,
          name: "Shell",
          content: result.error,
          isError: true,
        });
        continue;
      }
      if (result.command.action === "message") {
        committedMessages.push(result.command.text);
        log.push({
          type: "message.committed",
          processId,
          text: result.command.text,
        });
        const content = result.command.finish
          ? "Message committed and run yielded"
          : "Message committed; run remains active";
        appendToolResult(
          messages,
          runControl.toolCall,
          content,
          false,
          timestamp,
        );
        timestamp += 1;
        log.push({
          type: "tool.result",
          processId,
          name: "Shell",
          content,
          isError: false,
        });
        if (result.command.finish) {
          log.push({ type: "run.yielded", processId });
          return artifact(
            kernel,
            scenarioId,
            processId,
            "yielded",
            committedMessages,
            observations,
            log,
          );
        }
        continue;
      }

      appendToolResult(
        messages,
        runControl.toolCall,
        "Run yielded",
        false,
        timestamp,
      );
      log.push({
        type: "tool.result",
        processId,
        name: "Shell",
        content: "Run yielded",
        isError: false,
      });
      log.push({ type: "run.yielded", processId });
      return artifact(
        kernel,
        scenarioId,
        processId,
        "yielded",
        committedMessages,
        observations,
        log,
      );
    }

    for (const call of workCalls) {
      const parsed = jsonObjectSchema.safeParse(call.arguments);
      const args = parsed.success ? parsed.data : {};
      log.push({ type: "tool.call", processId, name: call.name, arguments: args });
      if (!parsed.success || !workToolNames.has(call.name)) {
        const content = parsed.success
          ? 'Tool "' + call.name + '" was not offered for this generation'
          : "Tool arguments must be a JSON object";
        appendToolResult(messages, call, content, true, timestamp);
        timestamp += 1;
        log.push({
          type: "tool.result",
          processId,
          name: call.name,
          content,
          isError: true,
        });
        continue;
      }

      const result = await kernel.dispatch(processId, call.name, args);
      const content = stringifyToolResult(result.value);
      appendToolResult(messages, call, content, result.isError, timestamp);
      timestamp += 1;
      log.push({
        type: "tool.result",
        processId,
        name: call.name,
        content,
        isError: result.isError,
      });
      for (const id of result.transitionsApplied) {
        log.push({ type: "world.transition", id });
      }
    }
  }

  return artifact(
    kernel,
    scenarioId,
    processId,
    "max_turns",
    committedMessages,
    observations,
    log,
    { error: "Model did not finish within " + maxTurns + " turns" },
  );
}

function buildSurfaceTools(capabilities: readonly string[]): SurfaceTools {
  const workTools = SURFACE_DEFINITIONS
    .filter((definition) => {
      const syscall = TOOL_TO_SYSCALL[definition.name];
      return syscall !== undefined && hasCapability([...capabilities], syscall);
    })
    .map((definition) => intoSyscallTool(definition))
    .map((definition): Tool => ({
      name: definition.name,
      description: definition.description,
      // SAFETY: protocol-owned tool definitions provide the JSON Schema shape
      // accepted by pi-ai, matching the production Process adapter.
      parameters: definition.inputSchema as Tool["parameters"],
    }));
  return {
    modelTools: withRunControlInstructions(workTools),
    workToolNames: new Set(workTools.map(({ name }) => name)),
  };
}

function appendContextDelta(
  processId: string,
  messages: Message[],
  log: GsvSemanticLogEntry[],
  previous: ContextProjection,
  current: ContextProjection,
  timestamp: number,
): void {
  const event = formatContextProjectionEvent(previous, current);
  if (!event) throw new Error("Synthetic context projection changed without an event");
  const content = "[GSV EVENT]\n" + event;
  messages.push({ role: "user", content, timestamp });
  log.push({ type: "context.delta", processId, content });
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

function observation(
  turn: number,
  processId: string,
  projection: ContextProjection,
  context: Context,
): GsvSurfaceObservation {
  return {
    turn,
    processId,
    systemPromptSha256: createHash("sha256")
      .update(context.systemPrompt ?? "")
      .digest("hex"),
    projection: structuredClone(projection),
    messages: structuredClone(context.messages),
    tools: structuredClone(context.tools ?? []),
  };
}

function parsedArguments(value: ToolCall["arguments"]): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function stringifyToolResult(value: JsonValue): string {
  const text = z.string().safeParse(value);
  return text.success
    ? text.data
    : JSON.stringify(value, null, 2) ?? "null";
}

function artifact(
  kernel: SyntheticKernel,
  scenarioId: string,
  entryProcessId: string,
  status: GsvSurfaceArtifact["status"],
  committedMessages: string[],
  observations: GsvSurfaceObservation[],
  log: GsvSemanticLogEntry[],
  options: Pick<GsvSurfaceArtifact, "error" | "resultText"> = {},
): GsvSurfaceArtifact {
  const result: GsvSurfaceArtifact = {
    schemaVersion: 2,
    scenarioId,
    entryProcessId,
    status,
    committedMessages,
    observations,
    log,
    world: kernel.snapshot(),
  };
  if (options.error !== undefined) result.error = options.error;
  if (options.resultText !== undefined) result.resultText = options.resultText;
  return result;
}
