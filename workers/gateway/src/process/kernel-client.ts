/** Owns authorized Process-to-Kernel calls. */

import { AGENT_READ_DEFAULT_LINE_LIMIT, AGENT_READ_MAX_BYTES } from "../syscalls/read";
import {
  jsonValueSchema, type AiConfigResult, type JsonObject, type NetFetchArgs,
} from "@humansandmachines/gsv/protocol";
import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";
import type { Frame, FrameBody, RequestFrame, ResponseOkFrame } from "../protocol/frames";
import {
  cancelProcessRequests, requestProcessNetFetch, sendFrameToKernel, type RequestProcessNetFetchOptions,
} from "../shared/utils";
import { cancelResponseBody } from "./internal/messages";
import { formatAgentToolResponse, materializeToolResponse } from "./tool-response";
import {
  normalizeNetFetchTimeoutMs, normalizeTarget, requestNetFetchWithSignal, requestToNetFetchArgs,
  responseFromNetFetchResult,
} from "../kernel/net";
import { routedFetchOptionsSchema } from "./internal/schemas";
import type { Process } from "./do";
import { raceWithAbort } from "../shared/abort";

export class ProcessKernelClient {
  constructor(private readonly host: Process) {}

  async kernelRpc<T extends SyscallName>(
    call: T,
    args: ArgsOf<T>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<ResultOf<T>> {
    signal?.throwIfAborted();
    const pid = this.host.pid;
    const id = requestId ?? crypto.randomUUID();
    const frame: RequestFrame<T> = { type: "req", id, call, args };
    const pending = sendFrameToKernel(this.host.installationId, pid, frame);
    const cancellationReason = () =>
      signal?.reason instanceof Error ? signal.reason.message : "Request cancelled";
    const response: Frame | null = await raceWithAbort(pending, signal, {
      onAbort: () => this.host.startBackground(
        `Kernel request cancellation for ${id}`,
        cancelProcessRequests(
          this.host.installationId,
          pid,
          [id],
          cancellationReason(),
        ).catch(() => 0),
      ),
      onLateResolve: (late) => {
        if (late?.type === "res") void cancelResponseBody(late, cancellationReason());
      },
    });

    if (!response || response.type !== "res") {
      throw new Error(`No synchronous response for ${call}`);
    }
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    if (response.data === undefined) {
      throw new Error(`Synchronous response for ${call} omitted its result`);
    }
    return response.data;
  }

  createGenerationFetch(config: AiConfigResult, runId?: string): typeof fetch | undefined {
    const target = normalizeTarget(config.transportTarget);
    if (target === "gsv") {
      return undefined;
    }
    const pid = this.host.pid;
    const runSignal = runId ? this.host.run.runAbortSignal(runId) : undefined;
    return async (input, init) => {
      const requestedRedirect =
        init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
      const redirect =
        requestedRedirect === "follow" ||
        requestedRedirect === "error" ||
        requestedRedirect === "manual"
          ? requestedRedirect
          : undefined;
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal =
        runSignal && callerSignal
          ? AbortSignal.any([runSignal, callerSignal])
          : (runSignal ?? callerSignal);
      const requestInit: RequestInit = { ...init };
      if (redirect === "error") requestInit.redirect = "manual";
      if (signal) requestInit.signal = signal;
      const request = new Request(input, requestInit);
      const outbound = requestToNetFetchArgs(request, redirect);
      const parsedOptions = routedFetchOptionsSchema.safeParse(init);
      const timeoutMs = normalizeNetFetchTimeoutMs(
        parsedOptions.success ? parsedOptions.data.timeoutMs : undefined,
      );
      const requestId = crypto.randomUUID();
      const response = await requestNetFetchWithSignal(
        () =>
          this.requestKernelNetFetch(
            target,
            {
              ...outbound.args,
              timeoutMs,
            },
            timeoutMs,
            outbound.body,
            requestId,
            pid,
          ),
        request.signal,
        outbound.body,
        (reason) => {
          this.host.startBackground(
            `model transport cancellation for ${requestId}`,
            cancelProcessRequests(
              this.host.installationId,
              pid,
              [requestId],
              reason instanceof Error ? reason.message : undefined,
            ).catch(() => 0),
          );
        },
      );
      return responseFromNetFetchResult(
        jsonValueSchema.parse(response.data),
        response.body,
        request.signal,
      );
    };
  }

  async requestKernelNetFetch(
    target: string,
    args: NetFetchArgs,
    ttlMs?: number,
    body?: FrameBody,
    requestId?: string,
    pid = this.host.pid,
  ): Promise<ResponseOkFrame<"net.fetch">> {
    const options: RequestProcessNetFetchOptions = {
      ttlMs,
      internalPurpose: "model-transport",
    };
    if (body) options.body = body;
    if (requestId) options.requestId = requestId;
    return await requestProcessNetFetch(this.host.installationId, pid, target, args, options);
  }

  async dispatchSyscall(
    runId: string,
    dispatchId: string,
    call: SyscallName,
    args: JsonObject,
  ): Promise<void> {
    if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
      return;
    }
    const pid = this.host.pid;
    const dispatchArgs =
      call === "fs.read"
        ? {
            ...args,
            limit: args.limit ?? AGENT_READ_DEFAULT_LINE_LIMIT,
            maxBytes: AGENT_READ_MAX_BYTES,
            representation: "resource",
          }
        : args;
    // SAFETY: tool arguments cross the model boundary through jsonObjectSchema,
    // and the Kernel remains the owner of per-syscall semantic validation.
    const reqFrame = {
      type: "req",
      id: dispatchId,
      call,
      args: dispatchArgs,
      runId,
    } as RequestFrame;

    const response = await sendFrameToKernel(this.host.installationId, pid, reqFrame);

    if (!response || response.type !== "res") return;
    if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
      await cancelResponseBody(response, "Tool call is no longer pending");
      return;
    }
    if (!response.ok) {
      await this.host.tools.failStartedTool(runId, dispatchId, response.error.message);
      return;
    }
    try {
      const result = await materializeToolResponse(
        call,
        response.data ?? null,
        response.body,
        this.host.run.runAbortSignal(runId),
        { maxTextBytes: AGENT_READ_MAX_BYTES },
      );
      if (this.host.handleRunStopped(runId) || !this.host.store.tools.getPending(dispatchId)) {
        return;
      }
      this.host.tools.rememberShellSessionTargetFromResult(call, args, result);
      await this.host.tools.resolveStartedTool(
        runId,
        dispatchId,
        formatAgentToolResponse(call, args, result),
      );
    } catch (error) {
      if (!this.host.handleRunStopped(runId)) {
        await this.host.tools.failStartedTool(
          runId,
          dispatchId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
