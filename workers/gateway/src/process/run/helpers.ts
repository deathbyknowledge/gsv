/** Internal Process helpers primitives. */

import type { AiConfigResult, AiContextResult } from "@humansandmachines/gsv/protocol";
import {
  FINAL_MESSAGE_BLOCK_EXAMPLE, MAX_TERMINAL_COMMAND_FAILURES, MAX_TERMINAL_DELIVERY_FAILURES,
  RUN_CONTROL_INSTRUCTION,
} from "../internal/lifecycle";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { RUN_CONTROL_SHELL_TOOL, conversationProvenanceSchema } from "../internal/schemas";
import type { RunControlResult } from "../internal/contracts";
import type { RunState } from "./state";
import { z } from "zod";

export type ProcessTask =
  | { callback: "onMediaPreparationTimeout"; payload: string; }
  | { callback: "onRunFinishDelivery"; payload: string; }
  | {
    callback: "onToolDispatchTimeout";
    payload: { runId: string; dispatchId: string; };
  }
  | { callback: "tick"; payload: { runId: string; generation: number; }; };

export type ProcessTaskCallback = ProcessTask["callback"];

export const PROCESS_TASK_SCHEMA = z.discriminatedUnion("callback", [
  z.object({
    callback: z.literal("onMediaPreparationTimeout"),
    payload: z.string(),
  }),
  z.object({
    callback: z.literal("onRunFinishDelivery"),
    payload: z.string(),
  }),
  z.object({
    callback: z.literal("onToolDispatchTimeout"),
    payload: z.object({ runId: z.string(), dispatchId: z.string() }),
  }),
  z.object({
    callback: z.literal("tick"),
    payload: z.object({ runId: z.string(), generation: z.number().int() }),
  }),
]);

export function contextSnapshotFromRun(
  run: RunState,
  config: AiConfigResult,
): AiContextResult {
  const snapshot: AiContextResult = {
    devices: run.devices ?? [],
    mcpServers: run.mcpServers ?? [],
    system: {
      timezone: config.system?.timezone ?? "UTC",
    },
    skillIndex: config.skillIndex ?? [],
    skillIndexMode: config.skillIndexMode ?? "summary",
  };
  if (config.systemContextFiles !== undefined) {
    snapshot.systemContextFiles = config.systemContextFiles;
  }
  return snapshot;
}

export function conversationRunState(
  kind: string,
  provenance: string | null | undefined,
): Pick<RunState, "conversationId" | "inputMessageId"> {
  if (kind !== "conversation.message" || !provenance) return {};
  try {
    const record = conversationProvenanceSchema.parse(JSON.parse(provenance));
    return {
      conversationId: record.conversationId,
      inputMessageId: record.messageId,
    };
  } catch {
    return {};
  }
}

export function withRunControlInstructions(workTools: Tool[]): Tool[] {
  let foundShell = false;
  const tools = workTools.map((tool) => {
    if (tool.name !== "Shell") return tool;
    foundShell = true;
    return {
      ...tool,
      description: `${tool.description} ${RUN_CONTROL_INSTRUCTION}`,
    };
  });
  return foundShell ? tools : [...tools, RUN_CONTROL_SHELL_TOOL];
}

export function missingRunControlCorrectionMessage(): string {
  return [
    "This run is not complete. Ordinary assistant text is Process activity and is not sent to the user.",
    "Run `yield` now if the work is complete.",
    `If the user still needs a final message, send and finish with:\n${FINAL_MESSAGE_BLOCK_EXAMPLE}`,
  ].join("\n");
}

export type RunControlFailureKind = Extract<RunControlResult, { ok: false; }>["failureKind"];

export type RunControlFailureAttempt = { count: number; limit: number; };

export function incrementRunControlFailure(
  run: RunState,
  failureKind: RunControlFailureKind,
): RunState {
  if (failureKind === "command") {
    return {
      ...run,
      terminalCommandFailures: (run.terminalCommandFailures ?? 0) + 1,
    };
  }
  return {
    ...run,
    terminalDeliveryFailures: (run.terminalDeliveryFailures ?? 0) + 1,
  };
}

export function runControlFailureAttempt(
  run: RunState,
  failureKind: RunControlFailureKind,
): RunControlFailureAttempt {
  return failureKind === "command"
    ? {
      count: run.terminalCommandFailures ?? 1,
      limit: MAX_TERMINAL_COMMAND_FAILURES,
    }
    : {
      count: run.terminalDeliveryFailures ?? 1,
      limit: MAX_TERMINAL_DELIVERY_FAILURES,
    };
}

export function formatRunControlToolResult(
  result: RunControlResult,
  attempt: RunControlFailureAttempt | null,
): string {
  if (result.ok) {
    if (result.action === "yield") return "Run yielded";
    return result.finish
      ? "Message committed and run yielded"
      : "Message committed; run remains active";
  }
  const failureAttempt = attempt ?? {
    count: 1,
    limit: result.failureKind === "command"
      ? MAX_TERMINAL_COMMAND_FAILURES
      : MAX_TERMINAL_DELIVERY_FAILURES,
  };
  if (result.failureKind === "command") {
    return `Run-control command rejected (attempt ${failureAttempt.count} of ${failureAttempt.limit}): ${result.error}\nTo reply here, stage files first with \`message attach PATH...\`. Then issue \`message send ...\` as its own direct Shell tool call with no other tool calls or shell commands. Omit --to and --also. Run \`yield\` only when the work is complete.`;
  }
  return `Message delivery failed (attempt ${failureAttempt.count} of ${failureAttempt.limit}): ${result.error}\nRetry the exact same message command unchanged.`;
}

export function isRunControlFailureExhausted(
  run: RunState,
  failureKind: RunControlFailureKind,
): boolean {
  return failureKind === "command"
    ? (run.terminalCommandFailures ?? 0) >= MAX_TERMINAL_COMMAND_FAILURES
    : (run.terminalDeliveryFailures ?? 0) >= MAX_TERMINAL_DELIVERY_FAILURES;
}

export function orderMessagesForProvider(messages: Message[]): Message[] {
  const ordered: Message[] = [];
  type PendingToolBlock = {
    expected: Set<string>;
    deferred: Message[];
  };
  type MessageOrderState = { pendingToolBlock: PendingToolBlock | null; };
  const state: MessageOrderState = { pendingToolBlock: null };

  const append = (message: Message): void => {
    const pendingToolBlock = state.pendingToolBlock;
    if (pendingToolBlock) {
      // Providers require tool results to immediately follow the assistant tool-call message.
      if (message.role === "toolResult" && pendingToolBlock.expected.has(message.toolCallId)) {
        pendingToolBlock.expected.delete(message.toolCallId);
        ordered.push(message);

        if (pendingToolBlock.expected.size === 0) {
          const deferred = pendingToolBlock.deferred;
          state.pendingToolBlock = null;
          for (const deferredMessage of deferred) {
            append(deferredMessage);
          }
        }
        return;
      }

      pendingToolBlock.deferred.push(message);
      return;
    }

    ordered.push(message);
    const toolCallIds = message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : [];
    if (toolCallIds.length > 0) {
      state.pendingToolBlock = {
        expected: new Set(toolCallIds),
        deferred: [],
      };
    }
  };

  for (const message of messages) {
    append(message);
  }

  if (state.pendingToolBlock) {
    ordered.push(...state.pendingToolBlock.deferred);
  }

  return ordered;
}
