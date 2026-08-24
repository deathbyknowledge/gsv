/**
 * Kernel syscall dispatcher.
 *
 * Switch-based — every syscall is explicitly mapped for full visibility.
 * `target` is extracted at the dispatch boundary and stripped before
 * native handlers see it unless the native syscall explicitly consumes it.
 *
 * Returns a ResponseFrame for native-handled syscalls, or `null` when
 * the request was forwarded to a device (response will arrive later via
 * the routing table).
 */

import type {
  FrameBody,
  RequestFrame,
  ResponseFrame,
  ResponseOkFrame,
} from "../protocol/frames";
import { isRoutableSyscall, type SyscallName } from "../syscalls";
import type { KernelContext } from "./context";
import type { RouteOrigin } from "./routing";
import type { KernelConnection, KernelConnectionState } from "./connection";
import type { ShellSessionRecord, ShellSessionStore } from "./shell-sessions";
import type { NetFetchArgs } from "@humansandmachines/gsv/protocol";
import {
  handleFsRead,
  handleFsWrite,
  handleFsEdit,
  handleFsDelete,
  handleFsSearch,
  handleFsCopy,
  handleFsTransferStat,
  handleFsTransferSend,
  handleFsTransferReceive,
} from "../drivers/native/fs";
import { handleShellExec } from "../drivers/native/shell";
import {
  handleAiConfig,
  handleAiImageGenerate,
  handleAiImageRead,
  handleAiSpeechCreate,
  handleAiTextGenerate,
  handleAiTools,
  handleAiTranscriptionCreate,
} from "./ai";
import {
  handleProcList,
  handleProcIpcCall,
  handleProcIpcSend,
  handleProcFork,
  handleProcSpawn,
  forwardToProcess,
} from "./proc-handlers";
import { handleAccountCreate, handleAccountList } from "./agents";
import { handleSysConfigGet, handleSysConfigSet } from "./sys/config";
import { handleSysDeviceDelete, handleSysDeviceGet, handleSysDeviceList, handleSysDeviceUpdate } from "./sys/device";
import { handleNetFetch, normalizeNetFetchTimeoutMs } from "./net";
import { handleSysBootstrap } from "./sys/bootstrap";
import { handleSysSetupAssist } from "./sys/setup-assist";
import {
  handleRepoApply,
  handleRepoCompare,
  handleRepoCreate,
  handleRepoDelete,
  handleRepoDiff,
  handleRepoImport,
  handleRepoList,
  handleRepoLog,
  handleRepoRead,
  handleRepoRefs,
  handleRepoSearch,
  handleRepoVisibilitySet,
} from "./repo";
import {
  handleSysTokenCreate,
  handleSysTokenList,
  handleSysTokenRevoke,
} from "./sys/token";
import {
  handleSysOAuthDevicePoll,
  handleSysOAuthDeviceStart,
  handleSysOAuthForget,
  handleSysOAuthList,
  handleSysOAuthStart,
} from "./sys/oauth";
import {
  handleSysMcpAdd,
  handleSysMcpCall,
  handleSysMcpList,
  handleSysMcpRefresh,
  handleSysMcpRemove,
} from "./sys/mcp";
import {
  handleSysLink,
  handleSysLinkConsume,
  handleSysLinkList,
  handleSysUnlink,
} from "./sys/link";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  handleAdapterInbound,
  handleAdapterList,
  handleAdapterPairConfirm,
  handleAdapterPairDisconnect,
  handleAdapterPairInfo,
  handleAdapterPairInspect,
  handleAdapterSend,
  handleAdapterStateUpdate,
  handleAdapterStatus,
} from "./adapter-handlers";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "./scheduler";
import {
  handleResponsibilityChanges,
  handleResponsibilityCreate,
  handleResponsibilityGet,
  handleResponsibilityList,
  handleResponsibilityUpdate,
} from "./responsibilities";
import {
  getVisibleTarget,
  targetCanHandle,
  type TargetDescriptor,
} from "./targets";
import { handleMailSend } from "./outbound-mail";
import { handleMailStatus } from "./outbound-status";
import {
  handleConversationForProcess,
  handleConversationHistory,
  handleConversationShip,
  handleConversationList,
  handleConversationMediaRead,
  handleConversationSend,
} from "./conversation-handlers";
export type DispatchDeps = {
  shellSessions: ShellSessionStore;
  connections: Map<string, KernelConnection<KernelConnectionState>>;
  sendFrame: (
    connection: KernelConnection<KernelConnectionState>,
    frame: RequestFrame | ResponseFrame,
  ) => CancellableFrameBody | null;
  registerRoute: (route: {
    id: string;
    call: SyscallName;
    origin: RouteOrigin;
    deviceId: string;
    driverConnectionId: string;
    ttlMs: number;
  }) => Promise<{
    cancel: () => void;
    attachBody: (body: CancellableFrameBody) => void;
  }>;
  requestDevice: (
    deviceId: string,
    call: "net.fetch",
    args: NetFetchArgs,
    options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
  ) => Promise<ResponseOkFrame<"net.fetch">>;
  request: (
    frame: RequestFrame,
    ctx: KernelContext,
    signal?: AbortSignal,
  ) => Promise<ResponseFrame>;
};

type FrameCancellationReason = string | Error;
type CancellableFrameBody = {
  cancel(reason?: FrameCancellationReason): Promise<void>;
};
type RoutingTargetArgs = { target?: string };

export type DispatchResult =
  | { handled: true; response: ResponseFrame }
  | { handled: false };

const DEFAULT_DEVICE_TTL_MS = 60_000;
// The process watchdog is ten minutes; routing must not preempt it.
const DEFAULT_SHELL_DEVICE_TTL_MS = 11 * 60_000;
const SHELL_TIMEOUT_GRACE_MS = 10_000;

export async function dispatch(
  frame: RequestFrame,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  ctx = { ...ctx, requestId: frame.id };
  if (ctx.requestSignal?.aborted) {
    return {
      handled: true,
      response: errFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal)),
    };
  }
  const routingArgs = routableFrameArgs(frame);
  const target = frame.call === "ai.text.generate"
    ? frame.args.target
    : routingArgs?.target;
  const sessionId = frame.call === "shell.exec"
    ? frame.args.sessionId?.trim() ?? ""
    : "";

  if (sessionId) {
    const session = deps.shellSessions.get(sessionId);
    if (!session) {
      return {
        handled: true,
        response: errFrame(frame.id, 404, `Unknown shell session: ${sessionId}`),
      };
    }
    if (target && target !== session.deviceId) {
      return {
        handled: true,
        response: errFrame(frame.id, 400, "Shell session target does not match the requested target"),
      };
    }
    if (session.status === "failed" && session.error) {
      const sessionTarget = getVisibleTarget(ctx, session.deviceId, { includeOffline: true });
      if (!sessionTarget) {
        return {
          handled: true,
          response: errFrame(frame.id, 403, `Access denied to device: ${session.deviceId}`),
        };
      }
      return {
        handled: true,
        response: failedShellSessionFrame(frame.id, session),
      };
    }
    if (routingArgs) delete routingArgs.target;
    const sessionTarget = getVisibleTarget(ctx, session.deviceId, { includeOffline: true });
    if (!sessionTarget) {
      return {
        handled: true,
        response: errFrame(frame.id, 403, `Access denied to device: ${session.deviceId}`),
      };
    }
    return routeToTarget(frame, sessionTarget, origin, ctx, deps);
  }

  if (target && target !== "gsv" && isRoutableSyscall(frame.call)) {
    if (routingArgs) delete routingArgs.target;
    const routedTarget = getVisibleTarget(ctx, target, { includeOffline: true });
    if (!routedTarget) {
      return {
        handled: true,
        response: errFrame(frame.id, 403, `Access denied to device: ${target}`),
      };
    }
    return routeToTarget(frame, routedTarget, origin, ctx, deps);
  }

  if (target && frame.call !== "ai.text.generate") {
    if (routingArgs) delete routingArgs.target;
  }

  const result = await dispatchNative(frame, origin, ctx, deps);
  return {
    handled: true,
    response: result,
  };
}

async function dispatchNative(
  frame: RequestFrame,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<ResponseFrame> {
  const frameId = frame.id;

  try {
    let data: unknown;

    switch (frame.call) {
      case "fs.read":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleFsRead(frame.args, ctx),
        };
      case "fs.write":
        data = await handleFsWrite(frame.args, ctx);
        break;
      case "fs.edit":
        data = await handleFsEdit(frame.args, ctx);
        break;
      case "fs.delete":
        data = await handleFsDelete(frame.args, ctx);
        break;
      case "fs.search":
        data = await handleFsSearch(frame.args, ctx);
        break;
      case "fs.copy":
        data = await handleFsCopy(frame.args, ctx, deps);
        break;
      case "fs.transfer.stat":
        data = await handleFsTransferStat(frame.args, ctx);
        break;
      case "fs.transfer.send":
        return await handleFsTransferSend(frame.args, ctx, frame.id);
      case "fs.transfer.receive":
        data = await handleFsTransferReceive(frame.args, ctx, frame.body);
        break;

      case "shell.exec":
        data = await handleShellExec(frame.args, ctx, {
          fsTransport: deps,
          netFetchTransport: deps,
          request: (request, signal) => deps.request(request, ctx, signal),
        });
        break;

      case "net.fetch":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleNetFetch(frame.args, ctx, frame.body),
        };

      case "codemode.run":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await forwardToProcess(frame, ctx),
        };

      case "mail.send":
        data = await handleMailSend(frame.args, ctx);
        break;
      case "mail.status":
        data = handleMailStatus(frame.args, ctx);
        break;

      case "conversation.ship":
        data = await handleConversationShip(ctx);
        break;
      case "conversation.forProcess":
        data = await handleConversationForProcess(frame.args, ctx);
        break;
      case "conversation.list":
        data = await handleConversationList(ctx);
        break;
      case "conversation.history":
        data = await handleConversationHistory(frame.args, ctx);
        break;
      case "conversation.send":
        data = await handleConversationSend(frame.args, ctx);
        break;
      case "conversation.media.read":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleConversationMediaRead(frame.args, ctx),
        };

      case "proc.list":
        data = handleProcList(frame.args, ctx);
        break;
      case "proc.spawn":
        data = await handleProcSpawn(frame.args, ctx);
        break;
      case "proc.fork":
        data = await handleProcFork(frame.args, ctx);
        break;
      case "proc.ipc.send":
        data = await handleProcIpcSend(frame.args, ctx);
        break;
      case "proc.ipc.call":
        data = await handleProcIpcCall(frame.args, ctx);
        break;
      case "proc.send":
      case "proc.abort":
      case "proc.hil":
      case "proc.kill":
      case "proc.history":
      case "proc.ai.config.get":
      case "proc.ai.config.set":
      case "proc.history.policy.get":
      case "proc.history.policy.set":
      case "proc.history.compact":
      case "proc.history.segment.read":
      case "proc.history.segments":
      case "proc.reset":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await forwardToProcess(frame, ctx),
        };
      case "proc.ipc.deliver":
        return errFrame(frame.id, 403, "proc.ipc.deliver is kernel-only");
      case "proc.setidentity":
        return errFrame(frame.id, 403, "proc.setidentity is kernel-only");
      case "proc.history.export":
      case "proc.history.import":
        return errFrame(frame.id, 403, `${frame.call} is kernel-only`);

      // --- repo.* ---
      case "repo.list":
        data = handleRepoList(frame.args, ctx);
        break;
      case "repo.create":
        data = await handleRepoCreate(frame.args, ctx);
        break;
      case "repo.refs":
        data = await handleRepoRefs(frame.args, ctx);
        break;
      case "repo.read":
        data = await handleRepoRead(frame.args, ctx);
        break;
      case "repo.search":
        data = await handleRepoSearch(frame.args, ctx);
        break;
      case "repo.log":
        data = await handleRepoLog(frame.args, ctx);
        break;
      case "repo.diff":
        data = await handleRepoDiff(frame.args, ctx);
        break;
      case "repo.compare":
        data = await handleRepoCompare(frame.args, ctx);
        break;
      case "repo.apply":
        data = await handleRepoApply(frame.args, ctx);
        break;
      case "repo.import":
        data = await handleRepoImport(frame.args, ctx);
        break;
      case "repo.delete":
        data = await handleRepoDelete(frame.args, ctx);
        break;
      case "repo.visibility.set":
        data = handleRepoVisibilitySet(frame.args, ctx);
        break;

      // --- ai.* ---
      case "ai.tools":
        data = await handleAiTools(ctx);
        break;
      case "ai.config":
        data = await handleAiConfig(frame.args, ctx);
        break;
      case "ai.text.generate":
        data = await handleAiTextGenerate(frame.args, ctx, deps);
        break;
      case "ai.transcription.create":
        data = await handleAiTranscriptionCreate(frame.args, ctx, frame.body);
        break;
      case "ai.image.read":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleAiImageRead(frame.args, ctx, frame.body),
        };
      case "ai.image.generate":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleAiImageGenerate(frame.args, ctx),
        };
      case "ai.speech.create":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await handleAiSpeechCreate(frame.args, ctx),
        };

      // --- sys.* ---
      case "sys.connect":
        return errFrame(frame.id, 400, "sys.connect handled separately");
      case "sys.setup.assist":
        data = await handleSysSetupAssist(frame.args, ctx);
        break;
      case "sys.setup":
        return errFrame(frame.id, 400, "sys.setup handled separately");
      case "sys.bootstrap":
        data = await handleSysBootstrap(frame.args, ctx);
        break;
      case "sys.config.get":
        data = handleSysConfigGet(frame.args, ctx);
        break;
      case "sys.config.set":
        data = handleSysConfigSet(frame.args, ctx);
        break;
      case "sys.device.list":
        data = handleSysDeviceList(frame.args, ctx);
        break;
      case "sys.device.get":
        data = handleSysDeviceGet(frame.args, ctx);
        break;
      case "sys.device.update":
        data = handleSysDeviceUpdate(frame.args, ctx);
        break;
      case "sys.device.delete":
        data = handleSysDeviceDelete(frame.args, ctx);
        break;
      case "sys.oauth.start":
        data = await handleSysOAuthStart(frame.args, ctx);
        break;
      case "sys.oauth.device.start":
        data = await handleSysOAuthDeviceStart(frame.args, ctx);
        break;
      case "sys.oauth.device.poll":
        data = await handleSysOAuthDevicePoll(frame.args, ctx);
        break;
      case "sys.oauth.list":
        data = handleSysOAuthList(frame.args, ctx);
        break;
      case "sys.oauth.forget":
        data = handleSysOAuthForget(frame.args, ctx);
        break;
      case "sys.mcp.add":
        data = await handleSysMcpAdd(frame.args, ctx);
        break;
      case "sys.mcp.list":
        data = handleSysMcpList(frame.args, ctx);
        break;
      case "sys.mcp.remove":
        data = await handleSysMcpRemove(frame.args, ctx);
        break;
      case "sys.mcp.refresh":
        data = await handleSysMcpRefresh(frame.args, ctx);
        break;
      case "sys.mcp.call":
        data = await handleSysMcpCall(frame.args, ctx);
        break;
      case "sys.token.create":
        data = await handleSysTokenCreate(frame.args, ctx);
        break;
      case "sys.token.list":
        data = handleSysTokenList(frame.args, ctx);
        break;
      case "sys.token.revoke":
        data = handleSysTokenRevoke(frame.args, ctx);
        break;
      case "sys.link":
        data = handleSysLink(frame.args, ctx);
        break;
      case "sys.unlink":
        data = handleSysUnlink(frame.args, ctx);
        break;
      case "sys.link.list":
        data = handleSysLinkList(frame.args, ctx);
        break;
      case "sys.link.consume":
        data = handleSysLinkConsume(frame.args, ctx);
        break;

      // --- account.* ---
      case "account.create":
        data = await handleAccountCreate(frame.args, ctx);
        break;
      case "account.list":
        data = handleAccountList(frame.args, ctx);
        break;

      // --- sched.* ---
      case "sched.list":
        data = handleSchedulerList(frame.args, ctx);
        break;
      case "sched.add":
        data = await handleSchedulerAdd(frame.args, ctx);
        break;
      case "sched.update":
        data = await handleSchedulerUpdate(frame.args, ctx);
        break;
      case "sched.remove":
        data = await handleSchedulerRemove(frame.args, ctx);
        break;
      case "sched.run":
        data = await handleSchedulerRun(frame.args, ctx);
        break;

      // --- r12y.* ---
      case "r12y.list":
        data = handleResponsibilityList(frame.args, ctx);
        break;
      case "r12y.get":
        data = handleResponsibilityGet(frame.args, ctx);
        break;
      case "r12y.create":
        data = await handleResponsibilityCreate(frame.args, ctx);
        break;
      case "r12y.update":
        data = await handleResponsibilityUpdate(frame.args, ctx);
        break;
      case "r12y.changes":
        data = handleResponsibilityChanges(frame.args, ctx);
        break;

      // --- adapter.* ---
      case "adapter.connect":
        data = await handleAdapterConnect(frame.args, ctx);
        break;
      case "adapter.disconnect":
        data = await handleAdapterDisconnect(frame.args, ctx);
        break;
      case "adapter.inbound":
        data = await handleAdapterInbound(frame.args, ctx, frame.body);
        break;
      case "adapter.state.update":
        data = handleAdapterStateUpdate(frame.args, ctx);
        break;
      case "adapter.send":
        data = await handleAdapterSend(frame.args, ctx, frame.body);
        break;
      case "adapter.status":
        data = await handleAdapterStatus(frame.args, ctx);
        break;
      case "adapter.list":
        data = await handleAdapterList(frame.args, ctx);
        break;
      case "adapter.pair.info":
        data = await handleAdapterPairInfo(frame.args, ctx);
        break;
      case "adapter.pair.inspect":
        data = await handleAdapterPairInspect(frame.args, ctx);
        break;
      case "adapter.pair.confirm":
        data = await handleAdapterPairConfirm(frame.args, ctx);
        break;
      case "adapter.pair.disconnect":
        data = await handleAdapterPairDisconnect(frame.args, ctx);
        break;

      case "signal.watch":
        data = handleSignalWatch(frame.args, ctx);
        break;
      case "signal.unwatch":
        data = handleSignalUnwatch(frame.args, ctx);
        break;

      default:
        return errFrame(frameId, 404, "Unknown syscall");
    }

    // SAFETY: each exhaustive switch branch assigns the result declared for
    // that exact syscall before the response envelope is constructed.
    return { type: "res", id: frame.id, ok: true, data } as ResponseFrame;
  } catch (err) {
    if (ctx.requestSignal?.aborted) {
      return errFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal));
    }
    const message = err instanceof Error ? err.message : String(err);
    return errFrame(frame.id, 500, message);
  }
}

async function routeToTarget(
  frame: RequestFrame,
  target: TargetDescriptor,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (!target.online) {
    return {
      handled: true,
      response: errFrame(frame.id, 503, `Device offline: ${target.targetId}`),
    };
  }

  if (!targetCanHandle(target, frame.call)) {
    return {
      handled: true,
      response: errFrame(frame.id, 400, `Device ${target.targetId} does not implement ${frame.call}`),
    };
  }

  const deviceConn = findDeviceConnection(target.targetId, deps.connections);
  if (!deviceConn) {
    return {
      handled: true,
      response: errFrame(frame.id, 503, `No active connection for device: ${target.targetId}`),
    };
  }

  let route: {
    cancel: () => void;
    attachBody: (body: CancellableFrameBody) => void;
  } | null = null;
  const ttlMs = routedFrameTtlMs(frame);
  try {
    route = await deps.registerRoute({
      id: frame.id,
      call: frame.call,
      origin,
      deviceId: target.targetId,
      driverConnectionId: deviceConn.id,
      ttlMs,
    });
    if (ctx.requestSignal?.aborted) {
      route.cancel();
      return {
        handled: true,
        response: errFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal)),
      };
    }
  } catch (error) {
    route?.cancel();
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: errFrame(frame.id, 500, `Failed to register route for ${frame.call}: ${message}`),
    };
  }

  try {
    const outgoing = deps.sendFrame(deviceConn, frame);
    if (outgoing) {
      route.attachBody(outgoing);
    }
  } catch (error) {
    route.cancel();
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: errFrame(frame.id, 500, `Failed to send ${frame.call} to device ${target.targetId}: ${message}`),
    };
  }

  return { handled: false };
}

export function routedFrameTtlMs(frame: RequestFrame): number {
  if (frame.call === "shell.exec") {
    const requested = frame.args.timeout;
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
      return DEFAULT_SHELL_DEVICE_TTL_MS;
    }
    return Math.min(
      DEFAULT_SHELL_DEVICE_TTL_MS,
      Math.max(1_000, Math.trunc(requested) + SHELL_TIMEOUT_GRACE_MS),
    );
  }
  if (frame.call === "net.fetch") {
    return normalizeNetFetchTimeoutMs(frame.args.timeoutMs);
  }
  return DEFAULT_DEVICE_TTL_MS;
}

function findDeviceConnection(
  deviceId: string,
  connections: Map<string, KernelConnection<KernelConnectionState>>,
): KernelConnection<KernelConnectionState> | null {
  for (const [, conn] of connections) {
    const state = conn.state;
    if (
      state?.step === "connected" &&
      state.peer?.id === deviceId &&
      state.peer.grant.implements.length > 0
    ) {
      return conn;
    }
  }
  return null;
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function requestCancelMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Request cancelled";
}

function failedShellSessionFrame(id: string, session: ShellSessionRecord): ResponseFrame {
  const data: Extract<
    NonNullable<ResponseOkFrame<"shell.exec">["data"]>,
    { status: "failed" }
  > = {
    status: "failed",
    output: "",
    error: session.error ?? "Shell session failed",
    sessionId: session.sessionId,
  };
  if (session.exitCode !== null) data.exitCode = session.exitCode;
  return {
    type: "res",
    id,
    ok: true,
    data,
  };
}

function routableFrameArgs(frame: RequestFrame): RoutingTargetArgs | null {
  if (!isRoutableSyscall(frame.call)) return null;
  // SAFETY: routable syscall schemas are extended with the optional string
  // target metadata before they enter dispatch; native syscall args omit it.
  return frame.args as typeof frame.args & RoutingTargetArgs;
}
