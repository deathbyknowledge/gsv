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
  handleProcSpawn,
  forwardToProcess,
} from "./proc-handlers";
import { handleSysConfigGet, handleSysConfigSet } from "./sys/config";
import { handleSysDeviceGet, handleSysDeviceList } from "./sys/device";
import { handleSysWorkspaceList } from "./sys/workspaces";
import { handleSysBootstrap } from "./sys/bootstrap";
import {
  handlePkgCheckout,
  handlePkgInstall,
  handlePkgList,
  handlePkgRemove,
  handlePkgRepoLog,
  handlePkgRepoRead,
  handlePkgRepoRefs,
  handlePkgSync,
} from "./pkg";
import {
  handleSysTokenCreate,
  handleSysTokenList,
  handleSysTokenRevoke,
} from "./sys/token";
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

export type DispatchDeps = {
  routingTable: RoutingTable;
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
      case "shell.signal":
      case "shell.list":
        return errFrame(frame.id, 501, `${frame.call} requires a device target`);

      case "proc.list":
        data = handleProcList(frame.args, ctx);
        break;
      case "proc.spawn":
        data = await handleProcSpawn(frame.args, ctx);
        break;
      case "proc.send":
      case "proc.kill":
      case "proc.history":
      case "proc.reset":
        data = await forwardToProcess(frame, ctx);
        break;
      case "proc.setidentity":
        return errFrame(frame.id, 403, "proc.setidentity is kernel-only");

      // --- pkg.* ---
      case "pkg.list":
        data = handlePkgList(frame.args, ctx);
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
      case "pkg.remove":
        data = handlePkgRemove(frame.args, ctx);
        break;
      case "pkg.repo.refs":
        data = await handlePkgRepoRefs(frame.args, ctx);
        break;
      case "pkg.repo.read":
        data = await handlePkgRepoRead(frame.args, ctx);
        break;
      case "pkg.repo.log":
        data = await handlePkgRepoLog(frame.args, ctx);
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
      case "sys.workspace.list":
        data = handleSysWorkspaceList(frame.args, ctx);
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
      case "sched.add":
      case "sched.update":
      case "sched.remove":
      case "sched.run":
        return errFrame(frame.id, 501, `${frame.call} not yet implemented`);

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
