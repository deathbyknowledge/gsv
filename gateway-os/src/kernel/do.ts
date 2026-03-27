import {
  Connection,
  ConnectionContext,
  Agent as Host,
  type WSMessage,
} from "agents";
import type { Frame, RequestFrame, ResponseFrame, SignalFrame } from "../protocol/frames";
import type {
  ConnectionIdentity,
  ProcessIdentity,
  SysSetupResult,
} from "../syscalls/system";
import type {
  AdapterOutboundMessage,
} from "../adapter-interface";
import { AuthStore } from "./auth-store";
import { CapabilityStore, hasCapability } from "./capabilities";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";
import { DeviceRegistry } from "./devices";
import { RoutingTable, type RouteOrigin } from "./routing";
import { ProcessRegistry } from "./processes";
import { AdapterStore } from "./adapter-store";
import { RunRouteStore, type AdapterRunRoute, type RunRoute } from "./run-routes";
import { WorkspaceStore } from "./workspaces";
import {
  ensureKernelBootstrapped,
  handleConnect,
  setupRequiredDetails,
  SETUP_REQUIRED_ERROR_CODE,
} from "./connect";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import { sendFrameToProcess } from "../shared/utils";
import { handleSysSetup as handleKernelSetup } from "./sys/setup";
import { isInternalOnlySyscall } from "./syscall-exposure";
import { resolveAdapterServiceForKernel } from "./adapter-handlers";

const SERVER_VERSION = "0.0.1";

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
  clientId?: string;
};

type ProcSendData = {
  ok?: boolean;
  status?: string;
  runId?: string;
  queued?: boolean;
};

export class Kernel extends Host<Env> {
  private readonly auth: AuthStore;
  private readonly caps: CapabilityStore;
  private readonly config: ConfigStore;
  private readonly devices: DeviceRegistry;
  private readonly routes: RoutingTable;
  private readonly procs: ProcessRegistry;
  private readonly workspaces: WorkspaceStore;
  private readonly adapters: AdapterStore;
  private readonly runRoutes: RunRouteStore;
  private readonly connections = new Map<string, Connection<ConnectionState>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.auth = new AuthStore(ctx.storage.sql);
    this.auth.init();

    this.caps = new CapabilityStore(ctx.storage.sql);
    this.caps.init();

    this.config = new ConfigStore(ctx.storage.sql);
    this.config.init();
    this.config.seed(SYSTEM_CONFIG_DEFAULTS);

    this.devices = new DeviceRegistry(ctx.storage.sql);
    this.devices.init();

    this.routes = new RoutingTable(ctx.storage.sql);
    this.routes.init();

    this.procs = new ProcessRegistry(ctx.storage.sql);
    this.procs.init();

    this.workspaces = new WorkspaceStore(ctx.storage.sql);
    this.workspaces.init();

    this.adapters = new AdapterStore(ctx.storage.sql);
    this.adapters.init();

    this.runRoutes = new RunRouteStore(ctx.storage.sql);
    this.runRoutes.init();

    this.rehydrateConnections();
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
      this.broadcastDeviceStatus(identity.device, "disconnected");
      this.failRoutesForDevice(identity.device);
    }

    this.failRoutesForConnection(connection.id);
    this.runRoutes.clearForConnection(connection.id);
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
      return this.handleProcessReq(processId, frame);
    }

    if (frame.type === "res") {
      // Process responding to a kernel-initiated request (future use)
      return null;
    }

    if (frame.type === "sig") {
      await this.handleProcessSignal(processId, frame);
      return null;
    }

    return null;
  }

  /**
   * Service-binding RPC entrypoint.
   * Accepts the same frame format as WS connections/process RPC.
   */
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    if (frame.type !== "req") {
      return null;
    }

    return this.handleServiceReq(frame);
  }

  /**
   * Relay process signals using deterministic run route lookups.
   */
  private async handleProcessSignal(processId: string, frame: SignalFrame): Promise<void> {
    if (!frame.signal.startsWith("chat.")) return;

    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      console.warn(`[Kernel] Signal from unknown process ${processId}`);
      return;
    }

    const runId = this.extractRunId(frame.payload);
    if (!runId) {
      this.broadcastToUid(identity.uid, frame.signal, frame.payload);
      return;
    }

    const route = this.runRoutes.get(runId);
    if (!route) {
      this.broadcastToUid(identity.uid, frame.signal, frame.payload);
      return;
    }

    if (route.uid !== identity.uid) {
      this.runRoutes.delete(runId);
      return;
    }

    if (route.kind === "connection") {
      this.deliverSignalToConnection(route, frame, identity.uid);
      if (frame.signal === "chat.complete") {
        this.runRoutes.delete(runId);
      }
      return;
    }

    await this.deliverSignalToAdapter(route, frame);
    if (frame.signal === "chat.complete") {
      this.runRoutes.delete(runId);
    }
  }

  private deliverSignalToConnection(
    route: Extract<RunRoute, { kind: "connection" }>,
    frame: SignalFrame,
    uid: number,
  ): void {
    const conn = this.connections.get(route.connectionId);
    if (!conn) {
      this.broadcastToUid(uid, frame.signal, frame.payload);
      return;
    }

    conn.send(JSON.stringify(frame));
  }

  private async deliverSignalToAdapter(route: AdapterRunRoute, frame: SignalFrame): Promise<void> {
    if (frame.signal !== "chat.complete") {
      return;
    }

    const payload =
      frame.payload && typeof frame.payload === "object"
        ? (frame.payload as Record<string, unknown>)
        : {};

    const text =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? `Error: ${payload.error}`
        : typeof payload.text === "string"
          ? payload.text
          : "";

    if (!text.trim()) return;

    await this.sendAdapterMessage(route.adapter, route.accountId, {
      surface: {
        kind: route.surfaceKind,
        id: route.surfaceId,
        threadId: route.threadId,
      },
      text,
    });
  }

  private async sendAdapterMessage(
    adapter: string,
    accountId: string,
    message: AdapterOutboundMessage,
  ): Promise<void> {
    const service = resolveAdapterServiceForKernel(this.env, adapter);
    if (!service || typeof service.send !== "function") {
      console.warn(`[Kernel] Adapter service unavailable for ${adapter}`);
      return;
    }

    try {
      const result = await service.send(accountId, message);
      if (!result.ok) {
        console.warn(`[Kernel] Adapter send failed (${adapter}/${accountId}): ${result.error}`);
      }
    } catch (err) {
      console.warn(`[Kernel] Adapter send threw (${adapter}/${accountId}):`, err);
    }
  }

  private async handleProcessReq(processId: string, frame: RequestFrame): Promise<ResponseFrame | null> {
    const identity = this.procs.getIdentity(processId);
    if (!identity) {
      return errFrame(frame.id, 404, "Unknown process");
    }

    const connIdentity: ConnectionIdentity = {
      role: "user",
      process: identity,
      capabilities: this.caps.resolve(identity.gids),
    };

    if (
      !isInternalOnlySyscall(frame.call) &&
      !hasCapability(connIdentity.capabilities, frame.call)
    ) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx: KernelContext = {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      connection: null as unknown as Connection,
      identity: connIdentity,
      serverVersion: SERVER_VERSION,
    };

    const origin: RouteOrigin = { type: "process", id: processId };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (result.handled) {
      this.applyPostDispatchEffects(frame, result.response);
      return result.response;
    }

    return null;
  }

  private async handleServiceReq(frame: RequestFrame): Promise<ResponseFrame> {
    if (frame.call === "sys.connect" || frame.call === "sys.setup") {
      return errFrame(frame.id, 400, `${frame.call} is not supported via serviceFrame`);
    }

    if (isInternalOnlySyscall(frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const identity = this.buildServiceBindingIdentity(frame);
    if (!hasCapability(identity.capabilities, frame.call)) {
      return errFrame(frame.id, 403, `Permission denied: ${frame.call}`);
    }

    const ctx = this.buildServiceContext(identity);
    const origin: RouteOrigin = { type: "process", id: "__service_binding__" };
    const result = await dispatch(frame, origin, ctx, this.buildDispatchDeps());

    if (!result.handled) {
      return errFrame(frame.id, 501, `${frame.call} requires unsupported async routing`);
    }

    this.applyPostDispatchEffects(frame, result.response);
    return result.response;
  }

  private buildContext(connection: Connection<ConnectionState>): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      connection,
      identity: state.identity as ConnectionIdentity,
      serverVersion: SERVER_VERSION,
    };
  }

  private buildServiceContext(identity: ConnectionIdentity): KernelContext {
    return {
      env: this.env,
      auth: this.auth,
      caps: this.caps,
      config: this.config,
      devices: this.devices,
      procs: this.procs,
      workspaces: this.workspaces,
      adapters: this.adapters,
      runRoutes: this.runRoutes,
      connection: null as unknown as Connection,
      identity,
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

    if (frame.call === "sys.setup") {
      await this.handleSysSetup(connection, frame as RequestFrame<"sys.setup">);
      return;
    }

    if (!state || state.step !== "connected" || !state.identity) {
      if (this.auth.isSetupMode()) {
        this.sendError(
          connection,
          frame.id,
          SETUP_REQUIRED_ERROR_CODE,
          "Setup required",
          setupRequiredDetails(),
        );
        return;
      }
      this.sendError(connection, frame.id, 403, "Must call sys.connect first");
      return;
    }

    if (isInternalOnlySyscall(frame.call)) {
      this.sendError(connection, frame.id, 403, `Permission denied: ${frame.call}`);
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
      this.captureConnectionRunRoute(connection.id, state.identity, frame, result.response);
      this.applyPostDispatchEffects(frame, result.response);
      connection.send(JSON.stringify(result.response));
    }
    // If not handled, request was forwarded to a device.
    // Response will come back via handleRes when the device responds.
  }

  private captureConnectionRunRoute(
    connectionId: string,
    identity: ConnectionIdentity,
    frame: RequestFrame,
    response: ResponseFrame,
  ): void {
    if (identity.role !== "user") return;
    if (frame.call !== "proc.send") return;
    if (!response.ok) return;

    const data = (response as { data?: ProcSendData }).data;
    const runId = typeof data?.runId === "string" ? data.runId : null;
    if (!runId) return;

    this.runRoutes.setConnectionRoute(runId, identity.process.uid, connectionId);
  }

  private buildServiceBindingIdentity(frame: RequestFrame): ConnectionIdentity {
    const args = frame.args as Record<string, unknown>;
    const adapterHint =
      typeof args.adapter === "string" && args.adapter.trim().length > 0
        ? args.adapter.trim().toLowerCase()
        : "service-binding";

    const root = this.auth.getPasswdByUid(0);
    const process: ProcessIdentity = root
      ? {
          uid: root.uid,
          gid: root.gid,
          gids: this.auth.resolveGids(root.username, root.gid),
          username: root.username,
          home: root.home,
          cwd: root.home,
          workspaceId: null,
        }
      : {
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
          cwd: "/root",
          workspaceId: null,
        };

    return {
      role: "service",
      process,
      capabilities: this.caps.resolve([102]),
      channel: adapterHint,
    };
  }

  private applyPostDispatchEffects(frame: RequestFrame, response: ResponseFrame): void {
    if (!response.ok) return;

    if (frame.call === "adapter.state.update") {
      const args = frame.args as {
        adapter?: unknown;
        accountId?: unknown;
        status?: unknown;
      };

      if (
        typeof args.adapter === "string" &&
        typeof args.accountId === "string" &&
        args.status &&
        typeof args.status === "object"
      ) {
        this.broadcastToRole("service", "adapter.status", {
          adapter: args.adapter,
          accountId: args.accountId,
          status: args.status,
        });
      }
    }
  }

  private async handleSysConnect(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.connect">,
  ): Promise<void> {
    const ctx = this.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.sendError(connection, frame.id, outcome.code, outcome.message, outcome.details);
      return;
    }

    const uid = outcome.identity.process.uid;
    const role = outcome.identity.role;
    const clientId = frame.args?.client?.id?.trim();
    if (clientId) {
      for (const [connId, existing] of this.connections) {
        const existingState = existing.state as ConnectionState | undefined;
        if (
          existingState?.step === "connected" &&
          existingState.identity?.process.uid === uid &&
          existingState.identity.role === role &&
          existingState.clientId === clientId &&
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
      clientId: clientId || undefined,
    };
    connection.setState(newState);
    this.connections.set(ctx.connection.id, connection);

    if (outcome.identity.role === "driver") {
      this.broadcastDeviceStatus(outcome.identity.device, "connected");
    }

    if (outcome.identity.role === "user") {
      const freshIdentity = outcome.identity.process;
      await this.ensureUserInitProcess(freshIdentity);
      this.reconcileIdentity(freshIdentity);
    }

    this.sendOk(connection, frame.id, outcome.result);
  }

  private async handleSysSetup(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.setup">,
  ): Promise<void> {
    const state = connection.state as ConnectionState | undefined;
    if (state?.step === "connected") {
      this.sendError(connection, frame.id, 409, "Already connected");
      return;
    }

    const ctx = this.buildContext(connection);
    await ensureKernelBootstrapped(ctx);

    if (!this.auth.isSetupMode()) {
      this.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleKernelSetup(frame.args, ctx);
      const setup = data as SysSetupResult;
      await this.ensureUserInitProcess(setup.user);
      this.sendOk(connection, frame.id, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(connection, frame.id, 400, message);
    }
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
      sendFrameToProcess(origin.id, frame).catch((err: unknown) => {
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

  /**
   * Compare freshly-resolved identity from auth store against ProcessRegistry.
   * If there's drift (groups changed, home changed, etc.), update the
   * registry and send identity.changed signals to all processes for that uid.
   */
  private reconcileIdentity(fresh: ProcessIdentity): void {
    const existing = this.procs.getIdentity(`init:${fresh.uid}`);
    if (!existing) return;

    if (
      existing.gid === fresh.gid &&
      existing.home === fresh.home &&
      existing.username === fresh.username &&
      JSON.stringify(existing.gids) === JSON.stringify(fresh.gids)
    ) {
      return;
    }

    const processes = this.procs.list(fresh.uid);
    for (const proc of processes) {
      this.procs.updateIdentity(proc.processId, fresh);

      sendFrameToProcess(proc.processId, {
        type: "sig",
        signal: "identity.changed",
        payload: { identity: fresh },
      }).catch((err: unknown) => {
        console.error(`[Kernel] Failed to send identity.changed to ${proc.processId}:`, err);
      });
    }
  }

  /**
   * Broadcast a signal to all active WebSocket connections belonging to a UID.
   * Skips service connections — adapter traffic is explicit via adapter.send.
   */
  broadcastToUid(uid: number, signal: string, payload?: unknown): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state) continue;
      if (state.identity?.role === "service") continue;
      if (state.identity?.process.uid === uid) {
        conn.send(json);
      }
    }
  }

  private broadcastToRole(role: ConnectionIdentity["role"], signal: string, payload?: unknown): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state?.identity) continue;
      if (state.identity.role !== role) continue;
      conn.send(json);
    }
  }

  private broadcastDeviceStatus(
    deviceId: string,
    event: "connected" | "disconnected",
  ): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    const frame: SignalFrame = {
      type: "sig",
      signal: "device.status",
      payload: {
        event,
        device: {
          deviceId: device.device_id,
          ownerUid: device.owner_uid,
          platform: device.platform,
          version: device.version,
          online: device.online,
          firstSeenAt: device.first_seen_at,
          lastSeenAt: device.last_seen_at,
          connectedAt: device.connected_at,
          disconnectedAt: device.disconnected_at,
        },
      },
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.connections) {
      const state = conn.state;
      if (!state?.identity) continue;
      if (state.identity.role === "service") continue;

      if (state.identity.role === "user") {
        const proc = state.identity.process;
        if (!this.devices.canAccess(deviceId, proc.uid, [...proc.gids])) {
          continue;
        }
      } else if (state.identity.role === "driver") {
        if (state.identity.device !== deviceId) {
          continue;
        }
      }

      conn.send(json);
    }
  }

  /**
   * Rebuild in-memory connection index after hibernation/wake.
   * The Agent runtime restores Connection objects and their persisted state,
   * but our local maps must be reconstructed per constructor invocation.
   */
  private rehydrateConnections(): void {
    const live = this.getConnections<ConnectionState>();

    const onlineDrivers = new Set<string>();

    for (const connection of live) {
      const state = connection.state;
      if (!state || state.step !== "connected" || !state.identity) continue;

      this.connections.set(connection.id, connection);
      if (state.identity.role === "driver") {
        onlineDrivers.add(state.identity.device);
        this.devices.setOnline(state.identity.device, true);
      }
    }

    // Reconcile persistent device online flags with live rehydrated sockets.
    for (const device of this.devices.listOnline()) {
      if (!onlineDrivers.has(device.device_id)) {
        this.devices.setOnline(device.device_id, false);
        this.broadcastDeviceStatus(device.device_id, "disconnected");
      }
    }
  }

  private async ensureUserInitProcess(identity: ProcessIdentity): Promise<string> {
    const { pid, created } = this.procs.ensureInit(identity);

    if (created) {
      await sendFrameToProcess(pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.setidentity",
        args: { pid, identity, profile: "init" },
      } as RequestFrame);
    }

    return pid;
  }

  private extractRunId(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const maybe = (payload as Record<string, unknown>).runId;
    return typeof maybe === "string" && maybe.trim().length > 0 ? maybe : null;
  }

  private sendOk(connection: Connection, id: string, data?: unknown): void {
    connection.send(JSON.stringify({ type: "res", id, ok: true, data }));
  }

  private sendError(
    connection: Connection,
    id: string,
    code: number,
    message: string,
    details?: unknown,
  ): void {
    connection.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
        },
      }),
    );
  }
}

function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}
