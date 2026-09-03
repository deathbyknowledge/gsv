/** Owns Process tool policy, dispatch, results, and CodeMode execution. */

import {
  jsonObjectSchema, jsonValueSchema, type JsonObject, type ProcHilRequest, type ProcToolResultOutcome,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  ProcessStore, resolvedToolResultOutcome, type PendingHilRecord, type PendingToolCallRecord,
  type ToolCallRecord,
} from "../store";
import type { PreparedJsonToolArgs, DynamicRequestFrameData } from "../internal/contracts";
import type { Process } from "../do";
import type { RunState } from "../run/state";
import {
  INTERRUPTED_RUN_CONTROL_MESSAGE, PENDING_RUN_CONTROL_CALL, SHELL_SESSION_TARGET_KEY_PREFIX,
  TOOL_APPROVAL_OVERRIDES_KEY, TOOL_DISPATCH_TIMEOUT_MS, CODE_MODE_APPROVAL_TIMEOUT_MS,
  CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS, UNKNOWN_SHELL_SESSION_TARGET_MESSAGE,
} from "../internal/lifecycle";
import {
  parseToolApprovalPolicy, resolveToolApproval, resolveToolApprovalTarget, type ToolApprovalPolicy,
  type ToolApprovalResolution, type ToolApprovalRule,
} from "../approval";
import { approvalRuleKey } from "../context/formatters";
import { normalizeOptionalString, parseOptionalJsonObject, cancelResponseBody } from "../internal/messages";
import { cancelProcessRequests, sendFrameToKernel } from "../../shared/utils";
import { stringifyStoredProcessMedia } from "../media";
import { unwrapStoredToolResult } from "../tool-result-media";
import { z } from "zod";
import { CODEMODE_EXEC, isToolSyscallName, syscallToolName } from "../../syscalls/constants";
import type { SyscallName } from "../../syscalls";
import { errorMessageFromUnknown } from "../../inference/errors";
import { buildCodeModeMcpToolBindings, executeCodeMode, type CodeModeExecutionOptions } from "../codemode";
import type { CodeModeRunArgs, CodeModeRunResult } from "../../syscalls/codemode";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";
import { codeModeExecArgsSchema } from "../internal/schemas";
import { createCodeModeRequest } from "../../codemode/request";
import { hasCapability } from "../../kernel/capabilities";
import { materializeToolResponse } from "../tool-response";
import { raceWithAbort } from "../../shared/abort";
import { stableOpaqueId } from "../../shared/stable-id";

export type ToolResultIngestion = {
  interrupted: number;
  appended: number;
  finished: Array<{
    executionId: string;
    callId: string;
    outcome: ProcToolResultOutcome;
  }>;
};

type AdmittedToolCall = {
  callId: string;
  dispatchId: string;
  syscall: SyscallName;
  toolName: string;
  args: JsonObject;
  approval: ToolApprovalResolution;
};

export class ProcessTools {
  constructor(private readonly host: Process) {}

  resolveToolApprovalPolicy(run: RunState): ToolApprovalPolicy {
    if (run.approvalPolicy) {
      return run.approvalPolicy;
    }

    const accountPolicy = parseToolApprovalPolicy(run.config?.accountApprovalPolicy ?? null);
    const overrides = this.loadToolApprovalOverrides();
    run.approvalPolicy = {
      default: accountPolicy.default,
      rules: [...overrides, ...accountPolicy.rules],
    };
    this.host.runs.active = run;
    return run.approvalPolicy;
  }

  prepareToolArgs(syscall: string, args: JsonObject): PreparedJsonToolArgs {
    if (syscall !== "shell.exec") {
      return { args, missingShellSessionTarget: false };
    }

    const record = parseOptionalJsonObject(args);
    if (!record) {
      return { args, missingShellSessionTarget: false };
    }

    if (normalizeOptionalString(record.target)) {
      return { args, missingShellSessionTarget: false };
    }

    const sessionId = normalizeOptionalString(record.sessionId);
    if (!sessionId) {
      return { args, missingShellSessionTarget: false };
    }

    const target = this.loadShellSessionTarget(sessionId);
    if (!target) {
      return { args, missingShellSessionTarget: true };
    }

    return {
      args: { ...record, target },
      missingShellSessionTarget: false,
    };
  }

  rememberShellSessionTargetFromResult(
    syscall: string,
    args: Parameters<typeof jsonValueSchema.parse>[0],
    result: Parameters<typeof jsonValueSchema.parse>[0],
  ): void {
    if (syscall !== "shell.exec") {
      return;
    }

    const parsedArgs = jsonValueSchema.parse(args ?? null);
    const parsedResult = jsonValueSchema.parse(result ?? null);
    const resultRecord = parseOptionalJsonObject(parsedResult);
    const sessionId = normalizeOptionalString(resultRecord?.sessionId);
    if (!sessionId) {
      return;
    }

    const target = resolveToolApprovalTarget(syscall, parsedArgs);
    if (target === "targets/*") {
      return;
    }

    this.host.store.state.setValue(this.shellSessionTargetKey(sessionId), target);
  }

  loadShellSessionTarget(sessionId: string): string | null {
    const target = this.host.store.state.getValue(this.shellSessionTargetKey(sessionId));
    return normalizeOptionalString(target) ?? null;
  }

  shellSessionTargetKey(sessionId: string): string {
    return `${SHELL_SESSION_TARGET_KEY_PREFIX}${sessionId}`;
  }

  rememberToolApproval(pendingHil: PendingHilRecord, run: RunState): boolean {
    const rule = this.buildToolApprovalOverride(pendingHil.syscall, pendingHil.args);
    const overrides = this.loadToolApprovalOverrides();
    const key = approvalRuleKey(rule);
    const alreadyStored = overrides.some((override) => approvalRuleKey(override) === key);

    if (!alreadyStored) {
      this.host.store.state.setValue(
        TOOL_APPROVAL_OVERRIDES_KEY,
        JSON.stringify([rule, ...overrides]),
      );
    }

    if (
      run.approvalPolicy &&
      !run.approvalPolicy.rules.some((override) => approvalRuleKey(override) === key)
    ) {
      run.approvalPolicy.rules.unshift(rule);
      this.host.runs.active = run;
    }

    return true;
  }

  buildToolApprovalOverride(syscall: string, args: JsonObject): ToolApprovalRule {
    const prepared = this.prepareToolArgs(syscall, args);
    const target = resolveToolApprovalTarget(syscall, prepared.args);
    return {
      match: syscall,
      target,
      action: "auto",
    };
  }

  loadToolApprovalOverrides(): ToolApprovalRule[] {
    const raw = this.host.store.state.getValue(TOOL_APPROVAL_OVERRIDES_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = jsonValueSchema.parse(JSON.parse(raw));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parseToolApprovalPolicy(
        JSON.stringify({
          default: "auto",
          rules: parsed,
        }),
      ).rules;
    } catch {
      return [];
    }
  }

  toProcHilRequest(record: PendingHilRecord | null): ProcHilRequest | null {
    if (!record) {
      return null;
    }

    const request: ProcHilRequest = {
      pid: this.host.pid,
      requestId: record.requestId,
      runId: record.runId,
      callId: record.toolCallId,
      toolName: record.toolName,
      syscall: record.syscall,
      target: resolveToolApprovalTarget(record.syscall, record.args),
      args: record.args,
      createdAt: record.createdAt,
    };
    if (this.host.runs.active?.runId === record.runId && this.host.runs.active.conversationId) {
      request.conversationId = this.host.runs.active.conversationId;
    }
    return request;
  }

  cancelPendingRequests(runId: string | null, reason: string): void {
    const requestIds = new Set<string>();
    const toolRunId = runId ?? this.host.runs.active?.runId;
    if (toolRunId) {
      for (const result of this.host.store.tools.getResults(toolRunId)) {
        if (result.status === "registered" || result.status === "pending") {
          requestIds.add(result.dispatchId);
        }
      }
    }
    for (const [id, waiter] of this.host.codeModeResponses) {
      if (runId === null || waiter.runId === runId) {
        requestIds.add(id);
      }
    }

    if (runId === null) {
      for (const controller of this.host.requestControllers.values()) {
        controller.abort(new Error(reason));
      }
      this.host.requestControllers.clear();
      for (const controller of this.host.runAbortControllers.values()) {
        controller.abort(new Error(reason));
      }
      this.host.runAbortControllers.clear();
    } else {
      this.host.runAbortControllers.get(runId)?.abort(new Error(reason));
      this.host.runAbortControllers.delete(runId);
    }

    if (requestIds.size > 0) {
      this.host.startBackground(
        `request cancellation for ${runId ?? "process"}`,
        cancelProcessRequests(
          this.host.installationId,
          this.host.pid,
          [...requestIds],
          reason,
        ).catch(() => 0),
      );
    }
  }

  rejectCodeModeWaiters(runId: string | null, message: string): void {
    for (const [id, waiter] of this.host.codeModeResponses.entries()) {
      if (runId !== null && waiter.runId !== runId) {
        continue;
      }
      this.host.codeModeResponses.delete(id);
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(message));
    }

    for (const [requestId, waiter] of this.host.codeModeApprovals.entries()) {
      if (runId !== null && waiter.runId !== runId) {
        continue;
      }
      this.host.codeModeApprovals.delete(requestId);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(false);
    }
  }

  private pendingToolForRun(runId: string, executionId: string): PendingToolCallRecord | null {
    if (this.host.handleRunStopped(runId)) return null;
    const pending = this.host.store.tools.getPending(executionId);
    return pending?.runId === runId ? pending : null;
  }

  async resolveStartedTool(
    runId: string,
    executionId: string,
    result: Parameters<typeof jsonValueSchema.safeParse>[0],
    outcome?: "completed" | "failed",
  ): Promise<boolean> {
    const pending = this.pendingToolForRun(runId, executionId);
    if (!pending) return false;
    const prepared = await this.host.resources.prepareToolResultForStorage(
      runId,
      executionId,
      result,
    );
    const resolvedOutcome = outcome ?? resolvedToolResultOutcome(prepared.value);
    const current = this.host.store.tools.getPending(executionId);
    if (!current || current.runId !== runId) {
      await this.host.resources.deletePreparedToolResultMedia(prepared.createdKeys);
      return false;
    }
    const wasStarted = current.status === "pending";
    const transitioned = this.host.store.tools.resolve(
      executionId,
      prepared.value,
      resolvedOutcome,
    );
    if (!transitioned) {
      await this.host.resources.deletePreparedToolResultMedia(prepared.createdKeys);
      return false;
    }
    const resumeRun = transitioned && this.host.store.tools.isRunResolved(runId);
    if (transitioned && wasStarted) {
      await this.host.signals.toolFinished(runId, executionId, current.callId, resolvedOutcome);
    }
    if (resumeRun) {
      await this.resumeResolvedToolRun(runId);
    }
    return transitioned;
  }

  async failStartedTool(
    runId: string,
    executionId: string,
    error: string,
    outcome: Exclude<ProcToolResultOutcome, "completed"> = "failed",
  ): Promise<boolean> {
    const pending = this.pendingToolForRun(runId, executionId);
    if (!pending) return false;
    const wasStarted = pending.status === "pending";
    const transitioned = this.host.store.tools.fail(executionId, error, outcome);
    const resumeRun = transitioned && this.host.store.tools.isRunResolved(runId);
    if (transitioned && wasStarted) {
      await this.host.signals.toolFinished(runId, executionId, pending.callId, outcome);
    }
    if (resumeRun) {
      await this.resumeResolvedToolRun(runId);
    }
    return transitioned;
  }

  async ingestToolResults(
    runId: string,
    toolResults: ReturnType<ProcessStore["tools"]["getResults"]>,
    options?: { interruptPending?: string },
  ): Promise<{ interrupted: number; appended: number }> {
    const recorded = this.host.ctx.storage.transactionSync(() =>
      this.recordToolResults(runId, toolResults, options),
    );
    await this.completeToolResultIngestion(runId, recorded);
    return {
      interrupted: recorded.interrupted,
      appended: recorded.appended,
    };
  }

  recordToolResults(
    runId: string,
    toolResults: ReturnType<ProcessStore["tools"]["getResults"]>,
    options?: { interruptPending?: string },
  ): ToolResultIngestion {
    let interrupted = 0;
    let appended = 0;
    const finished: ToolResultIngestion["finished"] = [];
    for (const result of toolResults) {
      let content: string;
      let isError: boolean;
      let outcome: ProcToolResultOutcome;
      let media: string | undefined;

      if (result.status === "completed") {
        const stored = unwrapStoredToolResult(result.result);
        const ownedMedia = this.host.resources.parseOwnedProcessMedia(
          JSON.stringify(stored.media),
        );
        const storedText = z.string().safeParse(stored.output);
        content = storedText.success ? storedText.data : JSON.stringify(stored.output ?? null);
        media = stringifyStoredProcessMedia(ownedMedia) ?? undefined;
        outcome = result.outcome ?? "completed";
        isError = outcome !== "completed";
      } else if (result.status === "error") {
        content = `Error: ${result.error}`;
        isError = true;
        outcome = result.outcome ?? "failed";
      } else if (options?.interruptPending) {
        content = `Error: ${options.interruptPending}`;
        isError = true;
        outcome = "cancelled";
        interrupted += 1;
      } else {
        continue;
      }

      this.host.store.messages.appendToolResult(
        result.id,
        result.call,
        content,
        isError,
        runId,
        outcome,
        media,
      );
      if (result.status === "pending") {
        finished.push({
          executionId: result.dispatchId,
          callId: result.id,
          outcome,
        });
      }
      appended += 1;
    }
    this.host.store.tools.clearRun(runId);
    return { interrupted, appended, finished };
  }

  async completeToolResultIngestion(runId: string, recorded: ToolResultIngestion): Promise<void> {
    for (const result of recorded.finished) {
      await this.host.signals.toolFinished(
        runId,
        result.executionId,
        result.callId,
        result.outcome,
      );
    }
  }

  private admitRegisteredToolCall(
    run: RunState,
    toolCall: ToolCallRecord,
    approvalPolicy: ToolApprovalPolicy,
  ): AdmittedToolCall | null {
    if (toolCall.call === PENDING_RUN_CONTROL_CALL) {
      this.host.store.tools.fail(toolCall.dispatchId, INTERRUPTED_RUN_CONTROL_MESSAGE);
      return null;
    }
    const syscall = isToolSyscallName(toolCall.call) ? toolCall.call : undefined;
    const toolName = syscallToolName(toolCall.call) ?? toolCall.call;
    if (!this.wasToolOffered(run, toolName)) {
      this.host.store.tools.fail(
        toolCall.dispatchId,
        `Tool "${toolName}" was not offered for this generation`,
      );
      return null;
    }
    if (!syscall) {
      this.host.store.tools.fail(toolCall.dispatchId, `Unknown tool "${toolName}"`);
      return null;
    }

    const args = jsonObjectSchema.parse(toolCall.args);
    const approval = resolveToolApproval(approvalPolicy, syscall, args);
    if (approval.action === "deny") {
      this.host.store.tools.fail(toolCall.dispatchId, "Tool execution denied by policy");
      return null;
    }
    return {
      callId: toolCall.id,
      dispatchId: toolCall.dispatchId,
      syscall,
      toolName,
      args,
      approval,
    };
  }

  async processToolCalls(runId: string): Promise<PendingHilRecord | null> {
    const toolCalls = this.host.store.tools
      .getResults(runId)
      .filter((result) => result.status === "registered");
    if (toolCalls.length === 0) {
      return null;
    }

    const run = this.host.runs.active;
    if (!run || run.runId !== runId) {
      return null;
    }

    const approvalPolicy = this.resolveToolApprovalPolicy(run);
    if (this.host.handleRunStopped(runId)) {
      return null;
    }

    for (const toolCall of toolCalls) {
      if (this.host.handleRunStopped(runId)) {
        return null;
      }
      const admitted = this.admitRegisteredToolCall(run, toolCall, approvalPolicy);
      if (!admitted) continue;
      const { callId, dispatchId, syscall, toolName, args, approval } = admitted;

      if (approval.action === "ask") {
        const pendingHil: PendingHilRecord = {
          requestId: crypto.randomUUID(),
          runId,
          toolCallId: callId,
          toolName,
          syscall,
          args,
          createdAt: Date.now(),
        };
        this.host.store.tools.setPendingHil(pendingHil);
        await this.host.sendSignal("proc.run.hil.requested", this.toProcHilRequest(pendingHil));
        return pendingHil;
      }

      if (!(await this.beginToolDispatch(runId, dispatchId))) {
        if (this.host.handleRunStopped(runId)) {
          return null;
        }
        continue;
      }
      await this.host.signals.toolStarted({
        name: toolName,
        syscall,
        args,
        callId,
        executionId: dispatchId,
        pid: this.host.pid,
        runId,
      });
      if (this.host.handleRunStopped(runId)) {
        return null;
      }
      this.launchToolDispatch(runId, dispatchId, syscall, args, approvalPolicy);
    }

    return null;
  }

  wasToolOffered(run: RunState, toolName: string): boolean {
    const offeredToolNames = run.offeredToolNames ?? (run.tools ?? []).map((tool) => tool.name);
    return offeredToolNames.includes(toolName);
  }

  launchToolDispatch(
    runId: string,
    dispatchId: string,
    syscall: SyscallName,
    args: JsonObject,
    approvalPolicy: ToolApprovalPolicy,
  ): void {
    const execution =
      syscall === CODEMODE_EXEC
        ? this.executeCodeModeTool(runId, dispatchId, args, approvalPolicy)
        : this.host.kernel.dispatchSyscall(runId, dispatchId, syscall, args);
    this.host.startBackground(
      `tool dispatch ${dispatchId}`,
      execution.catch((error) => {
        if (!this.host.killed && this.host.store.tools.getPending(dispatchId)) {
          return this.failStartedTool(runId, dispatchId, errorMessageFromUnknown(error));
        }
        return false;
      }),
    );
  }

  async resumeResolvedToolRun(runId: string): Promise<void> {
    if (this.host.handleRunStopped(runId)) {
      return;
    }
    if (
      this.host.store.tools.getPendingHilForRun(runId) ||
      !this.host.store.tools.isRunResolved(runId)
    ) {
      return;
    }
    try {
      await this.host.run.scheduleTick(runId);
    } catch (error) {
      if (this.host.handleRunStopped(runId)) {
        return;
      }
      await this.host.run.finishRun(runId, {
        reason: "schedule.error",
        status: "error",
        resultText: null,
        error: `Failed to resume after tool execution: ${errorMessageFromUnknown(error)}`,
      });
    }
  }

  async beginToolDispatch(runId: string, dispatchId: string): Promise<boolean> {
    const deadlineAt = Date.now() + TOOL_DISPATCH_TIMEOUT_MS;
    try {
      await this.host.run.schedule(new Date(deadlineAt), "onToolDispatchTimeout", {
        runId,
        dispatchId,
      });
    } catch (error) {
      if (this.host.handleRunStopped(runId)) {
        return false;
      }
      this.host.store.tools.fail(
        dispatchId,
        `Failed to schedule tool timeout: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (this.host.handleRunStopped(runId)) {
      return false;
    }
    return this.host.store.tools.markDispatched(dispatchId);
  }

  async handleCodeModeRun(
    args: CodeModeRunArgs,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<CodeModeRunResult> {
    if (args.code.trim().length === 0) {
      return {
        status: "failed",
        error: "codemode requires a non-empty code string",
      };
    }

    try {
      const options: CodeModeExecutionOptions = {
        argv: args.argv ?? [],
        args: args.args ?? null,
        mcpToolBindings: await this.getCodeModeMcpToolBindings(signal),
        signal,
      };
      const target = normalizeOptionalString(args.target);
      const cwd = normalizeOptionalString(args.cwd);
      if (target) options.defaultTarget = target;
      if (cwd) options.defaultCwd = cwd;
      if (requestId) {
        options.mailDeliveryBase = await stableOpaqueId("mail-send", [
          this.host.installationId,
          this.host.pid,
          requestId,
        ]);
      }
      return await executeCodeMode(
        this.host.env,
        args.code,
        (call, toolArgs) => this.executeCodeModeSyscall(null, call, toolArgs, signal),
        options,
      );
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async executeCodeModeTool(
    runId: string,
    dispatchId: string,
    rawArgs: JsonObject,
    approvalPolicy: ToolApprovalPolicy,
  ): Promise<void> {
    if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
      return;
    }
    const parsedArgs = codeModeExecArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success || parsedArgs.data.code.trim().length === 0) {
      await this.resolveStartedTool(
        runId,
        dispatchId,
        {
          status: "failed",
          error: "CodeMode requires a non-empty code string",
        },
        "failed",
      );
      return;
    }
    const args = parsedArgs.data;

    try {
      const signal = this.host.run.runAbortSignal(runId);
      const capabilities = this.host.runs.active?.config?.capabilities ?? [];
      const result = await executeCodeMode(
        this.host.env,
        args.code,
        (call, toolArgs) =>
          this.executeCodeModeSyscall(
            {
              runId,
              dispatchId,
              approvalPolicy,
              capabilities,
            },
            call,
            toolArgs,
            signal,
          ),
        {
          mailDeliveryBase: await stableOpaqueId("mail-send", [
            this.host.installationId,
            this.host.pid,
            runId,
            dispatchId,
          ]),
          mcpToolBindings: await this.getCodeModeMcpToolBindings(signal),
          signal,
        },
      );
      if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
        return;
      }
      await this.resolveStartedTool(
        runId,
        dispatchId,
        result,
        result.status === "failed" ? "failed" : "completed",
      );
    } catch (error) {
      if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
        return;
      }
      await this.resolveStartedTool(
        runId,
        dispatchId,
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "failed",
      );
    }
  }

  async getCodeModeMcpToolBindings(signal?: AbortSignal) {
    try {
      const result = await this.host.kernel.kernelRpc("sys.mcp.list", {}, signal);
      return buildCodeModeMcpToolBindings(result.servers);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  async executeCodeModeSyscall(
    context: {
      runId: string;
      dispatchId: string;
      approvalPolicy: ToolApprovalPolicy;
      capabilities: string[];
    } | null,
    call: SyscallName,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    signal?.throwIfAborted();
    if (context && this.host.handleRunStopped(context.runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    const toolCallId = `codemode-${crypto.randomUUID()}`;
    const prepared = this.prepareToolArgs(call, args);
    if (prepared.missingShellSessionTarget) {
      throw new Error(UNKNOWN_SHELL_SESSION_TARGET_MESSAGE);
    }
    const toolArgs = prepared.args;

    if (context) {
      const approval = resolveToolApproval(context.approvalPolicy, call, toolArgs);
      if (approval.action === "deny") {
        throw new Error(`Tool execution denied by policy: ${call}`);
      }
      if (approval.action === "ask") {
        if (!hasCapability(context.capabilities, call)) {
          throw new Error(`Permission denied: ${call}`);
        }
        const approved = await this.waitForCodeModeApproval(
          context.runId,
          context.dispatchId,
          toolCallId,
          syscallToolName(call) ?? call,
          call,
          toolArgs,
        );
        if (!approved) {
          throw new Error(`Tool execution was not approved: ${call}`);
        }
      }
    }

    if (context && this.host.handleRunStopped(context.runId)) {
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    const response = await this.dispatchCodeModeSyscall(
      context?.runId ?? null,
      toolCallId,
      call,
      toolArgs,
      signal,
    );

    if (context && this.host.handleRunStopped(context.runId)) {
      await cancelResponseBody(response, "Run stopped before CodeMode tool execution completed");
      throw new Error("Run stopped before CodeMode tool execution completed");
    }

    if (response.ok) {
      const result = await materializeToolResponse(
        call,
        response.data ?? null,
        response.body,
        signal ?? (context ? this.host.run.runAbortSignal(context.runId) : undefined),
      );
      return jsonValueSchema.parse(result);
    }

    throw new Error(response.error.message);
  }

  async waitForCodeModeApproval(
    runId: string,
    dispatchId: string,
    toolCallId: string,
    toolName: string,
    call: SyscallName,
    args: JsonObject,
  ): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const approved = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.host.codeModeApprovals.delete(requestId);
        if (this.host.store.tools.getPendingHil(requestId)) {
          this.host.store.tools.clearPendingHil();
        }
        resolve(false);
      }, CODE_MODE_APPROVAL_TIMEOUT_MS);
      this.host.codeModeApprovals.set(requestId, {
        runId,
        dispatchId,
        resolve,
        timeoutId,
      });
    });

    const pendingHil: PendingHilRecord = {
      requestId,
      runId,
      ownerDispatchId: dispatchId,
      toolCallId,
      toolName,
      syscall: call,
      args,
      createdAt: Date.now(),
    };
    this.host.store.tools.setPendingHil(pendingHil);
    await this.host.sendSignal("proc.run.hil.requested", this.toProcHilRequest(pendingHil));
    return approved;
  }

  async dispatchCodeModeSyscall(
    runId: string | null,
    id: string,
    call: SyscallName,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<ResponseFrame> {
    signal?.throwIfAborted();
    const pid = this.host.pid;
    const request = createCodeModeRequest(call, args);
    const frameData: DynamicRequestFrameData = {
      type: "req",
      id,
      call,
      args: request.args,
    };
    if (runId) frameData.runId = runId;
    if (request.body) frameData.body = request.body;
    // SAFETY: CodeMode emits JsonObject arguments, and the Kernel owns the
    // final per-syscall validation before dispatching this dynamic call.
    const reqFrame = frameData as RequestFrame;

    const pending = new Promise<ResponseFrame>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.host.codeModeResponses.delete(id);
        this.host.startBackground(
          `CodeMode timeout cancellation for ${id}`,
          cancelProcessRequests(this.host.installationId, pid, [id], `${call} timed out`).catch(
            () => 0,
          ),
        );
        reject(new Error(`Timed out waiting for ${call}`));
      }, CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS);
      this.host.codeModeResponses.set(id, {
        runId,
        call,
        args,
        resolve,
        reject,
        timeoutId,
      });
    });
    void pending.catch(() => {});

    const operation = (async () => {
      const response = await sendFrameToKernel(this.host.installationId, pid, reqFrame);
      if (response && response.type === "res") {
        const waiter = this.host.codeModeResponses.get(id);
        if (!waiter || (runId !== null && this.host.handleRunStopped(runId))) {
          await cancelResponseBody(response, `Run stopped before ${call} completed`);
          throw new Error(`Run stopped before ${call} completed`);
        }
        this.host.codeModeResponses.delete(id);
        clearTimeout(waiter.timeoutId);
        if (response.ok) {
          this.rememberShellSessionTargetFromResult(call, args, response.data ?? null);
        }
        return response;
      }
      if (response) {
        throw new Error(`Unexpected response frame for ${call}: ${response.type}`);
      }
      return await pending;
    })();

    try {
      return await raceWithAbort(operation, signal, {
        abortReason: () => signal?.reason ?? new Error("CodeMode request cancelled"),
        onAbort: () => {
          const reason =
            signal?.reason instanceof Error ? signal.reason.message : "CodeMode request cancelled";
          const waiter = this.host.codeModeResponses.get(id);
          if (waiter) {
            this.host.codeModeResponses.delete(id);
            clearTimeout(waiter.timeoutId);
            waiter.reject(new Error(reason));
          }
          this.host.startBackground(
            `CodeMode cancellation for ${id}`,
            cancelProcessRequests(this.host.installationId, pid, [id], reason).catch(() => 0),
          );
        },
        onLateResolve: (response) => {
          void cancelResponseBody(response, "CodeMode request was cancelled");
        },
      });
    } catch (error) {
      const waiter = this.host.codeModeResponses.get(id);
      if (waiter) {
        this.host.codeModeResponses.delete(id);
        clearTimeout(waiter.timeoutId);
      }
      throw error;
    }
  }

  resolveCodeModeApproval(requestId: string, approved: boolean): void {
    const waiter = this.host.codeModeApprovals.get(requestId);
    if (!waiter) {
      return;
    }
    this.host.codeModeApprovals.delete(requestId);
    clearTimeout(waiter.timeoutId);
    waiter.resolve(approved);
  }
}
