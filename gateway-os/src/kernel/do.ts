import {
  Connection,
  ConnectionContext,
  Agent as Host,
  type WSMessage,
} from "agents";
import type { Frame, RequestFrame, ResponseFrame } from "../protocol/frames";
import type { ConnectionIdentity, ProcessIdentity } from "../syscalls/system";
import { CapabilityStore, hasCapability } from "./capabilities";
import { DeviceRegistry } from "./devices";
import { RoutingTable, type RouteOrigin } from "./routing";
import { ProcessRegistry } from "./processes";
import { handleConnect } from "./connect";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";

const SERVER_VERSION = "0.0.1";

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
};

export class Kernel extends Host<Env> {
  private readonly caps: CapabilityStore;
  private readonly devices: DeviceRegistry;
  private readonly routes: RoutingTable;
  private readonly procs: ProcessRegistry;
  private readonly connections = new Map<string, Connection>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.caps = new CapabilityStore(ctx.storage.sql);
    this.caps.init();

    this.devices = new DeviceRegistry(ctx.storage.sql);
    this.devices.init();

    this.routes = new RoutingTable(ctx.storage.sql);
    this.routes.init();

    this.procs = new ProcessRegistry(ctx.storage.sql);
    this.procs.init();
  }

  shouldSendProtocolMessages(_: Connection, __: ConnectionContext): boolean {
    return false;
  }

  onConnect(connection: Connection): void {
    const state: ConnectionState = { step: "pending" };
    connection.setState(state);
  }

  onClose(connection: Connection): void {
    const state = connection.state as ConnectionState | undefined;
    if (!state) return;

    this.connections.delete(connection.id);

    const identity = state.identity;

    if (identity?.role === "driver") {
      this.devices.setOnline(identity.device, false);
      this.failRoutesForDevice(identity.device);
    }

    this.failRoutesForConnection(connection.id);
  }

  async onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      // TODO: binary stream frames
      return;
    }

    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      this.sendError(connection, "?", 400, "Malformed JSON");
      return;
    }

    if (!frame.type || !["req", "res", "sig"].includes(frame.type)) {
      this.sendError(connection, "?", 400, "Invalid frame type");
      return;
    }

    switch (frame.type) {
      case "req":
        await this.handleReq(connection, frame);
        break;
      case "res":
        this.handleRes(connection, frame);
        break;
      case "sig":
        // TODO: inbound signals
        break;
    }
  }

  /**
   * RPC method — called by Process DOs to send/receive frames.
   *
   * Returns a Frame if the request was handled synchronously (native syscall),
   * or null if deferred (forwarded to a device — result will arrive later
   * via process.recvFrame callback).
   */
  async recvFrame(processId: string, frame: Frame): Promise<Frame | null> {
    if (frame.type === "req") {
      return this.handleProcessReq(processId, frame as RequestFrame);
    }

    if (frame.type === "res") {
      // Process responding to a kernel-initiated request (future use)
      return null;
    }

    // sig — inbound signals from process (future use)
    return null;
  }

  private async handleProcessReq(processId: string, frame: RequestFrame): Promise<Frame | null> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return errFrame(frame.id, 404, "Unknown process");
    }

    const connIdentity: ConnectionIdentity = {
      role: "user",
      process: identity,
      capabilities: this.caps.resolve(identity.gids),
    };

    if (!hasCapability(connIdentity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx: KernelContext = {
      env: this.env,
      caps: this.caps,
      devices: this.devices,
      procs: this.procs,
      connection: null as unknown as Connection,
      identity: connIdentity,
      serverVersion: SERVER_VERSION,
    };

    const origin: RouteOrigin = { type: "process", id: processId };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      return result.response;
    }

    return null;
  }

  private buildContext(connection: Connection<ConnectionState>): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return {
      env: this.env,
      caps: this.caps,
      devices: this.devices,
      procs: this.procs,
      connection,
      identity: state.identity as ConnectionIdentity,
      serverVersion: SERVER_VERSION,
    };
  }

  private buildDispatchDeps(): DispatchDeps {
    return {
      routingTable: this.routes,
      connections: this.connections,
      scheduleExpiry: async (id: string, ttlMs: number) => {
        const sched = await this.schedule(
          ttlMs / 1000,
          "onRouteExpired",
          id,
        );
        return sched.id;
      },
    };
  }

  private async handleReq(connection: Connection<ConnectionState>, frame: RequestFrame): Promise<void> {
    const state = connection.state as ConnectionState | undefined;

    if (frame.call === "sys.connect") {
      if (state?.step === "connected") {
        this.sendError(connection, frame.id, 409, "Already connected");
        return;
      }
      await this.handleSysConnect(connection, frame);
      return;
    }

    if (!state || state.step !== "connected" || !state.identity) {
      this.sendError(connection, frame.id, 403, "Must call sys.connect first");
      return;
    }

    if (!hasCapability(state.identity.capabilities, frame.call)) {
      this.sendError(connection, frame.id, 403, `Permission denied: ${frame.call}`);
      return;
    }

    const ctx = this.buildContext(connection);
    const origin: RouteOrigin = { type: "connection", id: connection.id };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      connection.send(JSON.stringify(result.response));
    }
    // If not handled, request was forwarded to a device.
    // Response will come back via handleRes when the device responds.
  }

  private async handleSysConnect(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.connect">,
  ): Promise<void> {
    const ctx = this.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.sendError(connection, frame.id, outcome.code, outcome.message);
      return;
    }

    const uid = outcome.identity.process.uid;
    const clientId = frame.args?.client?.id;
    if (clientId) {
      for (const [connId, existing] of this.connections) {
        const existingState = existing.state as ConnectionState | undefined;
        if (
          existingState?.identity?.process.uid === uid &&
          connId !== ctx.connection.id &&
          existing !== connection
        ) {
          existing.close(1000, "Replaced by newer connection");
          this.connections.delete(connId);
        }
      }
    }

    const newState: ConnectionState = {
      step: "connected",
      identity: outcome.identity,
    };
    connection.setState(newState);
    this.connections.set(ctx.connection.id, connection);

    this.sendOk(connection, frame.id, outcome.result);
  }

  private handleRes(_connection: Connection, frame: ResponseFrame): void {
    const consumed = this.routes.consume(frame.id);
    if (!consumed) return;

    if (consumed.scheduleId) {
      this.cancelSchedule(consumed.scheduleId).catch(() => {});
    }

    this.deliverToOrigin(consumed.origin, frame);
  }

  /**
   * Schedule callback — fired when a routing table entry expires.
   */
  async onRouteExpired(routeId: string): Promise<void> {
    const expired = this.routes.expire(routeId);
    if (!expired) return;

    const timeoutFrame: ResponseFrame = {
      type: "res",
      id: routeId,
      ok: false,
      error: { code: 504, message: `Syscall ${expired.call} timed out (device: ${expired.deviceId})` },
    };

    this.deliverToOrigin(expired.origin, timeoutFrame);
  }

  private deliverToOrigin(origin: RouteOrigin, frame: ResponseFrame): void {
    if (origin.type === "connection") {
      const conn = this.connections.get(origin.id);
      if (conn) {
        conn.send(JSON.stringify(frame));
      }
      return;
    }

    if (origin.type === "process") {
      const stub = this.env.PROCESS.get(
        this.env.PROCESS.idFromName(origin.id),
      );
      stub.recvFrame(frame).catch((err: unknown) => {
        console.error(`[Kernel] Failed to deliver frame to process ${origin.id}:`, err);
      });
    }
  }

  private failRoutesForDevice(deviceId: string): void {
    const failed = this.routes.failForDevice(deviceId);
    for (const entry of failed) {
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }

      const errorFrame: ResponseFrame = {
        type: "res",
        id: entry.id,
        ok: false,
        error: { code: 503, message: `Device disconnected: ${deviceId}` },
      };
      this.deliverToOrigin(entry.origin, errorFrame);
    }
  }

  private failRoutesForConnection(connectionId: string): void {
    const failed = this.routes.failForConnection(connectionId);
    for (const entry of failed) {
      if (entry.scheduleId) {
        this.cancelSchedule(entry.scheduleId).catch(() => {});
      }
    }
  }

  private sendOk(connection: Connection, id: string, data?: unknown): void {
    connection.send(JSON.stringify({ type: "res", id, ok: true, data }));
  }

  private sendError(
    connection: Connection,
    id: string,
    code: number,
    message: string,
  ): void {
    connection.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: { code, message },
      }),
    );
  }
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}
