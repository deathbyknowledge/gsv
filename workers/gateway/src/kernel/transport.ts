import {
  z,
} from "zod";
import type {
  Frame,
  FrameBody,
  FrameError,
  RequestFrame,
  ResponseOkFrame,
  ResponseFrame,
  SignalFrame,
} from "../protocol/frames";
import {
  decodeWireFrameJson,
  decodeWireResponse,
  InvalidWireFrameError,
} from "../protocol/decode-wire-frame";
import type {
  WireFrame,
  WireRequestFrame,
  WireResponseEnvelope,
  WireResponseFrame,
} from "@humansandmachines/gsv/protocol";
import type {
  JsonValue,
  NetFetchArgs,
  ShellExecResult,
} from "@humansandmachines/gsv/protocol";
import {
  BinaryBodyChannel,
  REQUEST_CANCEL_SIGNAL,
  type BinaryFrameDescriptor,
  type OutgoingBinaryBody,
} from "@humansandmachines/gsv/protocol";
import type {
  SyscallName,
} from "../syscalls";
import {
  type FailedTargetRoute,
  type RouteOrigin,
} from "./routing";
import {
  type ShellSessionStatus,
} from "./shell-sessions";
import {
  setupRequiredDetails,
  SETUP_REQUIRED_ERROR_CODE,
} from "./connect";
import {
  bindByteStreamToAbort,
} from "../shared/streams";
import {
  peerProvidesOperations,
} from "./peer";
import {
  sendFrameToProcess,
} from "../shared/utils";
import {
  KernelConnection,
  type KernelConnectionState as ConnectionState,
  type KernelWebSocketMessage,
} from "./connection";
import {
  sameRouteOrigin,
} from "./do-shared";
import type { Kernel } from "./do";
import {
  RequestCancelledError,
  cancelUnlockedBody,
  errFrame,
  requestAbortError,
} from "./do-shared";
import type {
  TargetRequestOptions,
  FrameCancellationReason,
} from "./do-shared";

const PROCESS_REQUEST_CANCEL_TTL_MS = 60_000;

const MAX_PROCESS_REQUEST_CANCELLATIONS = 1024;

const MAX_REQUEST_CANCEL_REASON_LENGTH = 512;

type CancellableFrameBody = {
  cancel(reason?: FrameCancellationReason): Promise<void>;
};

type PendingKernelResponse = {
  promise: Promise<ResponseFrame>;
  cleanup: () => void;
};


const execStatusPayloadSchema = z.object({
  sessionId: z.string().trim().min(1),
  event: z.string().optional().default(""),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
});

const requestCancelPayloadSchema = z.object({
  id: z.string(),
  reason: z.string().optional(),
});

function normalizeRequestCancelReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return (normalized || "Request cancelled").slice(0, MAX_REQUEST_CANCEL_REASON_LENGTH);
}


function shellStatusFromResult(status: string): ShellSessionStatus {
  if (status === "completed" || status === "failed") {
    return status;
  }
  return "running";
}


function shellStatusFromEvent(event: string): ShellSessionStatus {
  if (event === "finished") {
    return "completed";
  }
  if (event === "failed" || event === "timed_out") {
    return "failed";
  }
  return "running";
}



export class Transport {
  constructor(readonly host: Kernel) {}

readonly frameBodyChannels = new Map<string, BinaryBodyChannel>();

readonly routedBodies = new Map<
    string,
    CancellableFrameBody
  >();

readonly activeRequests = new Map<
    string,
    { origin: RouteOrigin; controller: AbortController }
  >();

readonly cancelledProcessRequests = new Map<
    string,
    { expiresAt: number; reason: string }
  >();

readonly pendingKernelResponses = new Map<string, (frame: ResponseFrame) => void>();

async onMessage(
    connection: KernelConnection<ConnectionState>,
    message: KernelWebSocketMessage,
  ): Promise<void> {
    if (message instanceof ArrayBuffer) {
      this.handleBinaryMessage(connection, message);
      return;
    }

    let parsed: WireFrame;
    try {
      parsed = decodeWireFrameJson(message);
    } catch (error) {
      this.sendError(
        connection,
        error instanceof InvalidWireFrameError ? error.frameId : "?",
        400,
        error instanceof Error ? error.message : "Invalid frame",
      );
      return;
    }

    switch (parsed.type) {
      case "req":
        await this.handleReq(connection, parsed);
        break;
      case "res":
        this.handleRes(connection, parsed);
        break;
      case "sig":
        if (parsed.signal === REQUEST_CANCEL_SIGNAL) {
          this.handleRequestCancel(connection, parsed);
        } else {
          this.handleSig(connection, parsed);
        }
        break;
    }
  }

handleRequestCancel(
    connection: KernelConnection<ConnectionState>,
    frame: SignalFrame,
  ): void {
    if (connection.state?.step !== "connected") {
      return;
    }
    const parsed = requestCancelPayloadSchema.safeParse(frame.payload);
    if (!parsed.success) return;
    const { id: requestId, reason } = parsed.data;
    this.cancelRequest(
      { type: "connection", id: connection.id },
      requestId,
      reason,
      false,
    );
  }

async handleReq(
    connection: KernelConnection<ConnectionState>,
    wireFrame: WireRequestFrame,
  ): Promise<void> {
    let frame: RequestFrame;
    try {
      frame = this.decodeWebSocketRequestFrame(connection, wireFrame);
    } catch (error) {
      this.sendError(
        connection,
        wireFrame.id,
        400,
        error instanceof Error ? error.message : "Invalid frame body",
      );
      return;
    }

    try {
      const state = connection.state;

      if (
        frame.call !== "sys.setup"
        && frame.call !== "sys.setup.assist"
      ) {
        const gate = await this.host.onboarding.managedWorkGate();
        if (!gate.allowed) {
          this.sendError(connection, frame.id, gate.code, gate.message);
          return;
        }
      }

      if (frame.call === "sys.connect") {
        if (state && state.step !== "pending") {
          this.sendError(
            connection,
            frame.id,
            409,
            state.step === "superseded" ? "Connection replaced" : "Already connected",
          );
          return;
        }
        await this.host.connectionRuntime.handleSysConnect(connection, frame);
        return;
      }

      if (frame.call === "sys.setup.assist") {
        await this.host.onboarding.handleSysSetupAssist(connection, frame);
        return;
      }

      if (frame.call === "sys.setup") {
        await this.host.onboarding.handleSysSetup(connection, frame);
        return;
      }

      if (!state || state.step !== "connected" || !state.peer) {
        if (this.host.auth.isSetupMode()) {
          if (this.host.onboarding.managedOnboardingService()) {
            this.sendError(
              connection,
              frame.id,
              503,
              "Managed installation provisioning is incomplete",
            );
            return;
          }
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

      const response = await this.host.dispatchPeerRequest(
        frame,
        { type: "connection", id: connection.id },
        this.host.buildContext(connection),
        { awaitRouted: false },
      );
      if (response) this.sendWebSocketFrame(connection, response);
      // Routed responses arrive asynchronously through handleRes.
    } finally {
      await cancelUnlockedBody(frame.body, "WebSocket request completed");
    }
  }

handleRes(
    connection: KernelConnection<ConnectionState>,
    wireEnvelope: WireResponseEnvelope,
  ): void {
    const route = this.host.routes.get(wireEnvelope.id);
    if (!route) {
      if (wireEnvelope.ok) {
        const descriptor = wireEnvelope.body;
        if (descriptor) {
          try {
            void this.receiveFrameBody(connection, descriptor).stream.cancel("Request is no longer pending");
          } catch {
            // The response is already stale; malformed descriptors have no consumer to fail.
          }
        }
      }
      return;
    }

    if (
      !this.isConnectionForTarget(connection, route.targetId) ||
      (route.peerConnectionId !== null && route.peerConnectionId !== connection.id)
    ) {
      return;
    }

    let frame: ResponseFrame;
    try {
      const wireFrame = decodeWireResponse(route.call, wireEnvelope);
      frame = this.decodeWebSocketResponseFrame(connection, wireFrame);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid frame body";
      this.cancelRoute(wireEnvelope.id);
      this.deliverToOrigin(
        route.origin,
        errFrame(
          wireEnvelope.id,
          502,
          `Invalid response from device ${route.targetId}: ${message}`,
        ),
      );
      this.sendError(
        connection,
        wireEnvelope.id,
        400,
        message,
      );
      return;
    }

    this.host.routes.remove(frame.id);
    this.cancelRoutedBody(frame.id, "Device response received");

    if (route.scheduleId) {
      this.host.cancelSchedule(route.scheduleId).catch(() => {});
    }

    if (route.call === "shell.exec") {
      // SAFETY: decodeWireResponse validated frame against route.call above.
      this.recordShellSessionFromResponse(
        route.targetId,
        frame as ResponseFrame<"shell.exec">,
      );
    }

    this.deliverToOrigin(route.origin, frame);
  }

handleBinaryMessage(
    connection: KernelConnection<ConnectionState>,
    message: ArrayBuffer,
  ): void {
    this.frameBodyChannel(connection).handleFrame(message);
  }

handleSig(
    connection: KernelConnection<ConnectionState>,
    frame: SignalFrame,
  ): void {
    const state = connection.state;
    const targetId = state?.peer && peerProvidesOperations(state.peer)
      ? state.peer.id
      : null;
    if (!targetId || !this.isConnectionForTarget(connection, targetId)) {
      return;
    }

    if (frame.signal === "peer.ping") {
      const pong: SignalFrame = {
        type: "sig",
        signal: "peer.pong",
      };
      if (frame.payload !== undefined) pong.payload = frame.payload;
      if (frame.seq !== undefined) pong.seq = frame.seq;
      this.sendWebSocketFrame(connection, pong);
      return;
    }

    if (frame.signal !== "exec.status") {
      return;
    }

    const parsed = execStatusPayloadSchema.safeParse(frame.payload);
    if (!parsed.success) {
      return;
    }
    const payload = parsed.data;

    const status = shellStatusFromEvent(payload.event);
    this.host.shellSessions.rememberDeviceSession(payload.sessionId, targetId, status, {
      exitCode: payload.exitCode ?? null,
      error: payload.signal ?? null,
    });
  }

recordShellSessionFromResponse(
    targetId: string,
    frame: ResponseFrame<"shell.exec">,
  ): void {
    if (!frame.ok) {
      return;
    }

    const data: ShellExecResult | undefined = frame.data;
    if (!data) return;
    const sessionId = data.sessionId?.trim() ?? "";
    if (!sessionId) {
      return;
    }

    const status = shellStatusFromResult(data.status);
    this.host.shellSessions.rememberDeviceSession(sessionId, targetId, status, {
      exitCode: data.status === "running" ? null : data.exitCode ?? null,
      error: data.status === "failed" ? data.error : null,
    });
  }

decodeWebSocketRequestFrame(
    connection: KernelConnection<ConnectionState>,
    frame: WireRequestFrame,
  ): RequestFrame {
    const { body, ...request } = frame;
    return body === undefined
      ? request
      : { ...request, body: this.receiveFrameBody(connection, body) };
  }

decodeWebSocketResponseFrame(
    connection: KernelConnection<ConnectionState>,
    frame: WireResponseFrame,
  ): ResponseFrame {
    if (!frame.ok) return frame;
    const { body, ...response } = frame;
    return body === undefined
      ? response
      : { ...response, body: this.receiveFrameBody(connection, body) };
  }

receiveFrameBody(
    connection: KernelConnection<ConnectionState>,
    descriptor: BinaryFrameDescriptor,
  ): FrameBody {
    return this.frameBodyChannel(connection).receive(descriptor);
  }

sendWebSocketFrame(
    connection: KernelConnection<ConnectionState>,
    frame: Frame,
  ): OutgoingBinaryBody | null {
    const body = frame.type === "sig" || (frame.type === "res" && !frame.ok)
      ? undefined
      : frame.body;
    if (!body) {
      connection.send(JSON.stringify(frame));
      return null;
    }

    const outgoing: OutgoingBinaryBody = this.frameBodyChannel(connection).prepare(body);
    try {
      connection.send(JSON.stringify({
        ...frame,
        body: outgoing.descriptor,
      }));
    } catch (error) {
      void outgoing.cancel(error);
      throw error;
    }
    this.host.ctx.waitUntil(outgoing.send().catch(() => {}));
    return outgoing;
  }

frameBodyChannel(connection: KernelConnection<ConnectionState>): BinaryBodyChannel {
    let channel = this.frameBodyChannels.get(connection.id);
    if (!channel) {
      channel = new BinaryBodyChannel({
        role: "acceptor",
        sendFrame: (binary) => connection.send(binary),
      });
      this.frameBodyChannels.set(connection.id, channel);
    }
    return channel;
  }

closeFrameBodyChannel(connectionId: string): void {
    this.frameBodyChannels.get(connectionId)?.close(new Error("Connection closed"));
    this.frameBodyChannels.delete(connectionId);
  }

async requestTarget(
    targetId: string,
    call: "net.fetch",
    args: NetFetchArgs,
    options: TargetRequestOptions = {},
  ): Promise<ResponseOkFrame<"net.fetch">> {
    const id = options.id ?? crypto.randomUUID();
    let cleanupPending: (() => void) | null = null;
    let route: { cancel: () => void } | null = null;
    let outgoing: OutgoingBinaryBody | null = null;
    let onAbort: (() => void) | null = null;
    let requestSent = false;
    let completionReason: FrameCancellationReason = "Device request completed";

    try {
      if (options.signal?.aborted) {
        throw requestAbortError(options.signal.reason);
      }
      const device = this.host.targets.get(targetId);
      if (!device || !device.online) {
        throw new Error(`Device offline: ${targetId}`);
      }
      if (!this.host.targets.canHandle(targetId, call)) {
        throw new Error(`Device ${targetId} does not implement ${call}`);
      }

      const deviceConn = this.findTargetConnection(targetId);
      if (!deviceConn) {
        throw new Error(`No active connection for device: ${targetId}`);
      }

      const pending = this.createPendingKernelResponse(id);
      cleanupPending = pending.cleanup;
      route = await this.registerRouteWithExpiry({
        id,
        call,
        origin: { type: "kernel", id },
        targetId,
        peerConnectionId: deviceConn.id,
        ttlMs: options.ttlMs ?? 60_000,
      });
      if (options.signal?.aborted) {
        throw requestAbortError(options.signal.reason);
      }

      // SAFETY: dispatch supplies args from the syscall schema associated with call.
      const requestFrame = {
        type: "req",
        id,
        call,
        args,
      } as RequestFrame;
      if (options.body) requestFrame.body = options.body;
      outgoing = this.sendWebSocketFrame(deviceConn, requestFrame);
      requestSent = true;
      const frame = options.signal
        ? await Promise.race([
            pending.promise,
            new Promise<never>((_, reject) => {
              onAbort = () => {
                if (requestSent) {
                  this.sendTargetRequestCancel(
                    targetId,
                    deviceConn.id,
                    id,
                    normalizeRequestCancelReason(requestAbortError(options.signal?.reason).message),
                  );
                }
                reject(requestAbortError(options.signal?.reason));
              };
              options.signal?.addEventListener("abort", onAbort, { once: true });
              if (options.signal?.aborted) {
                onAbort();
              }
            }),
          ])
        : await pending.promise;
      if (!frame.ok) {
        throw new Error(frame.error.message);
      }
      // SAFETY: the pending route was registered for the net.fetch request above.
      return frame as ResponseOkFrame<"net.fetch">;
    } catch (error) {
      completionReason = error instanceof Error ? error : String(error);
      throw error;
    } finally {
      if (onAbort) {
        options.signal?.removeEventListener("abort", onAbort);
      }
      cleanupPending?.();
      route?.cancel();
      const reason = options.signal?.aborted ? options.signal.reason : completionReason;
      if (outgoing) {
        await outgoing.cancel(reason);
      } else {
        await options.body?.stream.cancel(reason).catch(() => {});
      }
    }
  }

findTargetConnection(targetId: string): KernelConnection<ConnectionState> | null {
    for (const [, conn] of this.host.connections) {
      if (this.isConnectionForTarget(conn, targetId)) {
        return conn;
      }
    }
    return null;
  }

isConnectionForTarget(
    connection: KernelConnection<ConnectionState>,
    targetId: string,
  ): boolean {
    const state = connection.state;
    return state?.step === "connected" &&
      state.peer?.id === targetId &&
      peerProvidesOperations(state.peer);
  }

async registerRouteWithExpiry(route: {
    id: string;
    call: SyscallName;
    origin: RouteOrigin;
    targetId: string;
    peerConnectionId: string;
    ttlMs: number;
  }): Promise<{
    cancel: () => void;
    attachBody: (body: CancellableFrameBody) => void;
  }> {
    const scheduleId = (await this.host.schedule(
      route.ttlMs / 1000,
      "onRouteExpired",
      route.id,
    )).id;

    try {
      this.host.routes.register(
        route.id,
        route.call,
        route.origin,
        route.targetId,
        route.peerConnectionId,
        { ttlMs: route.ttlMs, scheduleId },
      );
    } catch (error) {
      this.host.cancelSchedule(scheduleId).catch(() => {});
      throw error;
    }

    return {
      cancel: () => this.cancelRoute(route.id),
      attachBody: (body) => {
        const previous = this.routedBodies.get(route.id);
        this.routedBodies.set(route.id, body);
        void previous?.cancel("Routed body replaced");
      },
    };
  }

registerActiveRequest(origin: RouteOrigin, requestId: string): AbortController {
    if (!requestId || this.activeRequests.has(requestId) || this.host.routes.get(requestId)) {
      throw new Error(`Duplicate request: ${requestId}`);
    }
    if (origin.type === "process") {
      const key = `${origin.id}\0${requestId}`;
      const cancellation = this.cancelledProcessRequests.get(key);
      this.cancelledProcessRequests.delete(key);
      if (cancellation && cancellation.expiresAt > Date.now()) {
        throw new RequestCancelledError(cancellation.reason);
      }
    }
    const controller = new AbortController();
    this.activeRequests.set(requestId, { origin, controller });
    return controller;
  }

bindRequestBodyCancellation(
    frame: RequestFrame,
    signal: AbortSignal,
  ): RequestFrame {
    if (!frame.body) {
      return frame;
    }
    const body = frame.body;
    frame.body = {
      ...body,
      stream: bindByteStreamToAbort(body.stream, signal),
    };
    return frame;
  }

finishActiveRequest(requestId: string, controller: AbortController): void {
    if (this.activeRequests.get(requestId)?.controller === controller) {
      this.activeRequests.delete(requestId);
    }
  }

cancelRequest(
    origin: RouteOrigin,
    requestId: string,
    reason: string | undefined,
    rememberMissing: boolean,
  ): boolean {
    if (!requestId) {
      return false;
    }
    const active = this.activeRequests.get(requestId);
    const ownsActive = active !== undefined && sameRouteOrigin(active.origin, origin);
    if (active && !ownsActive) {
      return false;
    }

    const route = this.host.routes.get(requestId);
    const internalKernelRoute = route !== null
      && ownsActive
      && route.origin.type === "kernel"
      && route.origin.id === requestId;
    const ownsRoute = route !== null && (
      sameRouteOrigin(route.origin, origin)
      || internalKernelRoute
    );
    if (route && !ownsRoute) {
      return false;
    }

    const message = normalizeRequestCancelReason(reason);
    if (ownsActive) {
      active.controller.abort(new Error(message));
    }
    if (route && ownsRoute) {
      this.sendTargetRequestCancel(
        route.targetId,
        route.peerConnectionId,
        requestId,
        message,
      );
      this.cancelRoute(requestId);
    }
    if (ownsActive || ownsRoute) {
      return true;
    }
    if (!rememberMissing || origin.type !== "process") {
      return false;
    }

    const now = Date.now();
    for (const [key, cancellation] of this.cancelledProcessRequests) {
      if (cancellation.expiresAt <= now) {
        this.cancelledProcessRequests.delete(key);
      }
    }
    if (this.cancelledProcessRequests.size >= MAX_PROCESS_REQUEST_CANCELLATIONS) {
      const oldest = this.cancelledProcessRequests.keys().next().value;
      if (oldest) {
        this.cancelledProcessRequests.delete(oldest);
      }
    }
    this.cancelledProcessRequests.set(`${origin.id}\0${requestId}`, {
      expiresAt: now + PROCESS_REQUEST_CANCEL_TTL_MS,
      reason: message,
    });
    return true;
  }

sendTargetRequestCancel(
    targetId: string,
    peerConnectionId: string | null,
    requestId: string,
    reason: string,
  ): void {
    const connection = peerConnectionId
      ? this.host.connections.get(peerConnectionId)
      : this.findTargetConnection(targetId);
    if (!connection || !this.isConnectionForTarget(connection, targetId)) {
      return;
    }
    try {
      this.sendWebSocketFrame(connection, {
        type: "sig",
        signal: REQUEST_CANCEL_SIGNAL,
        payload: { id: requestId, reason },
      });
    } catch {}
  }

cancelRoute(routeId: string): void {
    const route = this.host.routes.remove(routeId);
    if (route?.scheduleId) {
      this.host.cancelSchedule(route.scheduleId).catch(() => {});
    }
    this.cancelRoutedBody(routeId, "Route cancelled");
  }

cancelRoutedBody(routeId: string, reason: string): void {
    const body = this.routedBodies.get(routeId);
    if (!body) {
      return;
    }
    this.routedBodies.delete(routeId);
    void body.cancel(reason);
  }

/**
   * Schedule callback — fired when a routing table entry expires.
   */
  async onRouteExpired(routeId: string): Promise<void> {
    const expired = this.host.routes.remove(routeId);
    if (!expired) return;
    this.sendTargetRequestCancel(
      expired.targetId,
      expired.peerConnectionId,
      routeId,
      "Request timed out",
    );
    this.cancelRoutedBody(routeId, "Route expired");

    const timeoutFrame: ResponseFrame = {
      type: "res",
      id: routeId,
      ok: false,
      error: { code: 504, message: `Syscall ${expired.call} timed out (device: ${expired.targetId})` },
    };

    this.deliverToOrigin(expired.origin, timeoutFrame);
  }

deliverToOrigin(origin: RouteOrigin, frame: ResponseFrame): void {
    const body = frame.ok ? frame.body : undefined;
    if (origin.type === "connection") {
      const conn = this.host.connections.get(origin.id);
      if (conn) {
        this.sendWebSocketFrame(conn, frame);
      } else {
        void body?.stream.cancel("Origin disconnected").catch(() => {});
      }
      return;
    }

    if (origin.type === "process") {
      sendFrameToProcess(this.host.installationId, origin.id, frame).catch((err) => {
        void body?.stream.cancel(err).catch(() => {});
        console.error(`[Kernel] Failed to deliver frame to process ${origin.id}:`, err);
      });
      return;
    }

    const resolve = this.pendingKernelResponses.get(origin.id);
    if (resolve) {
      this.pendingKernelResponses.delete(origin.id);
      resolve(frame);
    } else {
      void body?.stream.cancel("Request was cancelled").catch(() => {});
    }
  }

createPendingKernelResponse(id: string): PendingKernelResponse {
    let settled = false;
    const promise = new Promise<ResponseFrame>((resolve) => {
      this.pendingKernelResponses.set(id, (frame) => {
        settled = true;
        resolve(frame);
      });
    });

    return {
      promise,
      cleanup: () => {
        if (!settled) {
          this.pendingKernelResponses.delete(id);
        }
      },
    };
  }

failRoutesForTarget(targetId: string): void {
    this.host.shellSessions.failForDevice(targetId, "Device disconnected");
    this.failTargetRoutes(this.host.routes.failForDevice(targetId));
  }

failRoutesForPeerConnection(connectionId: string): void {
    this.failTargetRoutes(this.host.routes.failForDriverConnection(connectionId));
  }

failTargetRoutes(failed: FailedTargetRoute[]): void {
    for (const entry of failed) {
      this.cancelRoutedBody(entry.id, "Device disconnected");
      if (entry.scheduleId) {
        this.host.cancelSchedule(entry.scheduleId).catch(() => {});
      }

      const errorFrame: ResponseFrame = {
        type: "res",
        id: entry.id,
        ok: false,
        error: { code: 503, message: `Device disconnected: ${entry.targetId}` },
      };
      this.deliverToOrigin(entry.origin, errorFrame);
    }
  }

failRoutesForConnection(connectionId: string): void {
    const failed = this.host.routes.failForConnection(connectionId);
    for (const entry of failed) {
      this.sendTargetRequestCancel(
        entry.targetId,
        entry.peerConnectionId,
        entry.id,
        "Origin disconnected",
      );
      this.cancelRoutedBody(entry.id, "Origin disconnected");
      if (entry.scheduleId) {
        this.host.cancelSchedule(entry.scheduleId).catch(() => {});
      }
    }
  }

sendOk(
    connection: KernelConnection<ConnectionState>,
    id: string,
    data?: JsonValue,
  ): void {
    connection.send(JSON.stringify({ type: "res", id, ok: true, data }));
  }

sendError(
    connection: KernelConnection<ConnectionState>,
    id: string,
    code: number,
    message: string,
    details?: JsonValue,
  ): void {
    const error: FrameError = {
      code,
      message,
    };
    if (details !== undefined) error.details = details;
    connection.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error,
      }),
    );
  }
}
