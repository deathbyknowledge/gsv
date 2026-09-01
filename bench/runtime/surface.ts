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
  formatResponsibilityBaseline,
  formatResponsibilityTransitionEvent,
} from "../../workers/gateway/src/process/responsibility-context";
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
import {
  SyntheticKernel,
  type SyntheticDelegateRunRequest,
  type SyntheticProcessRunOutcome,
} from "./kernel";
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
  if (scenario.entryRoute) {
    kernel.bindAdapterIngress(scenario.entryProcessId, scenario.entryRoute);
  }
  const episode = new SyntheticEpisode(
    kernel,
    scenario.id,
    scenario.entryProcessId,
    generate,
  );
  const outcome = await episode.runProcess({
    processId: scenario.entryProcessId,
    systemPrompt: scenario.systemPrompt,
    prompt: scenario.prompt,
    maxTurns: scenario.maxTurns,
  });
  return episode.artifact(outcome);
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
  const episode = new SyntheticEpisode(kernel, scenarioId, processId, generate);
  const outcome = await episode.runProcess({
    processId,
    systemPrompt,
    prompt,
    maxTurns,
  });
  return episode.artifact(outcome);
}

class SyntheticEpisode {
  private readonly committedMessages: string[] = [];
  private readonly log: GsvSemanticLogEntry[] = [];
  private readonly observations: GsvSurfaceObservation[] = [];

  constructor(
    private readonly kernel: SyntheticKernel,
    private readonly scenarioId: string,
    private readonly entryProcessId: string,
    private readonly generate: GsvSurfaceModel,
  ) {
    this.kernel.setRecorder((entry) => this.log.push(structuredClone(entry)));
    this.kernel.setDelegateRunner(async (request) => this.runProcess(request));
  }

  async runProcess(
    request: SyntheticDelegateRunRequest,
  ): Promise<SyntheticProcessRunOutcome> {
    const process = this.kernel.process(request.processId);
    const messages: Message[] = [{
      role: "user",
      content: request.prompt,
      timestamp: 0,
    }];
    const baseline = this.kernel.responsibilityBaseline(request.processId);
    const systemPrompt = [
      request.systemPrompt,
      "Responsibility baseline:",
      formatResponsibilityBaseline(baseline),
    ].join("\n\n");
    const { modelTools, workToolNames } = buildSurfaceTools(
      process.capabilities,
      process.role === "ship",
    );
    let lastProjection = this.kernel.projection(request.processId);
    let observedResponsibilityRevision = baseline.revision;
    let correctionRounds = 0;
    let timestamp = 1;
    this.kernel.setProcessState(request.processId, "running");

    for (let turn = 1; turn <= request.maxTurns; turn += 1) {
      const nextProjection = this.kernel.projection(request.processId);
      if (!contextProjectionsEqual(lastProjection, nextProjection)) {
        appendContextDelta(
          request.processId,
          messages,
          this.log,
          lastProjection,
          nextProjection,
          timestamp,
        );
        timestamp += 1;
        lastProjection = nextProjection;
      }

      const responsibilityChanges = this.kernel.responsibilityChanges(
        request.processId,
        observedResponsibilityRevision,
      );
      for (const transition of responsibilityChanges) {
        const content = "[GSV EVENT]\n"
          + formatResponsibilityTransitionEvent(transition);
        messages.push({ role: "user", content, timestamp });
        timestamp += 1;
        this.log.push({
          type: "context.delta",
          processId: request.processId,
          content,
        });
        observedResponsibilityRevision = Math.max(
          observedResponsibilityRevision,
          transition.revision,
        );
      }
      for (const event of this.kernel.drainProcessEvents(request.processId)
        .sort((left, right) => left.sequence - right.sequence)) {
        const content = "[GSV EVENT]\n" + event.content;
        messages.push({ role: "user", content, timestamp });
        timestamp += 1;
        this.log.push({
          type: "context.delta",
          processId: request.processId,
          content,
        });
      }

      const context: Context = {
        systemPrompt,
        messages: structuredClone(messages),
        tools: modelTools,
      };
      this.observations.push(observation(
        turn,
        request.processId,
        lastProjection,
        context,
      ));
      const assistant = await this.generate(context);
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
          this.log.push({
            type: "run.returned",
            processId: request.processId,
            text,
          });
          this.kernel.setProcessState(request.processId, "returned");
          return { status: "returned", resultText: text };
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
        this.kernel.setProcessState(request.processId, "failed");
        return {
          status: "invalid_action",
          error: "The model did not yield after correction",
        };
      }

      const runControlCalls = process.role === "ship"
        ? toolCalls
          .map(runControlShellCall)
          .filter((call): call is RunControlShellCall => call !== null)
        : [];
      const runControlIds = new Set(
        runControlCalls.map(({ toolCall }) => toolCall.id),
      );
      const workCalls = toolCalls.filter((call) => !runControlIds.has(call.id));
      const combinationInvalid = runControlCalls.length > 1
        || (runControlCalls.length === 1 && workCalls.length > 0);
      if (combinationInvalid) {
        for (const call of toolCalls) {
          const args = parsedArguments(call.arguments);
          this.log.push({
            type: "tool.call",
            processId: request.processId,
            name: call.name,
            arguments: args,
          });
          appendToolResult(
            messages,
            call,
            "message send and yield must be issued separately from other tool actions",
            true,
            timestamp,
          );
          timestamp += 1;
          this.log.push({
            type: "tool.result",
            processId: request.processId,
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
        this.log.push({
          type: "tool.call",
          processId: request.processId,
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
          this.log.push({
            type: "tool.result",
            processId: request.processId,
            name: "Shell",
            content: result.error,
            isError: true,
          });
          continue;
        }
        if (result.command.action === "message") {
          let deliveryError: string | null = null;
          try {
            this.kernel.commitMessage(request.processId, result.command.text);
          } catch (error) {
            deliveryError = error instanceof Error ? error.message : String(error);
          }
          if (deliveryError) {
            appendToolResult(
              messages,
              runControl.toolCall,
              deliveryError,
              true,
              timestamp,
            );
            timestamp += 1;
            this.log.push({
              type: "tool.result",
              processId: request.processId,
              name: "Shell",
              content: deliveryError,
              isError: true,
            });
            continue;
          }
          this.committedMessages.push(result.command.text);
          this.log.push({
            type: "message.committed",
            processId: request.processId,
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
          this.log.push({
            type: "tool.result",
            processId: request.processId,
            name: "Shell",
            content,
            isError: false,
          });
          if (result.command.finish) {
            this.log.push({
              type: "run.yielded",
              processId: request.processId,
            });
            this.kernel.setProcessState(request.processId, "idle");
            return { status: "yielded" };
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
        this.log.push({
          type: "tool.result",
          processId: request.processId,
          name: "Shell",
          content: "Run yielded",
          isError: false,
        });
        this.log.push({ type: "run.yielded", processId: request.processId });
        this.kernel.setProcessState(request.processId, "idle");
        return { status: "yielded" };
      }

      for (const call of workCalls) {
        const parsed = jsonObjectSchema.safeParse(call.arguments);
        const args = parsed.success ? parsed.data : {};
        this.log.push({
          type: "tool.call",
          processId: request.processId,
          name: call.name,
          arguments: args,
        });
        if (!parsed.success || !workToolNames.has(call.name)) {
          const content = parsed.success
            ? 'Tool "' + call.name + '" was not offered for this generation'
            : "Tool arguments must be a JSON object";
          appendToolResult(messages, call, content, true, timestamp);
          timestamp += 1;
          this.log.push({
            type: "tool.result",
            processId: request.processId,
            name: call.name,
            content,
            isError: true,
          });
          continue;
        }

        const result = await this.kernel.dispatch(
          request.processId,
          call.name,
          args,
        );
        const content = stringifyToolResult(result.value);
        appendToolResult(messages, call, content, result.isError, timestamp);
        timestamp += 1;
        this.log.push({
          type: "tool.result",
          processId: request.processId,
          name: call.name,
          content,
          isError: result.isError,
        });
        for (const id of result.transitionsApplied) {
          this.log.push({ type: "world.transition", id });
        }
      }
    }

    this.kernel.setProcessState(request.processId, "failed");
    return {
      status: "max_turns",
      error: "Model did not finish within " + request.maxTurns + " turns",
    };
  }

  artifact(outcome: SyntheticProcessRunOutcome): GsvSurfaceArtifact {
    const artifact: GsvSurfaceArtifact = {
      schemaVersion: 2,
      scenarioId: this.scenarioId,
      entryProcessId: this.entryProcessId,
      status: outcome.status,
      committedMessages: [...this.committedMessages],
      observations: structuredClone(this.observations),
      log: structuredClone(this.log),
      world: this.kernel.snapshot(),
    };
    if (outcome.error !== undefined) artifact.error = outcome.error;
    if (outcome.resultText !== undefined) {
      artifact.resultText = outcome.resultText;
    }
    return artifact;
  }
}

function buildSurfaceTools(
  capabilities: readonly string[],
  interactive: boolean,
): SurfaceTools {
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
    modelTools: interactive ? withRunControlInstructions(workTools) : workTools,
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
