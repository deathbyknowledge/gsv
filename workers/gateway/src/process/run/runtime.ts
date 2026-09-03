/** Owns the Process run state machine from admission through terminal delivery. */

import type { AssistantMessage, Context, ToolCall, Tool } from "@earendil-works/pi-ai";
import type { InternalRequestFrame } from "../../protocol/process-frames";
import type {
  CommittedRunControlMessage, RunControlResult, TerminalResponsibilityCheck, CompletedRunTransition,
  RunFinishEffects, RunFinishedTelemetryProperties, PreparedRunTickContext, RunTickGenerationAttemptOutcome,
  RunTickGenerationControl, GeneratedRunTick, RunTickContinuation, StreamSeqCounter, PersistedAssistantHistory,
  PersistedRunTick, RunTickContextState, RunTickInputs,
} from "../internal/contracts";
import {
  FINAL_MESSAGE_BLOCK_EXAMPLE, MAX_TERMINAL_CORRECTION_ROUNDS, RUNTIME_EVENT_WAKE_MESSAGE,
  MAX_RETRYABLE_GENERATION_ATTEMPTS, PENDING_RUN_CONTROL_CALL, UNKNOWN_SHELL_SESSION_TARGET_MESSAGE,
  MEDIA_PREPARATION_TIMEOUT_MS, TOOL_DISPATCH_TIMEOUT_MS,
} from "../internal/lifecycle";
import {
  type ResponsibilityRecord, jsonObjectSchema, type AiConfigResult, type AiTextGenerateConfig,
  type AiTextGenerateOptions, type ProcUsageState, jsonValueSchema, type JsonObject, type ProcTraceSpanStatus,
} from "@humansandmachines/gsv/protocol";
import type { RunControlCommandParseResult } from "../run-control-command";
import type { RunOutputMedia, RunState } from "./state";
import {
  errorMessageFromUnknown, isProviderContextOverflow, isProviderContextOverflowErrorMessage,
} from "../../inference/errors";
import { sendFrameToKernel, cancelProcessRequests } from "../../shared/utils";
import {
  terminalResponsibilitySnapshot, unhandledTerminalResponsibilityIds, terminalResponsibilityAdmissionKey,
} from "../internal/events";
import type { Process } from "../do";
import type { RunFinishOptions, RunFinishPayload, RunResult } from "./finish";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import type { ArgsOf } from "../../syscalls";
import { inferenceLogicalRequestId, type InferenceAttribution } from "../../inference/provider";
import {
  adaptContextMessage, adaptContextTool, adaptGeneratedAssistantMessage, buildAssistantMessageMetadata,
  modelMetadataFromAiConfig,
} from "../internal/messages";
import { formatAiModelStackLabel, formatGenerationFailure } from "../context/formatters";
import {
  nextAiConfigFallback, classifyAssistantTurn, type AssistantTurnClassification,
} from "../run-tick-policy";
import {
  describeAssistantResponseFailure, hasRawToolCallMarkupOutput, isRetryableAssistantResponseFailure,
  isRetryableGenerationErrorMessage,
} from "../../inference/output";
import {
  formatRunControlToolResult, incrementRunControlFailure, isRunControlFailureExhausted, runControlFailureAttempt,
  PROCESS_TASK_SCHEMA, type ProcessTask, type ProcessTaskCallback, contextSnapshotFromRun,
  withRunControlInstructions,
} from "./helpers";
import { ProcessStore, stringifyAssistantMessageMeta, type MessageMetadata, type ContextEpochRecord } from "../store";
import { TOOL_TO_SYSCALL } from "../../syscalls/constants";
import { stringifyStoredProcessMedia } from "../media";
import type { DurableTask, DurableTaskOptions } from "../../shared/durable-tasks";
import { MANAGED_LIFECYCLE_RECHECK_MS, managedInstallationWorkGate } from "../../installation/lifecycle";
import { GSV_DELEGATED_TASK_CONTEXT } from "../../prompts/system";
import { createContextProjection, parseContextProjection } from "../context";
import { deriveGenerationContextId } from "../context-message-metadata";
import { piToolParametersSchema } from "../internal/schemas";

function hasRunControlRegistration(
  host: Process,
  runId: string,
  dispatchId: string,
  toolCallId: string,
): boolean {
  const pending = host.store.tools.getPending(dispatchId);
  return pending?.runId === runId
    && pending.callId === toolCallId
    && pending.call === PENDING_RUN_CONTROL_CALL;
}

export class ProcessRun {
  constructor(private readonly host: Process) {}

  async executeRunControlAction(
    runId: string,
    actionId: string,
    parsed: RunControlCommandParseResult,
    media: RunOutputMedia[],
  ): Promise<RunControlResult> {
    if (!parsed.ok) {
      return {
        ok: false,
        action: parsed.action,
        text: "",
        delivery: { kind: "none" },
        failureKind: "command",
        error: parsed.error,
      };
    }
    if (parsed.command.action === "message" && !parsed.command.text.trim() && media.length === 0) {
      return {
        ok: false,
        action: "message",
        text: "",
        delivery: { kind: "none" },
        failureKind: "command",
        error: "Message requires non-empty text or attached media",
      };
    }
    const command = parsed.command;
    let responsibilityAdmissionKey: string | undefined;
    if (command.action === "yield" || command.finish) {
      const responsibilityCheck = await this.verifyTerminalResponsibilities(runId);
      if (!responsibilityCheck.ok) {
        return {
          ok: false,
          action: command.action,
          text: command.action === "message" ? command.text : "",
          delivery: { kind: "none" },
          failureKind: "command",
          error: responsibilityCheck.error,
        };
      }
      responsibilityAdmissionKey = responsibilityCheck.admissionKey;
    }
    if (command.action === "yield") {
      await this.host.streams.silence(runId, actionId);
      return {
        ok: true,
        action: "yield",
        finish: true,
        text: "",
        delivery: { kind: "none" },
        responsibilityAdmissionKey,
      };
    }
    return await this.executeMessageRunControlAction({
      runId,
      actionId,
      text: command.text,
      finish: command.finish,
      media,
      responsibilityAdmissionKey,
    });
  }

  async executeMessageRunControlAction(options: {
    runId: string;
    actionId: string;
    text: string;
    finish: boolean;
    media: RunOutputMedia[];
    responsibilityAdmissionKey?: string;
  }): Promise<RunControlResult> {
    try {
      await this.host.streams.complete(options.runId, options.actionId, options.text);
      return await this.commitMessageRunControlAction(options);
    } catch (error) {
      await this.host.streams.abortAction(
        options.runId,
        options.actionId,
        "Message could not be committed",
      );
      return {
        ok: false,
        action: "message",
        text: options.text,
        delivery: { kind: "none" },
        failureKind: "delivery",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async commitMessageRunControlAction(options: {
    runId: string;
    actionId: string;
    text: string;
    finish: boolean;
    media: RunOutputMedia[];
    responsibilityAdmissionKey?: string;
  }): Promise<RunControlResult> {
    const releaseCommit = this.beginRunControlCommit(options.runId);
    try {
      const run = this.host.runs.active;
      if (this.host.killed || !run || run.runId !== options.runId) {
        return {
          ok: false,
          action: "message",
          text: options.text,
          delivery: { kind: "none" },
          failureKind: "delivery",
          error: "Message run is no longer active",
        };
      }
      if (run.returnToCaller) {
        return {
          ok: true,
          action: "message",
          finish: options.finish,
          text: options.text,
          delivery: { kind: "none" },
          responsibilityAdmissionKey: options.responsibilityAdmissionKey,
        };
      }
      const request = this.buildRunControlMessageCommitRequest(run, options);
      const committedMessage = await this.commitRunControlMessage(
        options.runId,
        options.actionId,
        request,
      );
      this.consumeRunOutputMedia(options.runId, options.media);
      this.host.streams.deleteAction(options.runId, options.actionId);
      return {
        ok: true,
        action: "message",
        finish: options.finish,
        text: options.text,
        delivery: {
          kind: "message",
          conversationId: committedMessage.conversationId,
          messageId: committedMessage.id,
        },
        responsibilityAdmissionKey: options.responsibilityAdmissionKey,
      };
    } finally {
      releaseCommit();
    }
  }

  beginRunControlCommit(runId: string): () => void {
    if (this.host.runControlCommit) {
      throw new Error("A canonical message commit is already active");
    }
    let settle!: () => void;
    const token = {
      runId,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.host.runControlCommit = token;
    return () => {
      if (this.host.runControlCommit === token) {
        this.host.runControlCommit = null;
      }
      settle();
    };
  }

  async awaitRunControlCommit(runId: string): Promise<void> {
    const commit = this.host.runControlCommit;
    if (commit?.runId === runId) {
      await commit.settled;
    }
  }

  buildRunControlMessageCommitRequest(
    run: RunState,
    options: {
      runId: string;
      actionId: string;
      text: string;
      media: RunOutputMedia[];
    },
  ): InternalRequestFrame<"proc.message.commit"> {
    const args: InternalRequestFrame<"proc.message.commit">["args"] = {
      runId: options.runId,
      actionId: options.actionId,
      text: options.text,
    };
    if (run.conversationId) args.conversationId = run.conversationId;
    if (options.media.length > 0) {
      args.media = options.media.map((item) => this.host.resources.runOutputMediaResource(item));
    }
    return {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.message.commit",
      args,
    };
  }

  async commitRunControlMessage(
    runId: string,
    actionId: string,
    request: InternalRequestFrame<"proc.message.commit">,
  ): Promise<CommittedRunControlMessage> {
    const deliverySpanId = this.host.trace.start({
      runId,
      kind: "delivery",
      name: "Send message",
      reference: { kind: "delivery", callId: actionId },
    });
    try {
      const response = await sendFrameToKernel(this.host.installationId, this.host.pid, request);
      if (!response || response.type !== "res" || response.id !== request.id) {
        throw new Error("Kernel returned no valid message response");
      }
      if (!response.ok) throw new Error(response.error.message);
      const committedMessage = response.data.message;
      this.host.trace.finish(deliverySpanId, "ok", {
        reference: {
          kind: "delivery",
          callId: actionId,
          conversationId: committedMessage.conversationId,
          messageId: committedMessage.id,
        },
      });
      return committedMessage;
    } catch (error) {
      this.host.trace.finish(deliverySpanId, "error");
      throw error;
    }
  }

  async verifyTerminalResponsibilities(runId: string): Promise<TerminalResponsibilityCheck> {
    const run = this.host.runs.active;
    if (!run || run.runId !== runId) {
      return { ok: false, error: "The run is no longer active" };
    }
    const snapshot = terminalResponsibilitySnapshot(run);
    if (snapshot.responsibilityIds.length === 0) {
      return { ok: true, admissionKey: snapshot.admissionKey };
    }
    const loaded = await this.loadTerminalResponsibilityRecords(runId, snapshot.responsibilityIds);
    if (!loaded.ok) return loaded;
    const unhandled = unhandledTerminalResponsibilityIds(
      snapshot.responsibilityIds,
      loaded.records,
    );
    if (unhandled.length === 0) {
      return { ok: true, admissionKey: snapshot.admissionKey };
    }
    return {
      ok: false,
      error: [
        "The responsibility batch still contains unhandled work.",
        `Before yielding, resolve, cancel, actively delegate, or explicitly defer: ${unhandled.join(", ")}.`,
      ].join(" "),
    };
  }

  async loadTerminalResponsibilityRecords(
    runId: string,
    responsibilityIds: string[],
  ): Promise<
    { ok: true; records: ReadonlyMap<string, ResponsibilityRecord> } | { ok: false; error: string }
  > {
    const records = new Map<string, ResponsibilityRecord>();
    try {
      for (let offset = 0; offset < responsibilityIds.length; offset += 500) {
        const pageIds = responsibilityIds.slice(offset, offset + 500);
        const result = await this.host.kernel.kernelRpc(
          "r12y.list",
          {
            ids: pageIds,
            includeTerminal: true,
            limit: pageIds.length,
          },
          this.runAbortSignal(runId),
        );
        if (this.host.handleRunStopped(runId)) {
          return { ok: false, error: "The run is no longer active" };
        }
        for (const responsibility of result.responsibilities) {
          records.set(responsibility.id, responsibility);
        }
      }
      return { ok: true, records };
    } catch (error) {
      return {
        ok: false,
        error: `Could not verify the responsibility batch before yielding: ${errorMessageFromUnknown(error)}`,
      };
    }
  }

  async requireRunYield(
    runId: string,
    usage: AssistantMessage["usage"],
    draftText: string,
  ): Promise<void> {
    if (this.host.handleRunStopped(runId)) return;
    await this.host.streams.abortRun(runId, "The model did not yield");
    const run = this.host.runs.active;
    if (!run || run.runId !== runId) return;
    if ((run.terminalCorrectionRounds ?? 0) >= MAX_TERMINAL_CORRECTION_ROUNDS) {
      await this.finishRun(runId, {
        reason: "message.action.missing",
        status: "error",
        resultText: draftText || null,
        error: "The model did not yield after correction",
        usage,
      });
      return;
    }
    const correctedRun = this.host.mutateActiveRun(runId, (current) => ({
      ...current,
      terminalCorrectionRounds: (current.terminalCorrectionRounds ?? 0) + 1,
    }));
    if (!correctedRun) return;
    const message = [
      "This run is not complete. Ordinary assistant text is Process activity and is not sent to the user.",
      "Run `yield` now if the work is complete.",
      `If the user still needs a final message, send and finish with:\n${FINAL_MESSAGE_BLOCK_EXAMPLE}`,
    ].join("\n");
    await this.host.history.appendSystemMessage(runId, message);
    if (!this.host.handleRunStopped(runId)) await this.scheduleTick(runId);
  }

  async finishRun(
    runId: string,
    options: RunFinishOptions,
    responsibilityAdmissionKey?: string,
  ): Promise<void> {
    const transition = this.host.ctx.storage.transactionSync(() => {
      if (this.host.killed) return null;
      const run = this.host.runs.active;
      if (!run || run.runId !== runId) return null;
      if (
        responsibilityAdmissionKey !== undefined &&
        terminalResponsibilityAdmissionKey(run) !== responsibilityAdmissionKey
      ) {
        return "changed" as const;
      }
      return this.commitRunFinishState(run, options);
    });
    if (transition === "changed") await this.scheduleTick(runId);
    else if (transition) await this.completeRunTransition(transition);
  }

  async failWithSystemMessage(runId: string, reason: string, message: string): Promise<void> {
    await this.host.history.appendSystemMessage(runId, message);
    await this.finishRun(runId, {
      reason,
      status: "error",
      resultText: null,
      error: message,
    });
  }

  commitRunFinishState(run: RunState, options: RunFinishOptions): CompletedRunTransition {
    const shouldQueueRuntimeWake =
      (run.pendingRuntimeEvents ?? 0) > 0 && this.host.store.queue.queueSize() === 0;
    const effects = this.recordRunFinish(run, options);
    this.host.runs.active = null;
    this.host.store.tools.clearPendingHil();

    const wakeRunId = shouldQueueRuntimeWake ? crypto.randomUUID() : undefined;
    if (wakeRunId) {
      this.host.store.queue.enqueue(wakeRunId, RUNTIME_EVENT_WAKE_MESSAGE, {
        role: "system",
        kind: "runtime.wake",
        provenance: JSON.stringify({
          source: "process",
          eventType: "runtime.wake",
        }),
      });
    }
    const next = this.host.controller.claimNextQueuedRun();

    return {
      effects,
      next,
      ...(wakeRunId ? { wakeRunId } : undefined),
    };
  }

  async completeRunTransition(transition: CompletedRunTransition): Promise<void> {
    const { effects, next, wakeRunId } = transition;
    this.host.runAbortControllers.delete(effects.run.runId);
    this.host.streams.deleteRun(effects.run.runId);
    this.completeRunFinish(effects);
    console.log(`[Process] Finished run ${effects.run.runId}`);

    if (wakeRunId && next?.runId !== wakeRunId) {
      void this.host.signals
        .changed(["queue"], {
          enqueuedRunId: wakeRunId,
        })
        .catch((error) => {
          console.warn(
            `[Process] Failed to emit queued runtime wake for ${effects.run.runId}: ${errorMessageFromUnknown(error)}`,
          );
        });
    }
    await this.host.controller.promoteNextQueuedRun(next);
  }

  recordRunFinish(run: RunState, options: RunFinishOptions): RunFinishEffects {
    const payload = this.runFinishedPayload(run, options);
    const startedAt = this.host.trace.runStartedAt(run.runId);
    this.host.trace.finishRunPersistence(
      run.runId,
      payload.status === "ok" ? "ok" : payload.status === "error" ? "error" : "aborted",
      payload.timestamp,
    );
    this.host.store.epochs.recordContextEpochRun(
      run.runId,
      jsonObjectSchema.parse(JSON.parse(JSON.stringify(payload))),
      payload.timestamp,
    );
    const newlyFinished = this.host.finishDelivery.record(payload);
    return {
      run,
      payload,
      startedAt,
      newlyFinished,
      cleanupKeys:
        !run.outputMediaPersisted && run.stagedOutputMediaKeys?.length
          ? [...run.stagedOutputMediaKeys]
          : [],
    };
  }

  completeRunFinish(effects: RunFinishEffects): void {
    const { run, payload, startedAt, newlyFinished, cleanupKeys } = effects;
    this.host.trace.releaseRun(run.runId);
    if (cleanupKeys.length > 0) {
      this.host.startBackground(
        `unfinished reply media cleanup for ${run.runId}`,
        this.host.resources.deleteUnreferencedActiveMedia(cleanupKeys),
      );
    }
    if (newlyFinished) {
      const telemetryProperties: RunFinishedTelemetryProperties = {
        outcome: payload.status,
        durationMs: Math.max(0, payload.timestamp - (startedAt ?? payload.timestamp)),
        runKind: run.returnToCaller ? "ipc" : run.conversationId ? "interactive" : "background",
        delivery: payload.delivery.kind,
        queued: payload.queuedCount > 0,
      };
      if (payload.usage) {
        telemetryProperties.inputTokens = payload.usage.input;
        telemetryProperties.outputTokens = payload.usage.output;
        telemetryProperties.cacheReadTokens = payload.usage.cacheRead;
        telemetryProperties.cacheWriteTokens = payload.usage.cacheWrite;
      }
      emitTelemetry(this.host.env, {
        installationId: this.host.installationId,
        component: "gateway",
        event: {
          stream: "operational",
          name: "process.run.finished",
          properties: telemetryProperties,
        },
      });
    }
    this.host.startBackground(
      `finish delivery for ${run.runId}`,
      this.host.finishDelivery.deliver(run.runId),
    );
  }

  runFinishedPayload(
    run: RunState,
    options: RunFinishOptions,
    queuedCount = this.host.store.queue.queueSize(),
    timestamp = Date.now(),
  ): RunFinishPayload {
    const result: RunResult = { text: options.resultText ?? null };
    if (run.outputMediaPersisted && run.outputMedia?.length) {
      result.media = run.outputMedia.map((item) =>
        this.host.resources.runOutputMediaResource(item),
      );
    }
    const payload: RunFinishPayload = {
      pid: this.host.pid,
      runId: run.runId,
      status: options.status ?? "ok",
      result,
      delivery: options.delivery ?? { kind: "none" },
      queuedCount,
      timestamp,
    };
    if (options.reason) payload.reason = options.reason;
    if (options.error) payload.error = options.error;
    if (options.usage !== undefined) payload.usage = options.usage;
    if (options.status === "aborted") payload.aborted = true;
    return payload;
  }

  async generateAssistantResponse(options: {
    runId: string;
    config: AiConfigResult;
    aiTextGenerateConfig?: AiTextGenerateConfig;
    context: Context;
    sessionAffinityKey?: string;
    streamSeq?: StreamSeqCounter;
    traceSpanId?: string;
  }): Promise<AssistantMessage | null> {
    const executor = options.config.executor;
    const attribution = await this.buildInferenceAttribution(options.config, "run", options.runId);
    if (executor.kind === "process" && executor.pid === this.host.pid) {
      return await this.generateAssistantResponseLocally(options, attribution);
    }
    const result = await this.host.kernel.kernelRpc(
      "ai.text.generate",
      this.buildAiTextGenerateArgs({
        config: options.aiTextGenerateConfig,
        context: options.context,
        sessionAffinityKey: options.sessionAffinityKey,
        target: executor.kind === "device" ? executor.target : undefined,
      }),
      this.runAbortSignal(options.runId),
      attribution.logicalRequestId,
    );
    return adaptGeneratedAssistantMessage(result.message);
  }

  async generateAssistantResponseLocally(
    options: {
      runId: string;
      config: AiConfigResult;
      aiTextGenerateConfig?: AiTextGenerateConfig;
      context: Context;
      sessionAffinityKey?: string;
      streamSeq?: StreamSeqCounter;
      traceSpanId?: string;
    },
    attribution: InferenceAttribution,
  ): Promise<AssistantMessage | null> {
    const routedFetch = this.host.kernel.createGenerationFetch(options.config, options.runId);
    const signal = this.runAbortSignal(options.runId);
    const request: Parameters<(typeof this.host.generation)["generate"]>[0] = {
      config: options.config,
      context: options.context,
      sessionAffinityKey: options.sessionAffinityKey,
      signal,
      attribution,
    };
    if (routedFetch) {
      request.fetch = routedFetch;
    }
    if (options.config.generationStreaming === "off" || !this.host.generation.stream) {
      return await this.host.generation.generate(request);
    }

    // TODO: add ai.text.stream
    const stream = this.host.generation.stream(request);
    const eventSink = await this.host.streams.openRunEventSink(options.runId);
    try {
      let seq = options.streamSeq?.value ?? 0;
      let response: AssistantMessage | null = null;
      for await (const event of stream) {
        seq += 1;
        if (options.streamSeq) {
          options.streamSeq.value = seq;
        }
        this.host.trace.recordGenerationEvent(options.runId, options.traceSpanId, event);
        await eventSink?.emit(seq, event);
        if (event.type === "done") {
          response = event.message;
        } else if (event.type === "error") {
          response = event.error;
        }
        if (this.host.handleRunStopped(options.runId)) {
          return null;
        }
      }

      return response ?? (await stream.result());
    } finally {
      await eventSink?.close();
    }
  }

  async generateCompactionText(options: {
    config: AiConfigResult;
    context: Context;
    options: AiTextGenerateOptions;
    sessionAffinityKey: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const executor = options.config.executor;
    const attribution = await this.buildInferenceAttribution(
      options.config,
      "compaction",
      this.host.runs.active?.runId,
      options.sessionAffinityKey,
    );
    if (executor.kind !== "process" || executor.pid !== this.host.pid) {
      const result = await this.host.kernel.kernelRpc(
        "ai.text.generate",
        this.buildAiTextGenerateArgs({
          context: options.context,
          options: options.options,
          sessionAffinityKey: options.sessionAffinityKey,
          target: executor.kind === "device" ? executor.target : undefined,
        }),
        options.signal,
        attribution.logicalRequestId,
      );
      return result.text ?? "";
    }
    const routedFetch = this.host.kernel.createGenerationFetch(
      options.config,
      this.host.runs.active?.runId,
    );
    const request: Parameters<(typeof this.host.generation)["generateText"]>[0] = {
      config: options.config,
      context: options.context,
      options: options.options,
      sessionAffinityKey: options.sessionAffinityKey,
      signal: options.signal,
      attribution,
    };
    if (routedFetch) {
      request.fetch = routedFetch;
    }
    return await this.host.generation.generateText(request);
  }

  async buildInferenceAttribution(
    config: Pick<AiConfigResult, "provider" | "model">,
    purpose: "run" | "compaction",
    runId?: string,
    purposeKey?: string,
  ): Promise<InferenceAttribution> {
    const { lastMessageId } = this.host.store.messages.messageStats();
    const actor: InferenceAttribution["actor"] = {
      localUid: this.host.identity.uid,
      processId: this.host.pid,
    };
    if (runId) {
      actor.runId = runId;
    }
    return {
      installationId: this.host.installationId,
      logicalRequestId: await inferenceLogicalRequestId([
        "process",
        this.host.installationId,
        this.host.pid,
        purpose,
        runId,
        this.host.store.state.getHistoryGeneration(),
        lastMessageId,
        config.provider.trim().toLowerCase(),
        config.model.trim().toLowerCase(),
        purposeKey,
      ]),
      actor,
      workload:
        purpose === "compaction"
          ? "compaction"
          : this.host.runs.active?.returnToCaller
            ? "ipc"
            : this.host.runs.active?.conversationId
              ? "interactive"
              : "background",
    };
  }

  buildAiTextGenerateArgs(options: {
    config?: AiTextGenerateConfig;
    context: Context;
    options?: AiTextGenerateOptions;
    sessionAffinityKey?: string;
    target?: string;
  }): ArgsOf<"ai.text.generate"> {
    const config = options.config ?? this.host.settings.aiTextGenerateConfig;
    const args: ArgsOf<"ai.text.generate"> = {
      systemPrompt: options.context.systemPrompt,
      messages: options.context.messages.map(adaptContextMessage),
    };
    if (options.target) args.target = options.target;
    if (options.context.tools?.length) {
      args.tools = options.context.tools.map(adaptContextTool);
    }
    if (config) args.config = config;
    if (options.options) args.options = options.options;
    if (options.sessionAffinityKey) {
      args.sessionAffinityKey = options.sessionAffinityKey;
    }
    return args;
  }

  recordUnpersistedAssistantUsage(
    response: AssistantMessage,
    config: AiConfigResult,
  ): ProcUsageState | undefined {
    const usage = buildAssistantMessageMetadata(response, config)?.usage;
    if (usage) {
      this.host.store.state.addHistoryUsage(usage);
    }
    return usage;
  }

  private async announceGenerationRetry<Payload extends JsonObject>(
    runId: string,
    payload: Payload,
  ): Promise<boolean> {
    if (this.host.handleRunStopped(runId)) return false;
    await this.host.sendSignal("proc.run.retrying", {
      pid: this.host.pid,
      runId,
      ...payload,
      timestamp: Date.now(),
    });
    return !this.host.handleRunStopped(runId);
  }

  async beginGenerationRetry(options: {
    runId: string;
    attempt: number;
    maxAttempts: number;
    reason: string;
    cause: string;
  }): Promise<"retry" | "stopped"> {
    console.warn(
      `[Process] Retrying LLM generation after ${options.cause} ` +
        `(${options.attempt}/${options.maxAttempts}): ${options.reason}`,
    );
    const announced = await this.announceGenerationRetry(options.runId, {
      attempt: options.attempt,
      nextAttempt: options.attempt + 1,
      maxAttempts: options.maxAttempts,
      reason: options.reason,
    });
    return announced ? "retry" : "stopped";
  }

  async beginGenerationFallback(options: {
    runId: string;
    reason: string;
    from: AiConfigResult;
    to: AiConfigResult;
    fallbackIndex: number;
    fallbackCount: number;
  }): Promise<"fallback" | "stopped"> {
    console.warn(
      `[Process] Switching LLM generation from ${formatAiModelStackLabel(options.from)} ` +
        `to fallback ${formatAiModelStackLabel(options.to)}: ${options.reason}`,
    );
    const announced = await this.announceGenerationRetry(options.runId, {
      attempt: options.fallbackIndex,
      nextAttempt: options.fallbackIndex + 1,
      maxAttempts: options.fallbackCount + 1,
      reason: options.reason,
      fallback: {
        from: {
          provider: options.from.provider,
          model: options.from.model,
        },
        to: {
          provider: options.to.provider,
          model: options.to.model,
        },
      },
    });
    return announced ? "fallback" : "stopped";
  }

  async runGenerationCycle(
    runId: string,
    prepared: PreparedRunTickContext,
  ): Promise<GeneratedRunTick | RunTickContinuation | null> {
    const control: RunTickGenerationControl = {
      prepared,
      primaryConfig: prepared.activeConfig,
      fallbackConfigs: prepared.activeConfig.fallbacks ?? [],
      fallbackIndex: 0,
    };
    const streamSeq: StreamSeqCounter = { value: 0 };
    let attempt = 1;
    for (;;) {
      const outcome = await this.generateRunTickAttempt(runId, control, streamSeq, attempt);
      switch (outcome.kind) {
        case "complete":
          return outcome.result;
        case "retry":
          if (outcome.advanceAttempt) attempt += 1;
          break;
        case "fallback":
          attempt = 1;
      }
    }
  }

  async generateRunTickAttempt(
    runId: string,
    control: RunTickGenerationControl,
    streamSeq: StreamSeqCounter,
    attempt: number,
  ): Promise<RunTickGenerationAttemptOutcome> {
    const config = control.prepared.activeConfig;
    const inferenceSpanId = this.host.trace.start({
      runId,
      kind: "inference",
      name: `${config.provider} · ${config.model}`,
      attributes: { provider: config.provider, model: config.model, attempt },
    });
    let response: AssistantMessage | null;
    try {
      response = await this.generateAssistantResponse({
        runId,
        config: control.prepared.activeConfig,
        aiTextGenerateConfig: control.prepared.run.aiTextGenerateConfig,
        context: control.prepared.context,
        sessionAffinityKey: this.host.pid,
        streamSeq,
        traceSpanId: inferenceSpanId ?? undefined,
      });
      if (this.host.handleRunStopped(runId)) {
        this.host.trace.finish(inferenceSpanId, "aborted");
        return { kind: "complete", result: null };
      }
      const failure = response
        ? describeAssistantResponseFailure(response)
        : "Provider returned no response";
      this.host.trace.finish(inferenceSpanId, failure ? "error" : "ok");
    } catch (error) {
      this.host.trace.finish(inferenceSpanId, "error");
      return await this.handleRunTickGenerationError(
        runId,
        control,
        attempt,
        errorMessageFromUnknown(error),
      );
    } finally {
      this.host.trace.finishGenerationPhase(inferenceSpanId);
    }
    if (!response) {
      return { kind: "complete", result: null };
    }
    return await this.handleRunTickGenerationResponse(
      runId,
      control,
      attempt,
      response,
      inferenceSpanId,
    );
  }

  async handleRunTickGenerationError(
    runId: string,
    control: RunTickGenerationControl,
    attempt: number,
    message: string,
  ): Promise<RunTickGenerationAttemptOutcome> {
    if (this.host.handleRunStopped(runId)) {
      return { kind: "complete", result: null };
    }
    const config = control.prepared.activeConfig;
    if (isProviderContextOverflowErrorMessage(message, {
      provider: config.provider,
      model: config.model,
      contextWindowTokens: config.contextWindowTokens,
    })) {
      const recovered = await this.recoverRunTickProviderOverflow(runId, control, message);
      return recovered
        ? { kind: "retry", advanceAttempt: false }
        : { kind: "complete", result: null };
    }
    if (
      isRetryableGenerationErrorMessage(message) &&
      attempt < MAX_RETRYABLE_GENERATION_ATTEMPTS
    ) {
      const retry = await this.beginGenerationRetry({
        runId,
        attempt,
        maxAttempts: MAX_RETRYABLE_GENERATION_ATTEMPTS,
        reason: message,
        cause: "retryable provider error",
      });
      return retry === "retry"
        ? { kind: "retry", advanceAttempt: true }
        : { kind: "complete", result: null };
    }
    const fallback = await this.switchRunTickFallback(runId, control, message);
    if (fallback === "switched") return { kind: "fallback" };
    if (fallback === "stopped") {
      return { kind: "complete", result: null };
    }
    console.error("[Process] LLM call failed:", message);
    return {
      kind: "complete",
      result: await this.generationFailure(runId, control, "generation.error", message),
    };
  }

  async handleRunTickGenerationResponse(
    runId: string,
    control: RunTickGenerationControl,
    attempt: number,
    response: AssistantMessage,
    inferenceSpanId: string | null,
  ): Promise<RunTickGenerationAttemptOutcome> {
    const config = control.prepared.activeConfig;
    const failure = describeAssistantResponseFailure(response);
    if (!failure) {
      return {
        kind: "complete",
        result: {
          prepared: control.prepared,
          response,
          fallbackMetadata: control.fallbackMetadata,
          inferenceSpanId,
        },
      };
    }
    const message = response.errorMessage ?? failure ?? "Provider context overflow";
    if (isProviderContextOverflow(response, config.contextWindowTokens)) {
      const recovered = await this.recoverRunTickProviderOverflow(
        runId,
        control,
        message,
        response,
      );
      return recovered
        ? { kind: "retry", advanceAttempt: false }
        : { kind: "complete", result: null };
    }
    if (
      isRetryableAssistantResponseFailure(response, failure) &&
      attempt < MAX_RETRYABLE_GENERATION_ATTEMPTS
    ) {
      this.recordUnpersistedAssistantUsage(response, config);
      const retry = await this.beginGenerationRetry({
        runId,
        attempt,
        maxAttempts: MAX_RETRYABLE_GENERATION_ATTEMPTS,
        reason: failure ?? message,
        cause: hasRawToolCallMarkupOutput(response)
          ? "malformed assistant response"
          : "empty assistant response",
      });
      return retry === "retry"
        ? { kind: "retry", advanceAttempt: true }
        : { kind: "complete", result: null };
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const fallback = await this.switchRunTickFallback(runId, control, message, response);
      if (fallback === "switched") return { kind: "fallback" };
      if (fallback === "stopped") return { kind: "complete", result: null };
    }
    return {
      kind: "complete",
      result: await this.generationFailure(runId, control, "generation.empty", message, response),
    };
  }

  async switchRunTickFallback(
    runId: string,
    control: RunTickGenerationControl,
    reason: string,
    failedResponse?: AssistantMessage,
  ): Promise<"switched" | "stopped" | "none"> {
    const current = control.prepared.activeConfig;
    const fallback = nextAiConfigFallback(
      control.primaryConfig,
      current,
      control.fallbackConfigs,
      control.fallbackIndex,
    );
    if (!fallback) return "none";
    control.fallbackIndex = fallback.nextIndex;
    if (failedResponse) this.recordUnpersistedAssistantUsage(failedResponse, current);
    const fallbackState = await this.beginGenerationFallback({
      runId,
      reason,
      from: current,
      to: fallback.config,
      fallbackIndex: control.fallbackIndex,
      fallbackCount: control.fallbackConfigs.length,
    });
    if (fallbackState === "stopped") return "stopped";
    control.fallbackMetadata = {
      used: true,
      from: modelMetadataFromAiConfig(current),
      to: modelMetadataFromAiConfig(fallback.config),
      reason,
    };
    control.prepared.activeConfig = fallback.config;
    const run = this.host.mutateActiveRun(runId, (active) => ({
      ...active,
      config: fallback.config,
    }));
    if (!run) return "stopped";
    control.prepared.run = run;
    const ready = await this.prepareRunTickGenerationContext(runId, control.prepared);
    return ready && !this.host.handleRunStopped(runId) ? "switched" : "stopped";
  }

  async recoverRunTickProviderOverflow(
    runId: string,
    control: RunTickGenerationControl,
    message: string,
    failedResponse?: AssistantMessage,
  ): Promise<boolean> {
    const state = control.prepared;
    if (failedResponse) {
      const usage = this.recordUnpersistedAssistantUsage(failedResponse, state.activeConfig);
      state.contextState = await this.host.history.updateContextState(
        runId,
        state.activeConfig,
        state.context,
        { confirmedUsage: failedResponse.usage, usageState: usage },
      );
      if (this.host.handleRunStopped(runId)) return false;
    }
    if (state.autoCompactionPressure !== null) {
      await this.host.history.finishProviderContextOverflowRun(runId, state.activeConfig, message);
      return false;
    }
    const policy = await this.applyRunTickContextPolicy(runId, state, "provider-overflow");
    if (policy !== "compacted") {
      if (policy === "ready" && !this.host.handleRunStopped(runId)) {
        await this.host.history.finishProviderContextOverflowRun(
          runId,
          state.activeConfig,
          message,
        );
      }
      return false;
    }
    const retry = await this.beginGenerationRetry({
      runId,
      attempt: 1,
      maxAttempts: 2,
      reason: message,
      cause: "provider context overflow",
    });
    return retry === "retry";
  }

  async generationFailure(
    runId: string,
    control: RunTickGenerationControl,
    reason: "generation.error" | "generation.empty",
    message: string,
    response?: AssistantMessage,
  ): Promise<RunTickContinuation | null> {
    if (response) {
      this.recordUnpersistedAssistantUsage(response, control.prepared.activeConfig);
    }
    const config = control.prepared.activeConfig;
    const displayError = formatGenerationFailure(message, {
      provider: config.provider,
      model: config.model,
    });
    if (reason === "generation.empty") console.error(`[Process] ${message}`);
    await this.host.history.appendSystemMessage(runId, displayError);
    if (this.host.handleRunStopped(runId)) return null;
    return {
      kind: "finish",
      options: { reason, status: "error", resultText: null, error: displayError },
    };
  }

  async executeAndPersistRunControl(
    runId: string,
    turn: AssistantTurnClassification,
    outputMedia: RunOutputMedia[],
    dispatchId: string | null,
  ): Promise<{
    result: RunControlResult | null;
  } | null> {
    if (turn.kind !== "run-control") {
      if (dispatchId) throw new Error("Non-run-control turn registered a run-control action");
      return { result: null };
    }
    const call = turn.runControlCalls[0];
    if (!call) throw new Error("Run-control turn omitted its command");
    if (!dispatchId) throw new Error("Run-control turn omitted its tool registration");
    let result: RunControlResult;
    try {
      result = await this.executeRunControlAction(
        runId,
        call.toolCall.id,
        call.parsed,
        outputMedia,
      );
    } catch (error) {
      this.persistRunControlExecutionError(
        runId,
        dispatchId,
        call.toolCall.id,
        errorMessageFromUnknown(error),
      );
      throw error;
    }
    const persisted = this.persistRunControlToolResult(runId, dispatchId, call.toolCall.id, result);
    if (!persisted) return null;
    await this.host.signals.changed(["messages"], { runId });
    return this.host.handleRunStopped(runId) ? null : { result };
  }

  persistRunControlToolResult(
    runId: string,
    dispatchId: string,
    toolCallId: string,
    result: RunControlResult,
  ): boolean {
    return this.host.ctx.storage.transactionSync(() => {
      const active = this.host.runs.active;
      if (this.host.killed || !active || active.runId !== runId) return false;
      if (!hasRunControlRegistration(this.host, runId, dispatchId, toolCallId)) {
        throw new Error("Run-control tool registration was lost before its result");
      }
      const updated = result.ok ? active : incrementRunControlFailure(active, result.failureKind);
      const attempt = result.ok ? null : runControlFailureAttempt(updated, result.failureKind);
      if (updated !== active) this.host.runs.active = updated;
      const content = formatRunControlToolResult(result, attempt);
      if (result.ok) {
        this.host.store.tools.resolve(dispatchId, content, "completed");
      } else {
        this.host.store.tools.fail(dispatchId, result.error, "failed");
      }
      this.host.store.messages.appendToolResult(
        toolCallId,
        "shell.exec",
        content,
        !result.ok,
        runId,
        result.ok ? "completed" : "failed",
      );
      this.host.store.tools.clearRun(runId);
      return true;
    });
  }

  persistRunControlExecutionError(
    runId: string,
    dispatchId: string,
    toolCallId: string,
    error: string,
  ): void {
    this.host.ctx.storage.transactionSync(() => {
      const active = this.host.runs.active;
      if (this.host.killed || !active || active.runId !== runId) return;
      if (!hasRunControlRegistration(this.host, runId, dispatchId, toolCallId)) return;
      const message = `Run-control execution failed: ${error}`;
      this.host.store.tools.fail(dispatchId, message, "failed");
      this.host.store.messages.appendToolResult(
        toolCallId,
        "shell.exec",
        message,
        true,
        runId,
        "failed",
      );
      this.host.store.tools.clearRun(runId);
    });
  }

  async persistRunTickAssistant(
    runId: string,
    generated: GeneratedRunTick,
  ): Promise<PersistedRunTick | null> {
    const { prepared, response, fallbackMetadata, inferenceSpanId } = generated;
    const turn = classifyAssistantTurn(
      response,
      prepared.workTools.map((tool) => tool.name),
    );
    let outputMedia =
      turn.toolCalls.length === 0 && turn.unofferedToolCalls.length === 0
        ? this.host.runs.active?.runId === runId
          ? (this.host.runs.active.outputMedia ?? [])
          : []
        : [];
    if (outputMedia.length > 0) {
      outputMedia = await this.host.resources.promoteRunOutputMedia(runId);
      if (this.host.handleRunStopped(runId)) return null;
    }
    const outputSent = await this.emitRunTickOutput(runId, turn, outputMedia, fallbackMetadata);
    if (!outputSent) return null;

    const activeRun = this.host.runs.active;
    if (!activeRun || activeRun.runId !== runId) return null;
    prepared.run = activeRun;
    const assistantMetadata = buildAssistantMessageMetadata(
      response,
      prepared.activeConfig,
      fallbackMetadata,
      activeRun.contextEpochId,
      activeRun.generationContextId,
    );
    const assistantHistory = this.persistRunTickAssistantHistory(
      runId,
      turn,
      outputMedia,
      assistantMetadata,
    );
    if (!assistantHistory) return null;
    if (inferenceSpanId) {
      this.host.store.traces.setTraceSpanReference(inferenceSpanId, {
        kind: "message",
        messageId: assistantHistory.messageId,
      });
    }
    this.schedulePromotedMediaCleanup(runId, outputMedia);

    const control = await this.executeAndPersistRunControl(
      runId,
      turn,
      outputMedia,
      assistantHistory.runControlDispatchId,
    );
    if (!control) return null;
    const finalContext = await this.buildRunTickContext(runId, prepared, {
      recoverResponsibilities: false,
      refreshProjection: false,
    });
    if (!finalContext || this.host.handleRunStopped(runId)) return null;
    prepared.context = finalContext;
    prepared.contextState = await this.host.history.updateContextState(
      runId,
      prepared.activeConfig,
      finalContext,
      { usageState: assistantMetadata?.usage },
    );
    if (this.host.handleRunStopped(runId)) return null;
    const continuationRun = this.host.runs.active;
    if (!continuationRun || continuationRun.runId !== runId) {
      return null;
    }
    prepared.run = continuationRun;
    return {
      ...generated,
      turn,
      outputMedia,
      runControlResult: control.result,
      assistantMetadata,
    };
  }

  async emitRunTickOutput(
    runId: string,
    turn: AssistantTurnClassification,
    outputMedia: RunOutputMedia[],
    fallback?: MessageMetadata["fallback"],
  ): Promise<boolean> {
    if (!turn.text.trim() && turn.thinking.length === 0 && outputMedia.length === 0) {
      return !this.host.handleRunStopped(runId);
    }
    const payload: JsonObject = {
      text: turn.text,
      thinking: jsonValueSchema.parse(turn.thinking),
      pid: this.host.pid,
      runId,
    };
    if (outputMedia.length > 0) {
      payload.media = outputMedia.map((item) => this.host.resources.runOutputMediaResource(item));
    }
    if (fallback) payload.fallback = fallback;
    await this.host.sendSignal("proc.run.output", payload);
    return !this.host.handleRunStopped(runId);
  }

  persistRunTickAssistantHistory(
    runId: string,
    turn: AssistantTurnClassification,
    outputMedia: RunOutputMedia[],
    metadata: MessageMetadata | undefined,
  ): PersistedAssistantHistory | null {
    return this.host.ctx.storage.transactionSync(() => {
      const run = this.host.runs.active;
      if (this.host.killed || !run || run.runId !== runId) return null;
      const options: Parameters<ProcessStore["messages"]["appendMessage"]>[2] = {
        runId,
        toolCalls: stringifyAssistantMessageMeta({
          thinking: turn.thinking,
          toolCalls: turn.returnedToolCalls,
        }),
        metadata,
      };
      if (outputMedia.length > 0) {
        options.media = stringifyStoredProcessMedia(outputMedia) ?? undefined;
      }
      const messageId = this.host.store.messages.appendMessage("assistant", turn.text, options);
      if (outputMedia.length > 0) {
        this.host.runs.active = { ...run, outputMediaPersisted: true };
      }
      return {
        messageId,
        runControlDispatchId: this.persistRunTickToolCalls(runId, turn),
      };
    });
  }

  persistRunTickToolCalls(runId: string, turn: AssistantTurnClassification): string | null {
    if (turn.kind === "run-control") {
      const call = turn.runControlCalls[0];
      if (!call) throw new Error("Run-control turn omitted its command");
      const dispatchId = crypto.randomUUID();
      this.host.store.tools.register(
        dispatchId,
        call.toolCall.id,
        runId,
        PENDING_RUN_CONTROL_CALL,
        jsonObjectSchema.parse(call.toolCall.arguments),
      );
      return dispatchId;
    }
    const invalidRunControl = turn.kind === "invalid-run-control";
    for (const toolCall of turn.toolCalls) {
      if (invalidRunControl) {
        this.appendInvalidRunControlToolResult(runId, toolCall);
        continue;
      }
      const syscall = TOOL_TO_SYSCALL[toolCall.name];
      const args = jsonObjectSchema.parse(toolCall.arguments);
      const prepared = syscall
        ? this.host.tools.prepareToolArgs(syscall, args)
        : { args, missingShellSessionTarget: false };
      const dispatchId = crypto.randomUUID();
      this.host.store.tools.register(
        dispatchId,
        toolCall.id,
        runId,
        syscall ?? toolCall.name,
        prepared.args,
      );
      if (prepared.missingShellSessionTarget) {
        this.host.store.tools.fail(dispatchId, UNKNOWN_SHELL_SESSION_TARGET_MESSAGE);
      }
    }
    for (const toolCall of turn.unofferedToolCalls) {
      const syscall = TOOL_TO_SYSCALL[toolCall.name];
      this.host.store.messages.appendToolResult(
        toolCall.id,
        syscall ?? toolCall.name,
        `Tool "${toolCall.name}" was not offered for this generation`,
        true,
        runId,
        "failed",
      );
    }
    if (invalidRunControl) {
      for (const { toolCall } of turn.runControlCalls) {
        this.appendInvalidRunControlToolResult(runId, toolCall);
      }
    }
    return null;
  }

  appendInvalidRunControlToolResult(runId: string, toolCall: ToolCall): void {
    this.host.store.messages.appendToolResult(
      toolCall.id,
      TOOL_TO_SYSCALL[toolCall.name] ?? toolCall.name,
      "message send and yield must be issued separately from other tool actions",
      true,
      runId,
      "failed",
    );
  }

  schedulePromotedMediaCleanup(runId: string, outputMedia: RunOutputMedia[]): void {
    if (outputMedia.length === 0 || this.host.runs.active?.runId !== runId) return;
    const stagedKeys = [...(this.host.runs.active.stagedOutputMediaKeys ?? [])];
    if (stagedKeys.length === 0) return;
    void this.host.resources.deleteUnreferencedActiveMedia(stagedKeys).catch((error) => {
      console.warn(
        `[Process] Failed to clean promoted reply media for ${runId}: ${errorMessageFromUnknown(error)}`,
      );
    });
  }

  decideRunTickContinuation(runId: string, persisted: PersistedRunTick): RunTickContinuation | null {
    const run = this.host.runs.active;
    if (!run || run.runId !== runId) return null;
    const result = persisted.runControlResult;
    if (persisted.turn.kind === "tools") return { kind: "dispatch-or-wait" };
    if (persisted.turn.kind === "unoffered-tools") return { kind: "schedule" };
    if (persisted.turn.kind !== "run-control") {
      if (!run.returnToCaller) {
        return {
          kind: "yield-correction",
          usage: persisted.response.usage,
          text: persisted.turn.text,
        };
      }
      return {
        kind: "finish",
        options: {
          reason: "ipc.returned",
          status: "ok",
          resultText: persisted.turn.text || null,
          delivery: { kind: "none" },
          usage: persisted.response.usage,
        },
      };
    }
    if (!result) throw new Error("Run-control finish omitted its result");
    if (!result.ok) {
      if (!isRunControlFailureExhausted(run, result.failureKind)) return { kind: "schedule" };
      return {
        kind: "finish",
        options: {
          reason:
            result.failureKind === "command" ? "message.command.failed" : "message.delivery.failed",
          status: "error",
          resultText: null,
          error: result.error,
          usage: persisted.response.usage,
        },
      };
    }
    if (!result.finish) return { kind: "schedule" };
    return {
      kind: "finish",
      options: {
        reason: run.returnToCaller ? "ipc.returned" : "run.yielded",
        status: "ok",
        resultText: result.action === "message" ? result.text : persisted.turn.text || null,
        delivery: result.delivery,
        usage: persisted.response.usage,
      },
      responsibilityAdmissionKey: result.responsibilityAdmissionKey,
    };
  }

  async applyRunTickContinuation(runId: string, continuation: RunTickContinuation): Promise<void> {
    switch (continuation.kind) {
      case "finish":
        await this.finishRun(runId, continuation.options, continuation.responsibilityAdmissionKey);
        return;
      case "schedule":
        await this.scheduleTick(runId);
        return;
      case "dispatch-or-wait": {
        const pendingHil = await this.host.tools.processToolCalls(runId);
        if (this.host.handleRunStopped(runId) || pendingHil) return;
        if (
          this.host.store.tools.getResults(runId).length > 0 &&
          this.host.store.tools.isRunResolved(runId)
        ) {
          await this.scheduleTick(runId);
        }
        return;
      }
      case "yield-correction":
        await this.requireRunYield(runId, continuation.usage, continuation.text);
        return;
    }
  }

  consumeRunOutputMedia(runId: string, media: RunOutputMedia[]): void {
    const run = this.host.runs.active;
    if (!run || run.runId !== runId || media.length === 0) return;
    const consumed = new Set(media.map((item) => item.key));
    run.outputMedia = (run.outputMedia ?? []).filter((item) => !consumed.has(item.key));
    if (run.outputMedia.length === 0) {
      delete run.outputMedia;
      delete run.outputMediaPersisted;
      delete run.stagedOutputMediaKeys;
    }
    this.host.runs.active = run;
  }

  async alarm(): Promise<void> {
    if (this.host.resetTransition) await this.host.resetTransition;
    if (this.host.killTransition) await this.host.killTransition;
    if (this.host.killed) {
      if (this.host.killedTombstone?.cleanup === "pending") {
        await this.host.controller.completeKilledProcessCleanup();
      }
      return;
    }
    if (this.host.lifecyclePhase !== "ready") return;
    await this.host.tasks.alarm();
  }

  schedule(
    when: Date | number,
    callback: ProcessTaskCallback,
    payload: ProcessTask["payload"],
    options?: DurableTaskOptions,
  ) {
    const task = PROCESS_TASK_SCHEMA.parse({ callback, payload });
    return this.host.tasks.schedule(when, task, options);
  }

  async runScheduledTask(task: DurableTask<ProcessTask>): Promise<void> {
    switch (task.callback) {
      case "onMediaPreparationTimeout":
        await this.onMediaPreparationTimeout(task.payload);
        return;
      case "onRunFinishDelivery":
        await this.host.finishDelivery.deliver(task.payload);
        return;
      case "onToolDispatchTimeout":
        await this.onToolDispatchTimeout(task.payload);
        return;
      case "tick":
        await this.tick(task.payload, true);
        return;
    }
  }

  async scheduleTick(runId: string, delayMs = 10, requireSuccessor = false): Promise<void> {
    if (this.host.killed || this.host.lifecyclePhase !== "ready") {
      return;
    }
    const run = this.host.runs.active;
    if (!run || run.runId !== runId) {
      return;
    }
    const next = new Date(Date.now() + delayMs);
    await this.schedule(
      next,
      "tick",
      {
        runId,
        generation: run.tickGeneration ?? 0,
      },
      { idempotent: !requireSuccessor },
    );
  }

  async pauseManagedRun(runId: string, requireTickSuccessor = false): Promise<boolean> {
    const gate = await this.managedWorkGate();
    if (this.host.handleRunStopped(runId)) return true;
    if (gate.allowed) return false;
    await this.scheduleTick(runId, MANAGED_LIFECYCLE_RECHECK_MS, requireTickSuccessor);
    return true;
  }

  async managedWorkGate() {
    return await managedInstallationWorkGate(this.host.env, this.host.installationId);
  }

  async onMediaPreparationTimeout(runId: string): Promise<void> {
    if (this.host.killed || this.host.lifecyclePhase !== "ready") {
      return;
    }
    const run = this.host.runs.active;
    if (run?.runId !== runId || run.pendingMediaMessageId === undefined) {
      return;
    }
    await this.host.resources.failPendingMedia(
      runId,
      run.pendingMediaMessageId,
      `Message media preparation timed out after ${MEDIA_PREPARATION_TIMEOUT_MS}ms`,
      "media.timeout",
    );
  }

  async onToolDispatchTimeout(input: { runId: string; dispatchId: string }): Promise<void> {
    const { runId, dispatchId } = input;
    if (this.host.handleRunStopped(runId)) {
      return;
    }
    const tool = this.host.store.tools
      .getResults(runId)
      .find((result) => result.dispatchId === dispatchId);
    if (tool?.status === "pending") {
      this.host.startBackground(
        `tool timeout cancellation for ${dispatchId}`,
        cancelProcessRequests(
          this.host.installationId,
          this.host.pid,
          [dispatchId],
          "Tool execution timed out",
        ).catch(() => 0),
      );
      await this.host.tools.failStartedTool(
        runId,
        dispatchId,
        `Tool execution timed out after ${TOOL_DISPATCH_TIMEOUT_MS}ms`,
      );
    } else if (tool?.status === "registered") {
      await this.scheduleTick(runId);
    }
  }

  async tick(
    input: { runId: string; generation: number },
    requireRestrictionSuccessor = false,
  ): Promise<void> {
    const { runId, generation } = input;
    if (this.host.killed || this.host.lifecyclePhase !== "ready") {
      return;
    }
    const run = this.host.runs.active;
    if (!run || run.runId !== runId || (run.tickGeneration ?? 0) !== generation) {
      return;
    }

    if (await this.pauseManagedRun(runId, requireRestrictionSuccessor)) {
      return;
    }

    run.tickGeneration = generation + 1;
    this.host.runs.active = run;
    if (this.host.activeTickRunIds.has(runId)) {
      this.host.deferredTickRunIds.add(runId);
      return;
    }

    this.host.activeTickRunIds.add(runId);
    try {
      await this.runTick(runId);
    } catch (error) {
      if (!this.host.handleRunStopped(runId)) {
        await this.finishRun(runId, {
          reason: "tick.error",
          status: "error",
          resultText: null,
          error: `Process run failed: ${errorMessageFromUnknown(error)}`,
        });
      }
    } finally {
      this.host.activeTickRunIds.delete(runId);
      if (this.host.deferredTickRunIds.delete(runId) && !this.host.handleRunStopped(runId)) {
        try {
          await this.scheduleTick(runId);
        } catch (error) {
          await this.finishRun(runId, {
            reason: "schedule.error",
            status: "error",
            resultText: null,
            error: `Failed to schedule deferred process run: ${errorMessageFromUnknown(error)}`,
          });
        }
      }
    }
  }

  runAbortSignal(runId: string): AbortSignal {
    if (this.host.killed || this.host.lifecyclePhase !== "ready") {
      return AbortSignal.abort(new Error("Process no longer exists"));
    }
    let controller = this.host.runAbortControllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.host.runAbortControllers.set(runId, controller);
    }
    return controller.signal;
  }

  async runTick(runId: string): Promise<void> {
    // Step 1: Collect resolved tool results
    const settled = await this.settleRunTickTools(runId);
    if (!settled) return;
    // Step 2: Load config + tools (first tick only, cached on run state)
    const inputs = await this.loadRunTickInputs(runId, settled);
    if (!inputs) return;
    // Step 3: Build pi-ai Context from one immutable epoch baseline.
    const prepared = await this.prepareRunTickContext(runId, inputs);
    if (!prepared) return;
    // Step 5: Call LLM
    const generated = await this.runGenerationCycle(runId, prepared);
    if (!generated || "kind" in generated) {
      if (!generated) return;
      await this.applyRunTickContinuation(runId, generated);
      return;
    }
    // Step 6: Process response
    const persisted = await this.persistRunTickAssistant(runId, generated);
    if (!persisted) return;
    const continuation = this.decideRunTickContinuation(runId, persisted);
    if (continuation) await this.applyRunTickContinuation(runId, continuation);
  }

  async settleRunTickTools(runId: string): Promise<RunState | null> {
    if (this.host.killed || this.host.lifecyclePhase !== "ready") return null;
    const initialRun = this.host.runs.active;
    if (!initialRun || initialRun.runId !== runId || initialRun.pendingMediaMessageId) return null;

    let toolResults = this.host.store.tools.getResults(runId);
    const pendingApproval = this.host.store.tools.getPendingHilForRun(runId);
    if (toolResults.some((result) => result.status === "registered") && !pendingApproval) {
      await this.host.tools.processToolCalls(runId);
      if (this.host.handleRunStopped(runId)) return null;
      toolResults = this.host.store.tools.getResults(runId);
    }
    if (toolResults.some((result) => result.status === "registered")) {
      return null;
    }
    if (toolResults.some((result) => result.status === "pending")) {
      return null;
    }
    if (toolResults.length > 0) {
      const ingested = await this.host.tools.ingestToolResults(runId, toolResults);
      if (ingested.appended > 0) {
        await this.host.signals.changed(["messages"], { runId });
      }
      if (this.host.handleRunStopped(runId)) return null;
    }

    const run = this.host.runs.active;
    return run?.runId === runId ? run : null;
  }

  async loadRunTickInputs(
    runId: string,
    settledRun: RunState,
  ): Promise<RunTickInputs | null> {
    let run = settledRun;
    if (!run.config) {
      const aiTextGenerateConfig = this.host.settings.aiTextGenerateConfig;
      const config = await this.host.settings.resolveAiConfig(this.runAbortSignal(runId));
      const updated = this.host.mutateActiveRun(runId, (current) => ({
        ...current,
        aiTextGenerateConfig,
        config,
      }));
      if (!updated) return null;
      run = updated;
    }
    const activeConfig = run.config;
    if (!activeConfig) throw new Error("Process AI configuration was not loaded");

    if (!run.tools) {
      const toolsResult = await this.host.kernel.kernelRpc("ai.tools", {});
      const updated = this.host.mutateActiveRun(runId, (current) => ({
        ...current,
        tools: toolsResult.tools,
        devices: toolsResult.devices,
        mcpServers: toolsResult.mcpServers,
      }));
      if (!updated) return null;
      run = updated;
    }

    const workTools: Tool[] = (run.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: piToolParametersSchema.parse(tool.inputSchema),
    }));
    const tools = run.returnToCaller ? workTools : withRunControlInstructions(workTools);
    const offeredToolNames = [...new Set(workTools.map((tool) => tool.name))];
    const offeredRun = this.host.mutateActiveRun(runId, (current) => ({
      ...current,
      offeredToolNames,
    }));
    if (!offeredRun) return null;
    return { run: offeredRun, activeConfig, workTools, tools };
  }

  async prepareRunTickContext(
    runId: string,
    inputs: RunTickInputs,
  ): Promise<PreparedRunTickContext | null> {
    const state: RunTickContextState = {
      ...inputs,
      context: {
        systemPrompt: "",
        messages: [],
        tools: inputs.tools.length > 0 ? inputs.tools : undefined,
      },
      contextState: null,
      autoCompactionPressure: null,
    };
    const contextReady = await this.prepareRunTickGenerationContext(runId, state);
    if (!contextReady || !state.contextState || (await this.pauseManagedRun(runId))) return null;
    return { ...state, contextState: state.contextState };
  }

  async buildRunTickContext(
    runId: string,
    state: RunTickContextState,
    options: { recoverResponsibilities: boolean; refreshProjection: boolean },
  ): Promise<Context | null> {
    const spanId = this.host.trace.start({
      runId,
      kind: "context",
      name: "Build context",
    });
    let status: Exclude<ProcTraceSpanStatus, "running"> = "aborted";
    let attributes: JsonObject | undefined;
    try {
      const epoch = options.refreshProjection
        ? await this.refreshRunTickContextEpoch(runId, state)
        : this.host.store.epochs.getLiveContextEpoch();
      if (!epoch || this.host.handleRunStopped(runId)) return null;
      const activeRun = this.host.runs.active;
      if (!activeRun || activeRun.runId !== runId) return null;
      state.run = activeRun;
      if (activeRun.contextEpochId !== epoch.id) {
        throw new Error("Context epoch changed before context accounting completed");
      }
      if (options.recoverResponsibilities) {
        const synced = await this.host.history.syncResponsibilityDeltas(runId, epoch);
        if (!synced || this.host.handleRunStopped(runId)) return null;
      }
      const systemPrompt = activeRun.returnToCaller
        ? `${epoch.systemPrompt}\n\n${GSV_DELEGATED_TASK_CONTEXT}`
        : epoch.systemPrompt;
      const generationContextId = await deriveGenerationContextId(
        epoch.id,
        systemPrompt,
        state.tools.length > 0 ? state.tools : undefined,
      );
      const generationRun = this.host.mutateActiveRun(runId, (current) => ({
        ...current,
        generationContextId,
      }));
      if (!generationRun) return null;
      state.run = generationRun;
      const pendingRuntimeEvents = generationRun.pendingRuntimeEvents ?? 0;
      const messages = await this.host.history.buildContextMessages(
        epoch.id,
        generationContextId,
      );
      if (this.host.handleRunStopped(runId)) return null;
      this.host.history.consumeRuntimeEventsInContext(runId, pendingRuntimeEvents);
      attributes = {
        messages: messages.length,
        tools: state.tools.length,
        systemPromptChars: systemPrompt.length,
      };
      status = "ok";
      return {
        systemPrompt,
        messages,
        tools: state.tools.length > 0 ? state.tools : undefined,
      };
    } catch (error) {
      if (this.host.handleRunStopped(runId)) return null;
      status = "error";
      throw error;
    } finally {
      this.host.trace.finish(spanId, status, { attributes });
    }
  }

  async refreshRunTickContextEpoch(
    runId: string,
    state: RunTickContextState,
  ): Promise<ContextEpochRecord | null> {
    const contextSnapshot = await this.host.settings.resolveAiContext(this.runAbortSignal(runId));
    const projectedRun = this.host.mutateActiveRun(runId, (current) => ({
      ...current,
      devices: contextSnapshot.devices,
      mcpServers: contextSnapshot.mcpServers,
    }));
    if (!projectedRun) return null;
    state.run = projectedRun;
    const fallbackProjection =
      parseContextProjection(this.host.store.epochs.getLiveContextEpoch()?.observedProjection) ??
      createContextProjection(contextSnapshotFromRun(projectedRun, state.activeConfig));
    const currentProjection = createContextProjection(
      contextSnapshot,
      new Date(),
      fallbackProjection.skills,
    );
    const epoch = await this.host.history.ensureContextEpoch(
      runId,
      projectedRun,
      state.activeConfig,
      contextSnapshot,
      currentProjection,
    );
    if (!epoch || this.host.handleRunStopped(runId)) return null;
    const projectionSynced = await this.host.history.syncContextProjection(
      runId,
      epoch,
      currentProjection,
    );
    return projectionSynced && !this.host.handleRunStopped(runId) ? epoch : null;
  }

  async applyRunTickContextPolicy(
    runId: string,
    state: RunTickContextState,
    trigger: "preflight" | "provider-overflow",
  ): Promise<"ready" | "compacted" | "stopped"> {
    const contextState = state.contextState;
    if (!contextState) throw new Error("Process context state was not measured");
    const policy = this.host.history.getHistoryContextPolicy();
    if (state.autoCompactionPressure !== null) {
      if (trigger === "provider-overflow") return "ready";
      if (contextState.pressure !== null && contextState.pressure > policy.compactToPressure) {
        await this.host.history.finishInsufficientCompactionRun(
          runId,
          policy,
          state.autoCompactionPressure,
          contextState.pressure,
        );
        return "stopped";
      }
      return "ready";
    }

    const result = await this.host.history.applyHistoryContextPolicy(
      runId,
      state.activeConfig,
      contextState,
      state.context,
      trigger,
    );
    if (result !== "compacted") return result;
    state.autoCompactionPressure = contextState.pressure ?? policy.compactAtPressure;
    if (this.host.handleRunStopped(runId)) return "stopped";
    if (!(await this.rebuildRunTickContext(runId, state))) return "stopped";
    const compactedState = state.contextState;
    if (!compactedState) return "stopped";
    if (
      compactedState.pressure !== null &&
      compactedState.pressure > policy.compactToPressure
    ) {
      await this.host.history.finishInsufficientCompactionRun(
        runId,
        policy,
        state.autoCompactionPressure,
        compactedState.pressure,
      );
      return "stopped";
    }
    return "compacted";
  }

  async prepareRunTickGenerationContext(
    runId: string,
    state: RunTickContextState,
  ): Promise<boolean> {
    if (!(await this.rebuildRunTickContext(runId, state))) return false;
    const policy = await this.applyRunTickContextPolicy(runId, state, "preflight");
    if (policy === "stopped") return false;
    const contextState = state.contextState;
    if (!contextState) return false;

    // The runway event must reach the model in the generation it warns. Apply
    // the soft boundary before appending it so the event cannot trip itself.
    const alerted = await this.host.history.maybeAppendContextRunwayAlert(
      runId,
      contextState,
    );
    if (this.host.handleRunStopped(runId)) return false;
    if (!alerted) return true;
    return await this.rebuildRunTickContext(runId, state);
  }

  async rebuildRunTickContext(runId: string, state: RunTickContextState): Promise<boolean> {
    const context = await this.buildRunTickContext(runId, state, {
      recoverResponsibilities: true,
      refreshProjection: true,
    });
    if (!context || this.host.handleRunStopped(runId)) return false;
    state.context = context;
    state.contextState = await this.host.history.updateContextState(
      runId,
      state.activeConfig,
      context,
    );
    return !this.host.handleRunStopped(runId);
  }
}
