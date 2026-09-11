/** Internal Process helpers primitives. */

import type { AiConfigResult, AiContextResult } from "@humansandmachines/gsv/protocol";
import {
  MAX_TERMINAL_COMMAND_FAILURES, MAX_TERMINAL_DELIVERY_FAILURES, RUN_CONTROL_INSTRUCTION,
} from "../internal/lifecycle";
import type { Tool } from "@earendil-works/pi-ai";
import { RUN_CONTROL_SHELL_TOOL, SEND_TOOL, conversationProvenanceSchema } from "../internal/schemas";
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
    targets: run.devices ?? [],
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

/** A human-facing run gets the Send tool, and a Shell that knows the same actions as commands. */
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
  return foundShell ? [...tools, SEND_TOOL] : [...tools, RUN_CONTROL_SHELL_TOOL, SEND_TOOL];
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

export function isRunControlFailureExhausted(
  run: RunState,
  failureKind: RunControlFailureKind,
): boolean {
  return failureKind === "command"
    ? (run.terminalCommandFailures ?? 0) >= MAX_TERMINAL_COMMAND_FAILURES
    : (run.terminalDeliveryFailures ?? 0) >= MAX_TERMINAL_DELIVERY_FAILURES;
}
