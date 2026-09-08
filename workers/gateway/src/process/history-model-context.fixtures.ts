import type {
  InteractionOrigin, ProcHistoryEvent, ProcHistoryEventPayload, ProcMessageMetadata, ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import { procHistoryEventSchema } from "@humansandmachines/gsv/protocol";
import { formatContextProjectionEvent } from "../prompts/context-events";
import { formatContextRunwayAlertMessage } from "../prompts/context-runway";
import { formatGenerationFailure } from "./context/formatters";
import type { ContextProjection } from "./context/projection";
import { formatCompactionSummaryMessage } from "./history/helpers";
import {
  formatIpcReplyMessage, formatProcessRuntimeEvent, formatResponsibilityTransitionEvent,
  formatScheduleEventMessage, formatWatchedSignalMessage,
} from "./internal/events";
import { RUNTIME_EVENT_WAKE_MESSAGE, YIELD_CORRECTION_MESSAGE } from "./internal/lifecycle";

export const GOLDEN_TIME = 1_700_000_000_000;
export const GOLDEN_EPOCH = "epoch:golden";
export const GOLDEN_GENERATION = "generation:golden";

export const GOLDEN_ASSISTANT_METADATA: ProcMessageMetadata = {
  contextEpochId: GOLDEN_EPOCH,
  generationContextId: GOLDEN_GENERATION,
  provider: {
    api: "openai-responses", provider: "openai", model: "synthetic-model",
    responseModel: "synthetic-model-revision", responseId: "response:golden", stopReason: "toolUse",
  },
  usage: {
    inputTokens: 90, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 5, totalTokens: 137,
    cost: { input: 0.09, output: 0.024, cacheRead: 0.003, cacheWrite: 0.005, total: 0.122, currency: "USD", source: "model-pricing" },
  },
};

export const GOLDEN_ORIGINS = {
  client: { kind: "client", connectionId: "connection:one", clientId: "gsv-ui", platform: "browser" },
  otherClient: { kind: "client", connectionId: "connection:two", clientId: "gsv-ui", platform: "browser" },
  adapter: {
    kind: "adapter", adapter: "slack", accountId: "account:synthetic",
    surface: { kind: "thread", id: "room:one", name: "Synthetic room", threadId: "thread:one" },
    actorId: "actor:one", actorLabel: "Fixture actor", messageId: "message:source",
  },
  device: { kind: "device", deviceId: "fixture-laptop", cwd: "/work/synthetic" },
  process: { kind: "process", sourcePid: "proc:fixture-caller", uid: 42 },
  scheduler: { kind: "scheduler", scheduleId: "schedule:golden" },
} satisfies Record<string, InteractionOrigin>;

type EventFixture = { event: ProcHistoryEvent; text: string; origin?: InteractionOrigin };

/** Synthetic producer inputs; expected provider bytes live only in the checked-in snapshot. */
export function goldenEvents(): EventFixture[] {
  const policy = { overflow: "auto-compact" as const, compactAtPressure: 0.9, compactToPressure: 0.4, updatedAt: GOLDEN_TIME };
  const previous: ContextProjection = {
    version: 1, runtime: { date: "2023-11-14", timezone: "UTC" },
    targets: [{ id: "old-target", implements: ["fs.read"] }], mcpServers: ["old-server"],
    skills: { mode: "summary", entries: [{ id: "old-skill", description: "Old synthetic skill" }] },
  };
  const current: ContextProjection = {
    version: 1, runtime: { date: "2023-11-15", timezone: "Europe/Amsterdam" },
    targets: [{ id: "new-target", label: "Synthetic target", implements: ["fs.read", "shell.exec"] }],
    mcpServers: ["new-server"], skills: { mode: "summary", entries: [{ id: "new-skill", description: "New synthetic skill" }] },
  };
  const transition: ResponsibilityTransition = {
    revision: 2, responsibilityId: "responsibility:golden", kind: "updated", beforeState: "open", afterState: "active",
    changedFields: ["state", "details"], actor: { kind: "system", component: "fixture" }, createdAtMs: GOLDEN_TIME,
    record: {
      id: "responsibility:golden", ownerUid: 0, title: "Inspect synthetic input", details: { source: "fixture" },
      source: { kind: "process", processId: "proc:fixture-caller" }, assignee: { kind: "ship" },
      state: "active", priority: "normal", revision: 2, createdAtMs: GOLDEN_TIME - 100, updatedAtMs: GOLDEN_TIME,
    },
  };
  const schedule = {
    runId: "run:schedule", scheduleId: "schedule:golden", scheduleName: "Synthetic reminder", message: "Inspect the fixture.",
    data: { count: 2 }, scheduledAtMs: GOLDEN_TIME - 500, firedAtMs: GOLDEN_TIME,
    replyTo: {
      kind: "adapter" as const, adapter: GOLDEN_ORIGINS.adapter.adapter, accountId: GOLDEN_ORIGINS.adapter.accountId,
      surface: GOLDEN_ORIGINS.adapter.surface, actorId: GOLDEN_ORIGINS.adapter.actorId,
    },
  };
  const signal = { signal: "proc.changed", sourcePid: "proc:other", watch: { key: "watch:fixture", state: { revision: 2 } }, payload: { changes: ["messages"] } };
  const compacted = { summary: "Synthetic decisions and pending work.", segmentId: "segment:golden", archivedMessages: 12, archivePath: "/root/history/synthetic.jsonl" };
  const events: EventFixture[] = [
    {
      event: { kind: "context.changed", payload: { epochId: GOLDEN_EPOCH, previous, current }, severity: "info", audience: "model" },
      text: formatContextProjectionEvent(previous, current)!,
    },
    {
      event: { kind: "context.runway", payload: { epochId: GOLDEN_EPOCH, remainingInputTokens: 12_000, runwayBeforeBoundaryTokens: 8_000, policy }, severity: "warn", audience: "model" },
      text: formatContextRunwayAlertMessage({ remainingInputTokens: 12_000, runwayBeforeBoundaryTokens: 8_000, policy }),
    },
    {
      event: { kind: "responsibility.revision", payload: { epochId: GOLDEN_EPOCH, transition }, severity: "info", audience: "model" },
      text: formatResponsibilityTransitionEvent(transition),
    },
    {
      event: { kind: "schedule.fired", payload: schedule, severity: "info", audience: "model" },
      text: formatScheduleEventMessage(schedule),
      origin: { kind: "scheduler", scheduleId: schedule.scheduleId, replyTo: GOLDEN_ORIGINS.adapter },
    },
    { event: { kind: "signal.watched", payload: signal, severity: "info", audience: "model" }, text: formatWatchedSignalMessage(signal.signal, { ...signal, watched: true }) },
    {
      event: { kind: "adapter.work.returned", payload: { eventId: "event:returned", workPid: "proc:work" }, severity: "info", audience: "model" },
      text: formatProcessRuntimeEvent({ type: "adapter.work.returned", workPid: "proc:work" }),
    },
    { event: { kind: "history.compacted", payload: compacted, severity: "info", audience: "model" }, text: formatCompactionSummaryMessage(compacted) },
    { event: { kind: "correction.text-only", payload: { attempt: 1, limit: 3 }, severity: "warn", audience: "model" }, text: YIELD_CORRECTION_MESSAGE },
    { event: { kind: "runtime.wake", payload: { source: "process", reason: "pending-events", pendingEvents: 2 }, severity: "info", audience: "model" }, text: RUNTIME_EVENT_WAKE_MESSAGE },
    {
      event: { kind: "generation.failed", payload: { reason: "generation.error", error: "Synthetic provider failure", provider: "openai", model: "synthetic-model" }, severity: "error", audience: "both" },
      text: formatGenerationFailure("Synthetic provider failure", { provider: "openai", model: "synthetic-model" }),
    },
    {
      event: { kind: "context.failed", payload: { reason: "context.error", error: "Synthetic context failure" }, severity: "error", audience: "both" },
      text: "Synthetic context failure",
    },
    {
      event: { kind: "runtime.failed", payload: { reason: "schedule.error", error: "Synthetic alarm failure", prefix: "Scheduling failed" }, severity: "error", audience: "both" },
      text: "Scheduling failed: Synthetic alarm failure",
    },
    {
      event: { kind: "media.failed", payload: { reason: "media.timeout", messageId: 7, error: "Synthetic media timed out" }, severity: "error", audience: "both" },
      text: "Synthetic media timed out",
    },
    {
      event: { kind: "delivery.failed", payload: { phase: "run-finish", runId: "run:golden", error: "Synthetic transport failure", attempts: 3, maxAttempts: 3 }, severity: "error", audience: "both" },
      text: "Run completion signaling stopped after repeated transport failures. The completed activity remains in this process history.",
    },
    { event: { kind: "legacy", payload: { text: "Legacy system notice with exact spacing.  " }, severity: "info", audience: "model" }, text: "Legacy system notice with exact spacing.  " },
  ];
  for (const kind of ["ipc.reply", "ipc.overdue", "ipc.timeout"] as const) {
    const payload: ProcHistoryEventPayload<"ipc.reply"> = {
      callId: `call:${kind}`, targetPid: "proc:delegated", sourceRunId: "run:ipc", createdAt: GOLDEN_TIME - 1_000,
      deadlineAt: GOLDEN_TIME + 5_000, nextCheckAt: GOLDEN_TIME + 1_000, checkInCount: 2,
    };
    if (kind === "ipc.reply") payload.response = { text: "Synthetic delegated result", details: { count: 2 } };
    if (kind === "ipc.timeout") payload.error = "Synthetic timeout";
    events.push({ event: { kind, payload, severity: kind === "ipc.reply" ? "info" : "warn", audience: "model" }, text: formatIpcReplyMessage(kind, payload) });
  }
  for (const fixture of events) procHistoryEventSchema.parse(fixture.event);
  return events;
}
