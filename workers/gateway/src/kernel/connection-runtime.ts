import type {
  RequestFrame,
  SignalFrame,
} from "../protocol/frames";
import type {
  ConnectedPeer,
  JsonValue,
  ProcessIdentity,
  ProcHistoryEventPayload,
  SysLedgerChangedSignal,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  type RouteOrigin,
} from "./routing";
import {
  handleConnect,
  PROTOCOL_VERSION,
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
import { deliverTargetConnectionEvent } from "./target-events";
import { hasCapability } from "./capabilities";
import {
  sameRouteOrigin,
} from "./do-shared";


export class ConnectionRuntime {
  constructor(readonly host: Kernel) {}

  private readonly pendingTargetEvents = new Map<string, Promise<void>>();

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
      if (state.step === "connected" && !this.host.transport.findTargetConnection(peer.id)) {
        this.host.targets.setOnline(peer.id, false);
        this.broadcastTargetStatus(peer.id, "disconnected");
        this.host.transport.failRoutesForTarget(peer.id);
      } else {
        this.host.transport.failRoutesForPeerConnection(connection.id);
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
      // A socket that negotiated another protocol before a deploy must not
      // resume as if it spoke this one; closing it sends the client back
      // through sys.connect, where it receives the structured upgrade error.
      if (state?.step === "connected" && state.protocol !== PROTOCOL_VERSION) {
        socket.close(1008, `Protocol ${PROTOCOL_VERSION} required; reconnect with an updated client`);
        continue;
      }
      this.host.connections.set(connection.id, connection);
      if (!state || state.step !== "connected" || !state.peer) continue;
      if (peerProvidesOperations(state.peer)) {
        onlineTargets.add(state.peer.id);
        this.host.targets.setOnline(state.peer.id, true);
      }
    }

    // Reconcile registered device online flags with live rehydrated sockets.
    for (const device of this.host.targets.listOnline()) {
      if (!onlineTargets.has(device.target_id)) {
        this.host.targets.setOnline(device.target_id, false);
        this.broadcastTargetStatus(device.target_id, "disconnected");
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
      protocol: PROTOCOL_VERSION,
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
      this.broadcastTargetStatus(outcome.peer.id, "connected");
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

disconnectTargetConnections(targetId: string, reason: string): void {
    let closed = false;
    for (const [connId, conn] of Array.from(this.host.connections)) {
      if (!this.host.transport.isConnectionForTarget(conn, targetId)) {
        continue;
      }

      closed = true;
      conn.close(1000, reason);
      this.host.connections.delete(connId);
      this.host.runRoutes.clearForConnection(connId);
    }

    if (closed) {
      this.host.transport.failRoutesForTarget(targetId);
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
    const contactRead = signal === "contact.changed" ? "contact.list"
      : signal === "contact.invite.changed" ? "contact.invite.list"
      : signal === "contact.request.changed" ? "contact.request.list"
      : signal === "r12y.changed" ? "r12y.list"
      : signal === "r12y.source.changed" ? "r12y.source.list"
      : signal === "sched.changed" ? "sched.list" : null;
    const guardedFeed = contactRead !== null || signal === "proc.changed" || signal === "process.exit";

    for (const [, conn] of this.host.connections) {
      const state = conn.state;
      const peer = state?.peer;
      if (!peer || peer.principal.kind !== "human") continue;
      if (!peer.grant.signals.includes(signal)) continue;
      if (guardedFeed && state.step !== "connected") continue;
      // Contact notifications reveal private activity even without a payload.
      if (contactRead && !hasCapability(peer.grant.calls, contactRead)) continue;
      if (peer.principal.account.uid === uid) {
        if (!guardedFeed) conn.send(json);
        else {
          try {
            conn.send(json);
          } catch {
            conn.close(1011, contactRead ? "Contact feed interrupted" : "Process feed interrupted");
          }
        }
      }
    }
  }

  /** Ledger rows contain private arguments; the signal grant alone never grants read access. */
  broadcastLedgerChanges(ownerUid: number, payload: SysLedgerChangedSignal): void {
    let json: string | undefined;
    for (const [, conn] of this.host.connections) {
      const peer = conn.state.peer;
      if (conn.state.step !== "connected" || !peer || peer.principal.kind !== "human") continue;
      if (peer.principal.account.uid !== ownerUid && peer.principal.account.uid !== 0) continue;
      if (!peer.grant.signals.includes("ledger.changed") || !hasCapability(peer.grant.calls, "sys.ledger.list")) continue;
      json ??= JSON.stringify({ type: "sig", signal: "ledger.changed", payload } satisfies SignalFrame);
      try {
        conn.send(json);
      } catch {
        // Reconnection reloads the authoritative snapshot if this connection cannot accept a patch.
        conn.close(1011, "Ledger feed interrupted");
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

broadcastTargetStatus(
    targetId: string,
    event: "connected" | "disconnected",
  ): void {
    const device = this.host.targets.get(targetId);
    if (!device) {
      return;
    }

    const payload: ProcHistoryEventPayload<"target.connection"> = {
      targetId: device.target_id, event, platform: device.platform,
      version: device.version, observedAt: Date.now(),
    };
    if (device.label) payload.label = device.label;
    const transitionId = `target.connection:${crypto.randomUUID()}`;
    const watches = this.host.signalWatches.matchTarget(targetId, "target.status");
    const previous = this.pendingTargetEvents.get(targetId) ?? Promise.resolve();
    const delivery = previous.then(() => deliverTargetConnectionEvent(this.host, payload, transitionId, watches))
      .catch((error) => {
        console.warn(`[Kernel] Target event delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.pendingTargetEvents.get(targetId) === delivery) this.pendingTargetEvents.delete(targetId);
      });
    this.pendingTargetEvents.set(targetId, delivery);
    this.host.ctx.waitUntil(delivery);

    const frame: SignalFrame = {
      type: "sig",
      signal: "target.status",
      payload: {
        event,
        target: {
          targetId: device.target_id,
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
      if (!peer?.grant.signals.includes("target.status")) continue;
      if (peer.principal.kind === "service") continue;

      if (peer.principal.kind === "human") {
        const proc = peer.principal.account;
        if (!this.host.targets.canAccess(targetId, proc.uid, [...proc.gids])) {
          continue;
        }
      } else if (peer.principal.kind === "machine") {
        if (peer.id !== targetId) {
          continue;
        }
      }

      conn.send(json);
    }
  }
}
