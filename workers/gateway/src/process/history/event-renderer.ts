/** Owns model-facing text for typed Process events and run-control results. */

import type {
  JsonValue, ProcHistoryEvent, ProcHistoryEventPayload, ProcIpcDeliverArgs,
} from "@humansandmachines/gsv/protocol";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type {
  ProcessAdapterWorkReturnedRuntimeEvent,
} from "../../protocol/process-frames";
import type { WatchedSignalPayload } from "../internal/schemas";
import {
  ipcReplyPayloadSchema, nonEmptyStringSchema,
} from "../internal/schemas";
import { parseOptionalJsonObject } from "../internal/messages";
import { parseStoredProcessMedia } from "../media";
import { describeStoredProcessMedia } from "./media-renderer";
import {
  CORRECTION_FAILURE_NOTICE, MAX_TERMINAL_COMMAND_FAILURES, MAX_TERMINAL_DELIVERY_FAILURES,
  RUNTIME_EVENT_WAKE_MESSAGE, YIELD_CORRECTION_MESSAGE,
} from "../internal/lifecycle";
import type { RunControlFailureAttempt } from "../run/helpers";
import type { RunControlResult } from "../internal/contracts";
import { formatProviderErrorMessage, formatProviderContextOverflowMessage } from "../../inference/errors";
import { formatContextProjectionEvent } from "../../prompts/context-events";
import { formatContextRunwayAlertMessage } from "../../prompts/context-runway";
import { formatTargetConnectionEvent } from "../../prompts/target-events";
import { formatScheduleEventMessage } from "../../prompts/schedule-events";
export { formatScheduleEventMessage } from "../../prompts/schedule-events";
import { formatResponsibilityTransitionEvent } from "../../prompts/responsibility-events";
export { formatResponsibilityTransitionEvent, formatResponsibilityLine } from "../../prompts/responsibility-events";

export function renderHistoryEvent(event: ProcHistoryEvent): string {
  switch (event.kind) {
    case "legacy": return event.payload.text;
    case "context.changed": return formatContextProjectionEvent(event.payload.previous, event.payload.current) ?? "";
    case "context.runway": return formatContextRunwayAlertMessage(event.payload);
    case "context.failed": return renderContextFailure(event.payload);
    case "responsibility.revision": return formatResponsibilityTransitionEvent(event.payload.transition, event.payload.contextFields);
    case "correction.text-only": return YIELD_CORRECTION_MESSAGE;
    case "correction.exhausted": return CORRECTION_FAILURE_NOTICE;
    case "generation.failed": return formatGenerationFailure(event.payload.error, event.payload);
    case "delivery.failed": return event.payload.phase === "run-finish"
      ? "Run completion signaling stopped after repeated transport failures. The completed activity remains in this process history."
      : event.payload.error;
    case "media.failed": return event.payload.error;
    case "schedule.fired": return formatScheduleEventMessage(event.payload);
    case "signal.watched": return formatWatchedSignalMessage(event.payload.signal, event.payload);
    case "ipc.reply":
    case "ipc.overdue":
    case "ipc.timeout": return formatIpcReplyMessage(event.kind, event.payload);
    case "adapter.work.returned": return formatProcessRuntimeEvent({ type: event.kind, ...event.payload });
    case "target.connection": return formatTargetConnectionEvent(event.payload);
    case "history.compacted": return formatCompactionSummaryMessage(event.payload);
    case "runtime.wake": return RUNTIME_EVENT_WAKE_MESSAGE;
    case "runtime.failed": return event.payload.prefix === undefined
      ? event.payload.error
      : `${event.payload.prefix}: ${event.payload.error}`;
  }
}

export function renderToolResultOutput(output: JsonValue): string {
  // The typed JSON union includes literal text, which remains unquoted in model context.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof output === "string" ? output : JSON.stringify(output);
}

export function renderToolExecutionError(error: string | null, source: "run-control" | "tool"): string {
  return source === "run-control" ? `Run-control execution failed: ${error}` : `Error: ${error}`;
}

export function renderContextFailure(payload: ProcHistoryEventPayload<"context.failed">): string {
  const { reason, policy, pressure, trigger } = payload;
  if (reason === "context.provider_overflow") {
    return formatProviderContextOverflowMessage(payload.error, payload);
  }
  if (reason === "context.policy.fail" && policy) {
    const lines = [
      "Context limit policy stopped this run.",
      trigger === "provider-overflow"
        ? "The AI provider reported that the request exceeds its context window."
        : `Policy: fail at ${Math.round(policy.compactAtPressure * 100)}% context pressure.`,
    ];
    if (pressure !== undefined && pressure !== null && Number.isFinite(pressure)) {
      lines.push(`Current estimate: ${Math.round(pressure * 100)}%.`);
    }
    lines.push("Compact the history or reset the process before sending more work.");
    return lines.join("\n");
  }
  if (reason === "context.auto_compact.empty" && policy) {
    return [
      "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
      `Policy targets ${Math.round(policy.compactToPressure * 100)}% context pressure.`,
      "Compact manually or reset this process.",
    ].join("\n");
  }
  if (reason === "context.auto_compact.failed") {
    return trigger === "provider-overflow"
      ? `Auto-compaction failed after provider context overflow: ${payload.error}`
      : `Auto-compaction failed before model call: ${payload.error}`;
  }
  if (reason === "context.auto_compact.insufficient" && policy
    && payload.beforePressure !== undefined && payload.afterPressure !== undefined) {
    return [
      "Auto-compaction could not reduce this process history to its configured context target.",
      `Pressure: ${Math.round(payload.beforePressure * 100)}% before, ${Math.round(payload.afterPressure * 100)}% after.`,
      `Policy: compact at ${Math.round(policy.compactAtPressure * 100)}% and target ${Math.round(policy.compactToPressure * 100)}%.`,
      "Compact more history manually or reset the process.",
    ].join("\n");
  }
  if (payload.error !== undefined) return payload.error;
  throw new Error(`Context failure ${reason} has no rendering data`);
}

export function formatProcessRuntimeEvent(event: ProcessAdapterWorkReturnedRuntimeEvent): string {
  return [
    `The user returned from work process \`${event.workPid}\` to their personal intelligence.`,
    "No work-session transcript was attached to this event.",
  ].join("\n");
}

export function formatWatchedSignalMessage(
  signal: string,
  value: Pick<WatchedSignalPayload, "sourcePid" | "watch" | "payload">,
): string {
  const sourcePid = value.sourcePid ?? null;
  const key = value.watch?.key ?? null;
  const watchState = value.watch?.state;
  const renderedState = renderJsonBlock(watchState);
  const renderedPayload = renderJsonBlock(value.payload);

  const lines = [
    `Observed watched signal \`${signal}\`${sourcePid ? ` from process \`${sourcePid}\`` : ""}.`,
  ];
  if (key) {
    lines.push(`Watch key: \`${key}\`.`);
  }
  if (renderedState) {
    lines.push("", "Watch state:", "```json", renderedState, "```");
  }
  if (renderedPayload) {
    lines.push("", "Signal payload:", "```json", renderedPayload, "```");
  }
  return lines.join("\n");
}

export function formatIpcMessage(args: ProcIpcDeliverArgs): string {
  const sentAt = Number.isFinite(args.sentAt)
    ? new Date(args.sentAt).toISOString()
    : new Date().toISOString();
  const source = `${args.source.username} (${args.sourcePid})`;
  const lines = args.call
    ? [
      `Delegated task from ${source}.`,
      `Received: ${sentAt}.`,
      "",
      args.message,
    ]
    : [
      `Message from ${source}.`,
      `Sent: ${sentAt}.`,
      "",
      args.message,
    ];
  const renderedMetadata = renderJsonBlock(args.metadata);
  if (renderedMetadata) {
    lines.push("", "Additional context:", "```json", renderedMetadata, "```");
  }
  if (args.call) {
    if (args.call.supervised) {
      lines.push(
        "",
        `GSV will check on this task after ${new Date(args.call.deadlineAt).toISOString()}.`,
        "This is not a termination deadline; continue until the task reaches a real terminal outcome.",
        "Your final answer will be returned to the caller automatically.",
      );
    } else {
      lines.push(
        "",
        `Please complete this task before ${new Date(args.call.deadlineAt).toISOString()}.`,
        "Your final answer will be returned to the caller automatically.",
      );
    }
  }
  return lines.join("\n");
}

export function formatIpcReplyMessage(
  signal: string,
  payload: Parameters<typeof ipcReplyPayloadSchema.parse>[0],
): string {
  const record = ipcReplyPayloadSchema.parse(payload);
  const callId = record.callId ?? "unknown";
  const targetPid = record.targetPid ?? "unknown";
  const error = record.error ?? null;
  const response = record.response;
  const responseRecord = parseOptionalJsonObject(response);
  const responseText = nonEmptyStringSchema.safeParse(responseRecord?.text);
  const responseMedia = parseStoredProcessMedia(
    JSON.stringify(responseRecord?.media ?? null) ?? null,
  );
  const renderedResponse = renderJsonBlock(response);
  const overdue = signal === "ipc.overdue";

  const lines = [
    overdue
      ? `Delegated task to process \`${targetPid}\` is still running.`
      : signal === "ipc.timeout"
        ? `Delegated task to process \`${targetPid}\` timed out.`
        : `Delegated task from process \`${targetPid}\` finished.`,
  ];
  if (callId !== "unknown") {
    lines.push(`Task id: \`${callId}\`.`);
  }
  if (error) {
    lines.push("", "Error:", error);
  }
  if (overdue) {
    lines.push("", "The delegated process was not cancelled and remains responsible for the work.");
    if (record.nextCheckAt !== undefined) {
      lines.push(`Next check-in: ${new Date(record.nextCheckAt).toISOString()}.`);
    }
  }
  if (responseText.success) {
    lines.push("", "Result:", responseText.data);
  } else if (renderedResponse && responseMedia.length === 0) {
    lines.push("", "Response:", "```json", renderedResponse, "```");
  }
  if (responseMedia.length > 0) {
    lines.push("", "Attachments:", ...responseMedia.map((item) => `- ${describeStoredProcessMedia(item)}`));
  }
  return lines.join("\n");
}

function renderJsonBlock(
  value: Parameters<typeof jsonValueSchema.safeParse>[0],
): string | null {
  const result = jsonValueSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  return JSON.stringify(result.data, null, 2) ?? null;
}

export function formatGenerationFailure(
  message: string,
  context?: { provider?: string; model?: string },
): string {
  const normalized = formatProviderErrorMessage(message, context);
  if (!normalized) {
    return "Generation failed.";
  }
  return `Generation failed: ${normalized}`;
}

export function formatCompactionSummaryMessage(input: {
  archivedMessages: number;
  archivePath: string;
  summary: string;
}): string {
  return [
    "Process history compacted.",
    "",
    `Archived messages: ${input.archivedMessages}`,
    `Archive: ${input.archivePath}`,
    "",
    "Summary:",
    input.summary,
  ].join("\n");
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
    return `Run-control command rejected (attempt ${failureAttempt.count} of ${failureAttempt.limit}): ${result.error}\nCall Send with the text for the person, and yield true only when the work is complete. To attach files, stage them first with \`message attach PATH...\` in the Shell. In the Shell, \`message send ...\` as its own call with no other tool calls is the same action; omit --to and --also.`;
  }
  return `Message delivery failed (attempt ${failureAttempt.count} of ${failureAttempt.limit}): ${result.error}\nRetry the exact same message command unchanged.`;
}
