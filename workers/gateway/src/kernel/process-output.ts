import type {
  SignalFrame,
} from "../protocol/frames";
import type {
  JsonValue,
  ConversationMessage,
  ConversationMessageOrigin,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  type ProcessRuntimePatch,
  type ProcessState,
} from "./processes";
import {
  RunRouteStore,
} from "./run-routes";
import {
  type SignalWatchRecord,
} from "./signal-watches";
import {
  getConversationById,
  sendFrameToProcess,
} from "../shared/utils";
import type {
  ConversationAppendRequest,
} from "../conversation/do";
import {
  stableOpaqueId,
} from "../shared/stable-id";
import {
  setAdapterActivityForKernel,
} from "./adapter-service";
import type {
  ProcessMessageCommitArgs,
  ProcessMessageStreamSignal,
} from "../protocol/process-frames";
import type {
  UserProcessSignalFrame,
} from "./do-shared";
import type { Kernel } from "./do";
import {
  adapterTypingActivity,
} from "./do-shared";
type ConnectionMessageStreamPayload = {
  conversationId?: string;
  messageId: string;
  processId: string;
  runId: string;
  timestamp: number;
  delta?: string;
  reason?: string;
};


type SignalWatchDelivery = {
  id: string;
  key?: string;
  state?: SignalWatchRecord["state"];
  createdAt: number;
};


type AmbientProcessChangePayload = {
  pid: string;
  changes: string[];
  queuedCount?: number;
  timestamp?: number;
};


function ambientProcessChangeFrame(
  processId: string,
  frame: UserProcessSignalFrame,
): SignalFrame {
  const payload: AmbientProcessChangePayload = {
    pid: processId,
    changes: frame.payload?.changes ?? [],
  };
  if (frame.payload?.queuedCount !== undefined) payload.queuedCount = frame.payload.queuedCount;
  if (frame.payload?.timestamp !== undefined) payload.timestamp = frame.payload.timestamp;
  return {
    type: "sig",
    signal: "proc.changed",
    payload,
  };
}



export class ProcessOutput {
  constructor(readonly host: Kernel) {}

readonly pendingProcessSignals = new Map<string, Promise<void>>();

/**
   * Relay process signals using deterministic run route lookups.
   */
  async handleProcessSignal(
    processId: string,
    frame: SignalFrame<JsonValue>,
    userFrame?: UserProcessSignalFrame,
  ): Promise<void> {
    const ownerUid = this.host.procs.getOwnerUid(processId);
    if (ownerUid === null) {
      console.warn(`[Kernel] Signal from unknown process ${processId}`);
      return;
    }

    const runId = userFrame?.payload?.runId?.trim() || null;

    // Signal watches are scoped to the process owner, not the run-as account.
    await this.dispatchSignalWatches(ownerUid, processId, frame);

    if (!userFrame) return;

    let route = runId ? this.host.runRoutes.get(runId) : null;
    if (!route && runId && frame.signal === "proc.run.hil.requested") {
      route = this.host.runRoutes.materializeProcessApprovalRoute({
        processId,
        runId,
        uid: ownerUid,
      });
      if (!route && !userFrame.payload?.conversationId) {
        route = this.host.adapterDelivery.materializePersonalAdapterFallback(processId, runId, ownerUid);
      }
    }

    this.broadcastProcessSignal(ownerUid, processId, route, userFrame);

    if (frame.signal === "proc.run.finished") {
      const process = this.host.procs.get(processId);
      if (
        process?.state === "idle"
        && process.activeRunId === null
        && process.queuedCount === 0
      ) {
        this.host.adapters.surfaceRoutes.clearLegacyForProcess(processId);
      }
    }
    if (!runId || !route) {
      return;
    }

    if (route.uid !== ownerUid || route.processId !== processId) {
      this.host.runRoutes.delete(runId);
      return;
    }

    if (route.kind === "connection") {
      if (frame.signal === "proc.run.finished") {
        this.host.runRoutes.delete(runId);
      }
      return;
    }

    if (frame.signal === "proc.run.hil.requested") {
      // HIL admission waits only for a durable retry task, never for provider
      // delivery, so entering HIL cannot lose its approval notification.
      await this.host.adapterDelivery.queueAdapterRouteDelivery(route, userFrame, 1);
      return;
    }
    if (frame.signal === "proc.run.finished") {
      this.host.runRoutes.delete(runId);
      await setAdapterActivityForKernel(
        this.host.bindings,
        this.host.installationId,
        route.destination.adapter,
        route.destination.accountId,
        route.destination.surface,
        adapterTypingActivity(route, false),
      ).catch(() => undefined);
      return;
    }
    await this.host.adapterDelivery.deliverAdapterRouteEvent(route, userFrame);
  }

updateProcessRuntimeFromSignal(
    processId: string,
    frame: UserProcessSignalFrame,
    runId: string | null,
  ): boolean {
    const payload = frame.payload;
    const queuedCount = payload?.queuedCount;
    const timestamp = payload?.timestamp ?? Date.now();
    const current = this.host.procs.get(processId);
    if (!current) {
      return false;
    }
    const runtimeSignal = frame.signal === "proc.changed" || frame.signal.startsWith("proc.run.");
    if (
      runtimeSignal
      && runId
      && frame.signal !== "proc.changed"
      && current.activeRunId !== runId
    ) {
      if (frame.signal === "proc.run.started") {
        if (timestamp < (current.lastActiveAt ?? Number.NEGATIVE_INFINITY)) {
          return false;
        }
      } else {
        return frame.signal === "proc.run.finished"
          || frame.signal === "proc.run.tool.finished";
      }
    }

    const patchForActive = (state: ProcessState) => {
      const patch: ProcessRuntimePatch = {
        state,
        lastActiveAt: timestamp,
      };
      if (runId) patch.activeRunId = runId;
      if (queuedCount !== undefined) patch.queuedCount = queuedCount;
      this.host.procs.updateRuntimeState(processId, patch);
    };

    switch (frame.signal) {
      case "proc.run.started":
      case "proc.run.stream":
      case "proc.run.retrying":
      case "proc.run.output":
        patchForActive("running");
        return true;
      case "proc.run.tool.started":
        patchForActive("waiting_tool");
        return true;
      case "proc.run.tool.finished":
        return true;
      case "proc.run.hil.requested":
        patchForActive("waiting_hil");
        return true;
      case "proc.run.finished":
        {
          const patch: ProcessRuntimePatch = {
            state: queuedCount && queuedCount > 0 ? "queued" : "idle",
            activeRunId: null,
            lastActiveAt: timestamp,
          };
          if (queuedCount !== undefined) patch.queuedCount = queuedCount;
          this.host.procs.updateRuntimeState(processId, patch);
        }
        return true;
      case "proc.changed":
        if (
          payload?.changes?.includes("title")
          && payload.title
        ) {
          const title = Array.from(payload.title.trim()).slice(0, 80).join("");
          if (title) {
            this.host.procs.setLabel(processId, title);
          }
        }
        if (
          runId
          && current.activeRunId === runId
          && payload?.changes?.includes("messages")
        ) {
          patchForActive("running");
          return true;
        }
        if (queuedCount !== undefined) {
          this.host.procs.updateRuntimeState(processId, {
            queuedCount,
            lastActiveAt: timestamp,
          });
        }
        return true;
      default:
        return true;
    }
  }

enqueueProcessSignal(
    processId: string,
    frame: SignalFrame<JsonValue>,
    userFrame?: UserProcessSignalFrame,
  ): Promise<void> {
    const previous = this.pendingProcessSignals.get(processId) ?? Promise.resolve();
    const delivery = previous.then(() => this.handleProcessSignal(processId, frame, userFrame));
    const queued = delivery
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Kernel] process signal dispatch failed for ${processId}/${frame.signal}: ${message}`);
      })
      .finally(() => {
        if (this.pendingProcessSignals.get(processId) === queued) {
          this.pendingProcessSignals.delete(processId);
        }
      });
    this.pendingProcessSignals.set(processId, queued);
    return delivery;
  }

broadcastProcessSignal(
    uid: number,
    processId: string,
    route: ReturnType<RunRouteStore["get"]>,
    frame: UserProcessSignalFrame,
  ): void {
    const json = JSON.stringify(frame);
    const ambient = frame.signal === "proc.changed"
      ? JSON.stringify(ambientProcessChangeFrame(processId, frame))
      : null;
    for (const [connectionId, connection] of this.host.connections) {
      const state = connection.state;
      const peer = state?.peer;
      if (
        !peer
        || peer.principal.kind !== "human"
        || peer.principal.account.uid !== uid
      ) {
        continue;
      }
      const routed = route?.kind === "connection" && route.connectionId === connectionId;
      const observing = state.observedProcessIds?.includes(processId) === true;
      if ((routed || observing) && peer.grant.signals.includes(frame.signal)) {
        connection.send(json);
      } else if (ambient && peer.grant.signals.includes("proc.changed")) {
        connection.send(ambient);
      }
    }
  }

async dispatchSignalWatches(
    uid: number,
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    const watches = this.host.signalWatches.match(uid, frame.signal, processId);
    for (const watch of watches) {
      try {
        await this.invokeProcessSignalWatch(watch, processId, frame);
        if (watch.once) {
          this.host.signalWatches.deleteHandled(watch.watchId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.host.signalWatches.markFailed(watch.watchId, message);
        console.warn(`[Kernel] signal watch ${watch.watchId} failed: ${message}`);
      }
    }
  }

async invokeProcessSignalWatch(
    watch: SignalWatchRecord,
    processId: string,
    frame: SignalFrame,
  ): Promise<void> {
    if (!watch.targetProcessId) {
      throw new Error(`Process signal watch ${watch.watchId} is missing target process`);
    }

    const watchDelivery: SignalWatchDelivery = {
      id: watch.watchId,
      createdAt: watch.createdAt,
    };
    if (watch.key) watchDelivery.key = watch.key;
    if (watch.state !== undefined) watchDelivery.state = watch.state;

    await sendFrameToProcess(this.host.installationId, watch.targetProcessId, {
      type: "sig",
      signal: frame.signal,
      payload: {
        watched: true,
        sourcePid: processId,
        watch: watchDelivery,
        payload: frame.payload,
      },
    });
  }

async commitProcessMessage(
    processId: string,
    args: ProcessMessageCommitArgs,
  ): Promise<ConversationMessage> {
    const process = this.host.procs.get(processId);
    if (!process) throw new Error("Unknown process");
    if (!args.runId) {
      throw new Error("Message runId is invalid");
    }
    if (!args.actionId) {
      throw new Error("Message actionId is invalid");
    }
    let conversation = args.conversationId
      ? this.host.conversations.get(args.conversationId)
      : null;
    if (conversation) {
      if (
        conversation.ownerUid !== process.ownerUid
        || conversation.handlerPid !== processId
      ) {
        throw new Error("Process does not handle this conversation");
      }
    } else if (args.conversationId) {
      throw new Error("Conversation does not exist");
    } else {
      conversation = process.isPersonalController
        ? this.host.conversations.ensureShip(process.ownerUid, processId)
        : this.host.conversations.ensureWork(process.ownerUid, processId, process.label);
    }
    const stub = getConversationById(this.host.installationId, conversation.id);
    await stub.initialize({ ownerUid: conversation.ownerUid, kind: conversation.kind });
    const messageId = await stableOpaqueId("msg", [
      conversation.id,
      processId,
      args.runId,
      args.actionId,
    ]);
    const origin: ConversationMessageOrigin = {
      kind: "process",
      pid: processId,
      runId: args.runId,
    };
    const appendInput: ConversationAppendRequest = {
      messageId,
      idempotencyKey: `output:${processId}:${args.runId}:${args.actionId}`,
      author: { kind: "process", pid: processId, uid: process.uid },
      text: args.text,
      mediaOwner: {
        pid: processId,
        uid: process.uid,
        gid: process.gid,
        home: process.home,
      },
      origin,
      processId,
      runId: args.runId,
      createdAt: Date.now(),
    };
    if (args.media?.length) appendInput.media = args.media;
    const appended = await stub.append(appendInput);
    const { message } = appended;
    this.host.conversations.recordSequence(conversation.id, message.sequence);

    let route = this.host.runRoutes.get(args.runId);
    if (!route && !args.conversationId) {
      route = this.host.adapterDelivery.materializePersonalAdapterFallback(processId, args.runId, process.ownerUid);
    }
    if (route?.uid !== process.ownerUid || route?.processId !== processId) {
      if (route) this.host.runRoutes.delete(args.runId);
      route = null;
    }
    if (appended.created && conversation.kind === "ship") {
      emitTelemetry(this.host.bindings, {
        installationId: this.host.installationId,
        component: "gateway",
        event: {
          stream: "product",
          name: "ship.message.committed",
          properties: {
            delivery: route?.kind === "connection"
              ? "client"
              : route?.kind === "adapter"
                ? "adapter"
                : "background",
            hasMedia: Boolean(message.media?.length),
          },
        },
      });
    }
    if (route?.kind === "connection") {
      this.host.connectionRuntime.sendSignalToConnection(route.connectionId, "message.committed", {
        message,
        directed: true,
      });
      if (appended.created) {
        this.host.connectionRuntime.broadcastToUserUidExcept(process.ownerUid, route.connectionId, "message.committed", {
          message,
          directed: false,
        });
      }
    } else {
      if (appended.created) {
        this.host.connectionRuntime.broadcastToUserUid(process.ownerUid, "message.committed", {
          message,
          directed: false,
        });
      }
      if (route?.kind === "adapter") {
        await this.host.adapterDelivery.queueAdapterRouteDelivery(route, {
          type: "sig",
          signal: "message.committed",
          payload: { message, directed: true },
        }, 1);
      }
    }
    if (appended.created) {
      this.host.connectionRuntime.broadcastToUserUid(process.ownerUid, "conversation.changed", {
        conversationId: conversation.id,
        latestSequence: message.sequence,
      });
    }
    return message;
  }

async deliverProcessMessageStream(
    processId: string,
    frame: ProcessMessageStreamSignal,
  ): Promise<void> {
    const process = this.host.procs.get(processId);
    const payload = frame.payload;
    if (
      !process
      || !payload
      || payload.pid !== processId
    ) {
      return;
    }
    const route = this.host.runRoutes.get(payload.runId);
    if (
      !route
      || route.processId !== processId
      || route.uid !== process.ownerUid
    ) {
      return;
    }
    if (payload.phase === "silenced") {
      if (route.kind === "adapter") {
        await setAdapterActivityForKernel(
          this.host.bindings,
          this.host.installationId,
          route.destination.adapter,
          route.destination.accountId,
          route.destination.surface,
          adapterTypingActivity(route, false),
        ).catch(() => undefined);
      }
      return;
    }
    if (route.kind !== "connection") return;
    const signal = payload.phase === "started"
      ? "message.started"
      : payload.phase === "delta"
        ? "message.delta"
        : "message.aborted";
    const signalPayload: ConnectionMessageStreamPayload = {
      messageId: payload.messageId,
      processId,
      runId: payload.runId,
      timestamp: payload.timestamp,
    };
    if (payload.conversationId !== undefined) {
      signalPayload.conversationId = payload.conversationId;
    }
    if (payload.phase === "delta") signalPayload.delta = payload.delta ?? "";
    if (payload.phase === "aborted") signalPayload.reason = payload.reason ?? "aborted";
    this.host.connectionRuntime.sendSignalToConnection(route.connectionId, signal, signalPayload);
  }
}
