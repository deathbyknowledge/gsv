import type {
  RequestFrame,
  SignalFrame,
} from "../protocol/frames";
import type {
  ConnectedPeer,
  JsonValue,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  type RouteOrigin,
} from "./routing";
import {
  handleConnect,
} from "./connect";
import {
  peerProvidesOperations,
} from "./peer";
import {
  getConversationById,
  sendFrameToProcess,
} from "../shared/utils";
import {
  ensurePersonalController,
} from "./personal-controller";
import {
  recordMachineAddedResponsibility,
} from "./lifecycle-responsibilities";
import {
  KernelConnection,
  type KernelConnectionState as ConnectionState,
  restoreKernelWebSocket,
} from "./connection";
import type { Kernel } from "./do";
import {
  sameRouteOrigin,
} from "./do-shared";


export class ConnectionRuntime {
  constructor(readonly host: Kernel) {}

onConnect(connection: KernelConnection<ConnectionState>): void {
    const state: ConnectionState = { step: "pending" };
    connection.setState(state);
    this.host.connections.set(connection.id, connection);
  }

onClose(connection: KernelConnection<ConnectionState>): void {
    this.host.transport.closeFrameBodyChannel(connection.id);
    const state = connection.state;

    this.host.connections.delete(connection.id);
    const origin: RouteOrigin = { type: "connection", id: connection.id };
    for (const [requestId, request] of this.host.transport.activeRequests) {
      if (sameRouteOrigin(request.origin, origin)) {
        this.host.transport.cancelRequest(origin, requestId, "Origin disconnected", false);
      }
    }

    const peer = state.peer;

    if (peer && peerProvidesOperations(peer)) {
      if (state.step === "connected" && !this.host.transport.findDeviceConnection(peer.id)) {
        this.host.devices.setOnline(peer.id, false);
        this.broadcastDeviceStatus(peer.id, "disconnected");
        this.host.transport.failRoutesForDevice(peer.id);
      } else {
        this.host.transport.failRoutesForDriverConnection(connection.id);
      }
    }

    this.host.transport.failRoutesForConnection(connection.id);
    this.host.runRoutes.clearForConnection(connection.id);
  }

/** Rebuild the in-memory connection index from hibernating WebSockets. */
  rehydrateConnections(): void {
    const onlineTargets = new Set<string>();
    for (const socket of this.host.ctx.getWebSockets()) {
      const connection = restoreKernelWebSocket(socket);
      if (!connection) {
        socket.close(1011, "Connection state unavailable");
        continue;
      }
      const state = connection.state;
      this.host.connections.set(connection.id, connection);
      if (!state || state.step !== "connected" || !state.peer) continue;
      if (peerProvidesOperations(state.peer)) {
        onlineTargets.add(state.peer.id);
        this.host.devices.setOnline(state.peer.id, true);
      }
    }

    // Reconcile registered device online flags with live rehydrated sockets.
    for (const device of this.host.devices.listOnline()) {
      if (!onlineTargets.has(device.device_id)) {
        this.host.devices.setOnline(device.device_id, false);
        this.broadcastDeviceStatus(device.device_id, "disconnected");
      }
    }
  }

connectionForSocket(socket: WebSocket): KernelConnection<ConnectionState> | null {
    for (const connection of this.host.connections.values()) {
      if (connection.socket === socket) return connection;
    }
    return null;
  }

activateConnection(
    connection: KernelConnection<ConnectionState>,
    state: ConnectionState & { step: "connected"; peer: ConnectedPeer },
  ): void {
    connection.setState(state);
    this.host.connections.set(connection.id, connection);

    if (!state.clientId) {
      return;
    }
    for (const [connectionId, existing] of this.host.connections) {
      const existingState = existing.state;
      if (
        existing !== connection &&
        existingState?.step === "connected" &&
        existingState.peer?.principal.account.uid === state.peer.principal.account.uid &&
        existingState.peer.principal.kind === state.peer.principal.kind &&
        existingState.clientId === state.clientId
      ) {
        existing.setState({ ...existingState, step: "superseded" });
        this.host.connections.delete(connectionId);
        existing.close(1000, "Replaced by newer connection");
      }
    }
  }

async handleSysConnect(
    connection: KernelConnection<ConnectionState>,
    frame: RequestFrame<"sys.connect">,
  ): Promise<void> {
    const ctx = this.host.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.host.transport.sendError(connection, frame.id, outcome.code, outcome.message, outcome.details);
      return;
    }

    if (outcome.newMachine) {
      await recordMachineAddedResponsibility(outcome.newMachine, ctx);
      emitTelemetry(this.host.bindings, {
        installationId: this.host.installationId,
        component: "gateway",
        event: {
          stream: "product",
          name: "target.connected",
          properties: {
            targetKind: outcome.newMachine.platform.toLowerCase().includes("browser")
              ? "browser"
              : "machine",
          },
        },
      });
    }

    const clientId = frame.args.peer.id.trim();
    const clientPlatform = frame.args.peer.platform.trim();
    const newState = {
      step: "connected",
      peer: outcome.peer,
      clientId: clientId || undefined,
      clientPlatform: clientPlatform || undefined,
      credentialMethod: frame.args.auth?.token ? "token" : "password",
    } satisfies ConnectionState & { step: "connected" };

    if (
      outcome.peer.principal.kind === "human"
      && outcome.peer.principal.account.uid >= 1000
      && !ctx.auth.isPersonalAgentUid(outcome.peer.principal.account.uid)
    ) {
      const ownerUid = outcome.peer.principal.account.uid;
      const pid = await ensurePersonalController(ownerUid, ctx);
      const conversation = ctx.conversations.ensureShip(ownerUid, pid);
      await getConversationById(this.host.installationId, conversation.id).initialize({
        ownerUid,
        kind: "ship",
      });
    }

    this.activateConnection(connection, newState);

    if (peerProvidesOperations(outcome.peer)) {
      this.broadcastDeviceStatus(outcome.peer.id, "connected");
    }

    if (outcome.peer.principal.kind === "human") {
      this.reconcileOwnedIdentities(outcome.peer.principal.account.uid);
    }

    this.host.transport.sendOk(connection, frame.id, outcome.result);
  }

/**
   * Reconcile the run-as identity of every process owned by `ownerUid` against
   * the auth store. Each process keeps its run-as account (preserving the
   * personal-agent split); only group/home/gid drift for that account is
   * refreshed, and identity.changed is emitted when it changes.
   */
  reconcileOwnedIdentities(ownerUid: number): void {
    for (const proc of this.host.procs.list(ownerUid)) {
      const entry = this.host.auth.getPasswdByUsername(proc.username);
      if (!entry) continue;

      const fresh: ProcessIdentity = {
        uid: entry.uid,
        gid: entry.gid,
        gids: this.host.auth.resolveGids(entry.username, entry.gid),
        username: entry.username,
        home: entry.home,
        cwd: proc.cwd,
      };

      if (
        proc.gid === fresh.gid &&
        proc.home === fresh.home &&
        proc.username === fresh.username &&
        JSON.stringify(proc.gids) === JSON.stringify(fresh.gids)
      ) {
        continue;
      }

      this.host.procs.updateIdentity(proc.processId, fresh);

      sendFrameToProcess(this.host.installationId, proc.processId, {
        type: "sig",
        signal: "identity.changed",
        payload: { identity: fresh },
      }).catch((err) => {
        console.error(`[Kernel] Failed to send identity.changed to ${proc.processId}:`, err);
      });
    }
  }

disconnectDeviceConnections(deviceId: string, reason: string): void {
    let closed = false;
    for (const [connId, conn] of Array.from(this.host.connections)) {
      if (!this.host.transport.isConnectionForDevice(conn, deviceId)) {
        continue;
      }

      closed = true;
      conn.close(1000, reason);
      this.host.connections.delete(connId);
      this.host.runRoutes.clearForConnection(connId);
    }

    if (closed) {
      this.host.transport.failRoutesForDevice(deviceId);
    }
  }

/**
   * Broadcast a signal to active user WebSockets belonging to a UID.
   */
  broadcastToUserUid(uid: number, signal: string, payload?: JsonValue): void {
    const frame: SignalFrame = {
      type: "sig",
      signal,
      payload,
    };
    const json = JSON.stringify(frame);

    for (const [, conn] of this.host.connections) {
      const state = conn.state;
      const peer = state?.peer;
      if (!peer || peer.principal.kind !== "human") continue;
      if (!peer.grant.signals.includes(signal)) continue;
      if (peer.principal.account.uid === uid) {
        conn.send(json);
      }
    }
  }

broadcastToUserUidExcept(
    uid: number,
    excludedConnectionId: string,
    signal: string,
    payload?: JsonValue,
  ): void {
    const json = JSON.stringify({ type: "sig", signal, payload } satisfies SignalFrame);
    for (const [connectionId, connection] of this.host.connections) {
      if (connectionId === excludedConnectionId) continue;
      const state = connection.state;
      const peer = state?.peer;
      if (
        peer?.principal.kind === "human"
        && peer.principal.account.uid === uid
        && peer.grant.signals.includes(signal)
      ) {
        connection.send(json);
      }
    }
  }

sendSignalToConnection(
    connectionId: string,
    signal: string,
    payload?: JsonValue,
  ): void {
    const connection = this.host.connections.get(connectionId);
    if (!connection?.state.peer?.grant.signals.includes(signal)) return;
    connection.send(JSON.stringify({ type: "sig", signal, payload } satisfies SignalFrame));
  }

broadcastDeviceStatus(
    deviceId: string,
    event: "connected" | "disconnected",
  ): void {
    const device = this.host.devices.get(deviceId);
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
          label: device.label,
          description: device.description,
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

    for (const [, conn] of this.host.connections) {
      const state = conn.state;
      const peer = state?.peer;
      if (!peer?.grant.signals.includes("device.status")) continue;
      if (peer.principal.kind === "service") continue;

      if (peer.principal.kind === "human") {
        const proc = peer.principal.account;
        if (!this.host.devices.canAccess(deviceId, proc.uid, [...proc.gids])) {
          continue;
        }
      } else if (peer.principal.kind === "machine") {
        if (peer.id !== deviceId) {
          continue;
        }
      }

      conn.send(json);
    }
  }
}
