/**
 * Kernel syscall dispatcher.
 *
 * Switch-based — every syscall is explicitly mapped for full visibility.
 * `target` is extracted at the dispatch boundary and stripped before
 * native handlers see it.
 *
 * Returns a ResponseFrame for native-handled syscalls, or `null` when
 * the request was forwarded to a device (response will arrive later via
 * the routing table).
 */

import type { Connection } from "agents";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { SyscallName } from "../syscalls";
import type { KernelContext } from "./context";
import type { RoutingTable, RouteOrigin } from "./routing";
import type { ShellSessionRecord, ShellSessionStore } from "./shell-sessions";
import {
  handleFsRead,
  handleFsWrite,
  handleFsEdit,
  handleFsDelete,
  handleFsSearch,
} from "../drivers/native/fs";
import { handleShellExec } from "../drivers/native/shell";
import { handleAiTools, handleAiConfig } from "./ai";
import {
  handleProcList,
  handleProcIpcCall,
  handleProcIpcSend,
  handleProcProfileList,
  handleProcSpawn,
  forwardToProcess,
} from "./proc-handlers";
import { handleSysConfigGet, handleSysConfigSet } from "./sys/config";
import { handleSysDeviceGet, handleSysDeviceList, handleSysDeviceUpdate } from "./sys/device";
import { handleSysWorkspaceList } from "./sys/workspaces";
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
  handleRepoDiff,
  handleRepoImport,
  handleRepoList,
  handleRepoLog,
  handleRepoRead,
  handleRepoRefs,
  handleRepoSearch,
} from "./repo";
import {
  handleSysTokenCreate,
  handleSysTokenList,
  handleSysTokenRevoke,
} from "./sys/token";
import {
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
  handleAdapterSend,
  handleAdapterStateUpdate,
  handleAdapterStatus,
} from "./adapter-handlers";
import {
  handleNotificationCreate,
  handleNotificationDismiss,
  handleNotificationList,
  handleNotificationMarkRead,
} from "./notifications";
import {
  handleSocialAgentCardGet,
  handleSocialAgentCardUpdate,
  handleSocialFriendAdd,
  handleSocialFriendGrantsSet,
  handleSocialFriendList,
  handleSocialFriendRemove,
  handleSocialInbound,
  handleSocialMessageReply,
  handleSocialMessageSend,
  handleSocialSetup,
  handleSocialIdentityGet,
  handleSocialIdentitySet,
  handleSocialInstanceGet,
  handleSocialInstanceUpdate,
  handleSocialProfileGet,
  handleSocialProfileUpdate,
  handleSocialRequestCreate,
  handleSocialRequestGet,
  handleSocialRequestList,
  handleSocialRequestRespond,
  handleSocialThreadCreate,
  handleSocialThreadGet,
  handleSocialThreadList,
} from "./social";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "./scheduler";

export type DispatchDeps = {
  routingTable: RoutingTable;
  shellSessions: ShellSessionStore;
  connections: Map<string, Connection>;
  scheduleExpiry: (id: string, ttlMs: number) => Promise<string>;
};

export type DispatchResult =
  | { handled: true; response: ResponseFrame }
  | { handled: false };

const DEFAULT_DEVICE_TTL_MS = 60_000;

/**
 * Domains that support device routing via the `target` field.
 * `shell` always requires a device. `fs` can be native (R2) or device.
 * Other domains (sys, proc, sched, adapter) are always kernel-internal.
 */
const ROUTABLE_DOMAINS = new Set(["fs", "shell"]);

function isRoutable(call: SyscallName): boolean {
  const domain = call.split(".")[0];
  return ROUTABLE_DOMAINS.has(domain);
}

export async function dispatch(
  frame: RequestFrame,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<DispatchResult> {
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
      const identity = ctx.identity!;
      if (!ctx.devices.canAccess(session.deviceId, identity.process.uid, identity.process.gids)) {
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
    return routeToDevice(frame, session.deviceId, origin, ctx, deps);
  }

  if (target && target !== "gsv" && isRoutable(frame.call)) {
    delete raw.target;
    return routeToDevice(frame, target, origin, ctx, deps);
  }

  if (target) {
    delete raw.target;
  }

  const result = await dispatchNative(frame, ctx);
  return {
    handled: true,
    response: result,
  };
}

async function dispatchNative(
  frame: RequestFrame,
  ctx: KernelContext,
): Promise<ResponseFrame> {
  const frameId = frame.id;

  try {
    let data: unknown;

    switch (frame.call) {
      case "fs.read":
        data = await handleFsRead(frame.args, ctx);
        break;
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

      case "shell.exec":
        data = await handleShellExec(frame.args, ctx);
        break;

      case "codemode.run":
        data = await forwardToProcess(frame, ctx);
        break;

      case "proc.list":
        data = handleProcList(frame.args, ctx);
        break;
      case "proc.profile.list":
        data = handleProcProfileList(frame.args, ctx);
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
      case "proc.media.read":
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
      case "proc.reset":
        data = await forwardToProcess(frame, ctx);
        break;
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
        data = handlePkgInstall(frame.args, ctx);
        break;
      case "pkg.review.approve":
        data = handlePkgReviewApprove(frame.args, ctx);
        break;
      case "pkg.remove":
        data = handlePkgRemove(frame.args, ctx);
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

      // --- ai.* ---
      case "ai.tools":
        data = await handleAiTools(ctx);
        break;
      case "ai.config":
        data = await handleAiConfig(frame.args, ctx);
        break;

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
      case "sys.workspace.list":
        data = handleSysWorkspaceList(frame.args, ctx);
        break;
      case "sys.oauth.start":
        data = await handleSysOAuthStart(frame.args, ctx);
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

      case "social.setup":
        data = await handleSocialSetup(frame.args, ctx);
        break;
      case "social.identity.get":
        data = handleSocialIdentityGet(frame.args, ctx);
        break;
      case "social.identity.set":
        data = handleSocialIdentitySet(frame.args, ctx);
        break;
      case "social.profile.get":
        data = handleSocialProfileGet(frame.args, ctx);
        break;
      case "social.profile.update":
        data = await handleSocialProfileUpdate(frame.args, ctx);
        break;
      case "social.instance.get":
        data = handleSocialInstanceGet(frame.args, ctx);
        break;
      case "social.instance.update":
        data = await handleSocialInstanceUpdate(frame.args, ctx);
        break;
      case "social.agent.card.get":
        data = handleSocialAgentCardGet(frame.args, ctx);
        break;
      case "social.agent.card.update":
        data = await handleSocialAgentCardUpdate(frame.args, ctx);
        break;
      case "social.friend.list":
        data = handleSocialFriendList(frame.args, ctx);
        break;
      case "social.friend.add":
        data = await handleSocialFriendAdd(frame.args, ctx);
        break;
      case "social.friend.remove":
        data = handleSocialFriendRemove(frame.args, ctx);
        break;
      case "social.friend.grants.set":
        data = handleSocialFriendGrantsSet(frame.args, ctx);
        break;
      case "social.thread.create":
        data = await handleSocialThreadCreate(frame.args, ctx);
        break;
      case "social.thread.list":
        data = handleSocialThreadList(frame.args, ctx);
        break;
      case "social.thread.get":
        data = handleSocialThreadGet(frame.args, ctx);
        break;
      case "social.message.send":
        data = await handleSocialMessageSend(frame.args, ctx);
        break;
      case "social.message.reply":
        data = await handleSocialMessageReply(frame.args, ctx);
        break;
      case "social.request.create":
        data = await handleSocialRequestCreate(frame.args, ctx);
        break;
      case "social.request.list":
        data = handleSocialRequestList(frame.args, ctx);
        break;
      case "social.request.get":
        data = handleSocialRequestGet(frame.args, ctx);
        break;
      case "social.request.respond":
        data = await handleSocialRequestRespond(frame.args, ctx);
        break;
      case "social.inbound":
        data = await handleSocialInbound(frame.args, ctx);
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
    const message = err instanceof Error ? err.message : String(err);
    return errFrame(frame.id, 500, message);
  }
}

async function routeToDevice(
  frame: RequestFrame,
  deviceId: string,
  origin: RouteOrigin,
  ctx: KernelContext,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const identity = ctx.identity!;

  if (!ctx.devices.canAccess(deviceId, identity.process.uid, identity.process.gids)) {
    return {
      handled: true,
      response: errFrame(frame.id, 403, `Access denied to device: ${deviceId}`),
    };
  }

  const device = ctx.devices.get(deviceId);
  if (!device || !device.online) {
    return {
      handled: true,
      response: errFrame(frame.id, 503, `Device offline: ${deviceId}`),
    };
  }

  if (!ctx.devices.canHandle(deviceId, frame.call)) {
    return {
      handled: true,
      response: errFrame(frame.id, 400, `Device ${deviceId} does not implement ${frame.call}`),
    };
  }

  const deviceConn = findDeviceConnection(deviceId, deps.connections);
  if (!deviceConn) {
    return {
      handled: true,
      response: errFrame(frame.id, 503, `No active connection for device: ${deviceId}`),
    };
  }

  const scheduleId = await deps.scheduleExpiry(frame.id, DEFAULT_DEVICE_TTL_MS);

  deps.routingTable.register(
    frame.id,
    frame.call,
    origin,
    deviceId,
    { ttlMs: DEFAULT_DEVICE_TTL_MS, scheduleId },
  );

  deviceConn.send(JSON.stringify({
    type: "req",
    id: frame.id,
    call: frame.call,
    args: frame.args,
  }));

  return { handled: false };
}

function findDeviceConnection(
  deviceId: string,
  connections: Map<string, Connection>,
): Connection | null {
  for (const [, conn] of connections) {
    const state = conn.state as { identity?: { role: string; device?: string } } | undefined;
    if (state?.identity?.role === "driver" && state.identity.device === deviceId) {
      return conn;
    }
  }
  return null;
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
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
