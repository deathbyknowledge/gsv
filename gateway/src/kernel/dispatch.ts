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

import type { Connection } from "agents";
import type {
  FrameBody,
  RequestFrame,
  ResponseFrame,
  ResponseOkFrame,
} from "../protocol/frames";
import { isRoutableSyscall, type SyscallName } from "../syscalls";
import type { KernelContext } from "./context";
import type { RouteOrigin } from "./routing";
import type { ShellSessionRecord, ShellSessionStore } from "./shell-sessions";
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
  handlePkgAdd,
  handlePkgCheckout,
  handlePkgCreate,
  handlePkgInstall,
  handlePkgList,
  handlePkgPublicList,
  handlePkgPublicSet,
  handlePkgRemoteAdd,
  handlePkgRemoteList,
  handlePkgRemoteRemove,
  handlePkgRemove,
  handlePkgReviewApprove,
  handlePkgSync,
} from "./pkg";
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
  handleAdapterSend,
  handleAdapterShellExec,
  handleAdapterStateUpdate,
  handleAdapterStatus,
} from "./adapter-handlers";
import {
  handleNotificationCreate,
  handleNotificationDismiss,
  handleNotificationList,
  handleNotificationMarkRead,
} from "./notifications";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "./scheduler";
import {
  AppSyscallError,
  handleAppAttach,
  handleAppClose,
  handleAppDetach,
  handleAppList,
  handleAppOpen,
} from "./apps";
import {
  getVisibleTarget,
  targetCanHandle,
  type TargetDescriptor,
} from "./targets";
export type DispatchDeps = {
  shellSessions: ShellSessionStore;
  connections: Map<string, Connection>;
  sendFrame: (
    connection: Connection,
    frame: RequestFrame | ResponseFrame,
  ) => { cancel(reason?: unknown): Promise<void> } | null;
  registerRoute: (route: {
    id: string;
    call: SyscallName;
    origin: RouteOrigin;
    deviceId: string;
    ttlMs: number;
  }) => Promise<{
    cancel: () => void;
    attachBody: (body: { cancel(reason?: unknown): Promise<void> }) => void;
  }>;
  requestDevice: (
    deviceId: string,
    call: string,
    args: unknown,
    options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
  ) => Promise<ResponseOkFrame>;
  request: (
    frame: RequestFrame,
    ctx: KernelContext,
    signal?: AbortSignal,
  ) => Promise<ResponseFrame>;
};

export type DispatchResult =
  | { handled: true; response: ResponseFrame }
  | { handled: false };

const DEFAULT_DEVICE_TTL_MS = 60_000;

export async function dispatch(
  frame: RequestFrame,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (ctx.requestSignal?.aborted) {
    return {
      handled: true,
      response: errFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal)),
    };
  }
  const raw = frame.args as Record<string, unknown>;
  const target = raw.target as string | undefined;
  const sessionId = frame.call === "shell.exec" && typeof raw.sessionId === "string"
    ? raw.sessionId.trim()
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
    delete raw.target;
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
    delete raw.target;
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
    delete raw.target;
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
          fsCopyTransport: deps,
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

      case "app.open":
        data = await handleAppOpen(frame.args, ctx);
        break;
      case "app.attach":
        data = await handleAppAttach(frame.args, ctx);
        break;
      case "app.list":
        data = handleAppList(frame.args, ctx);
        break;
      case "app.detach":
        data = await handleAppDetach(frame.args, ctx);
        break;
      case "app.close":
        data = await handleAppClose(frame.args, ctx);
        break;

      case "codemode.run":
        return {
          type: "res",
          id: frame.id,
          ok: true,
          ...await forwardToProcess(frame, ctx),
        };

      case "proc.list":
        data = handleProcList(frame.args, ctx);
        break;
      case "proc.spawn":
        data = await handleProcSpawn(frame.args, ctx);
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
      case "proc.media.read":
      case "proc.media.write":
      case "proc.media.delete":
      case "proc.conversation.open":
      case "proc.conversation.list":
      case "proc.conversation.get":
      case "proc.conversation.close":
      case "proc.conversation.reset":
      case "proc.conversation.policy.get":
      case "proc.conversation.policy.set":
      case "proc.conversation.compact":
      case "proc.conversation.fork":
      case "proc.conversation.segment.read":
      case "proc.conversation.segments":
      case "proc.conversation.timeline":
      case "proc.conversation.generations":
      case "proc.conversation.generation.manifest":
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

      // --- pkg.* ---
      case "pkg.list":
        data = handlePkgList(frame.args, ctx);
        break;
      case "pkg.add":
        data = await handlePkgAdd(frame.args, ctx);
        break;
      case "pkg.create":
        data = await handlePkgCreate(frame.args, ctx);
        break;
      case "pkg.sync":
        data = await handlePkgSync(frame.args, ctx);
        break;
      case "pkg.checkout":
        data = await handlePkgCheckout(frame.args, ctx);
        break;
      case "pkg.install":
        data = await handlePkgInstall(frame.args, ctx);
        break;
      case "pkg.review.approve":
        data = handlePkgReviewApprove(frame.args, ctx);
        break;
      case "pkg.remove":
        data = await handlePkgRemove(frame.args, ctx);
        break;
      case "pkg.remote.list":
        data = handlePkgRemoteList(frame.args, ctx);
        break;
      case "pkg.remote.add":
        data = handlePkgRemoteAdd(frame.args, ctx);
        break;
      case "pkg.remote.remove":
        data = handlePkgRemoteRemove(frame.args, ctx);
        break;
      case "pkg.public.list":
        data = await handlePkgPublicList(frame.args, ctx);
        break;
      case "pkg.public.set":
        data = handlePkgPublicSet(frame.args, ctx);
        break;

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
        data = await handleAiImageRead(frame.args, ctx, frame.body);
        break;
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

      // --- adapter.* ---
      case "adapter.connect":
        data = await handleAdapterConnect(frame.args, ctx);
        break;
      case "adapter.disconnect":
        data = await handleAdapterDisconnect(frame.args, ctx);
        break;
      case "adapter.inbound":
        data = await handleAdapterInbound(frame.args, ctx);
        break;
      case "adapter.state.update":
        data = handleAdapterStateUpdate(frame.args, ctx);
        break;
      case "adapter.send":
        data = await handleAdapterSend(frame.args, ctx);
        break;
      case "adapter.status":
        data = await handleAdapterStatus(frame.args, ctx);
        break;
      case "adapter.list":
        data = handleAdapterList(frame.args, ctx);
        break;

      case "notification.create":
        data = handleNotificationCreate(frame.args, ctx);
        break;
      case "notification.list":
        data = handleNotificationList(frame.args, ctx);
        break;
      case "notification.mark_read":
        data = handleNotificationMarkRead(frame.args, ctx);
        break;
      case "notification.dismiss":
        data = handleNotificationDismiss(frame.args, ctx);
        break;

      case "signal.watch":
        data = handleSignalWatch(frame.args, ctx);
        break;
      case "signal.unwatch":
        data = handleSignalUnwatch(frame.args, ctx);
        break;

      default:
        return errFrame(frameId, 404, `Unknown syscall: ${(frame as { call: string }).call}`);
    }

    return { type: "res", id: frame.id, ok: true, data } as ResponseFrame;
  } catch (err) {
    if (ctx.requestSignal?.aborted) {
      return errFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal));
    }
    if (err instanceof AppSyscallError) {
      return errFrame(frame.id, err.status, err.message);
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

  if (target.route.kind === "adapter-shell") {
    return routeToAdapterShell(frame, target.route.adapter, target.route.accountId, ctx);
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
    attachBody: (body: { cancel(reason?: unknown): Promise<void> }) => void;
  } | null = null;
  const ttlMs = routedFrameTtlMs(frame);
  try {
    route = await deps.registerRoute({
      id: frame.id,
      call: frame.call,
      origin,
      deviceId: target.targetId,
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
    const outgoing = deps.sendFrame(deviceConn, {
      type: "req",
      id: frame.id,
      call: frame.call,
      args: frame.args,
      ...(frame.body ? { body: frame.body } : {}),
    } as RequestFrame);
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

function routedFrameTtlMs(frame: RequestFrame): number {
  if (frame.call !== "net.fetch") {
    return DEFAULT_DEVICE_TTL_MS;
  }
  const timeoutMs = frame.args && typeof frame.args === "object"
    ? (frame.args as { timeoutMs?: unknown }).timeoutMs
    : undefined;
  return normalizeNetFetchTimeoutMs(timeoutMs);
}

async function routeToAdapterShell(
  frame: RequestFrame,
  adapter: string,
  accountId: string,
  ctx: KernelContext,
): Promise<DispatchResult> {
  try {
    const data = await handleAdapterShellExec(adapter, accountId, frame.args, ctx);
    return {
      handled: true,
      response: { type: "res", id: frame.id, ok: true, data },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: errFrame(frame.id, message.startsWith("Access denied") ? 403 : 500, message),
    };
  }
}

function findDeviceConnection(
  deviceId: string,
  connections: Map<string, Connection>,
): Connection | null {
  for (const [, conn] of connections) {
    const state = conn.state as {
      identity?: { role: string; device?: string };
    } | undefined;
    if (state?.identity?.role === "driver" && state.identity.device === deviceId) {
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
  return {
    type: "res",
    id,
    ok: true,
    data: {
      status: "failed",
      output: "",
      error: session.error ?? "Shell session failed",
      ...(session.exitCode !== null ? { exitCode: session.exitCode } : {}),
      sessionId: session.sessionId,
    },
  };
}
