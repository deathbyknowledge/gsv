import { DurableObject } from "cloudflare:workers";
import type {
  AdapterTargetDescriptor,
  AdapterTargetRequestFrame,
  AdapterTargetResponseFrame,
} from "../../../packages/gsv/src/services/adapters.js";
import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
  type InboundDeliveryDisposition,
} from "../../shared/src/inbound-delivery";
import { callAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  cancelBinaryBody,
  readAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  validateAdapterMediaBody,
} from "../../shared/src/media-body";
import type {
  AdapterOutboundMessage,
  AdapterPairingActivateInput,
  AdapterPairingCandidate,
  AdapterPairingDisconnectInput,
  AdapterPairingPreparation,
  AdapterPairingPrepareInput,
  AdapterPairingRoute,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
} from "./types";
import type {
  ManagedSlackPairingEnv,
  ManagedSlackPairingRecord,
} from "./managed-pairing";
import {
  managedSlackPeerObjectName,
  managedSlackWorkspaceObjectName,
} from "./managed-identity";
import {
  activateManagedSlackPairing,
  bindManagedSlackDm,
  bindManagedSlackPeer,
  disconnectManagedSlackPeer,
  finalizeManagedSlackPairing,
  managedSlackPairingCandidate,
  managedSlackPeerAllowsSurface,
  prepareManagedSlackPairing,
  type ManagedSlackPeerRoute,
  type ManagedSlackPeerState,
} from "./managed-peer-state";
import type {
  ManagedSlackTargetAuthorization,
  ManagedSlackWorkspaceAdmission,
  ManagedSlackWorkspaceDownloadResult,
  ManagedSlackWorkspacePostResult,
  ManagedSlackWorkspaceUploadResult,
} from "./managed-workspace";
import {
  prepareSlackUploadFiles,
  renderSlackMessageText,
} from "./slack-delivery";
import {
  appendSlackMediaNotice,
  loadSlackInboundMedia,
  MAX_SLACK_MEDIA_ITEMS,
} from "./slack-media";
import {
  buildSlackApprovalBlocks,
  buildSlackApprovalSubmittedMessage,
} from "./slack-interactions";
import {
  isSlackPairCommand,
  type SlackInbound,
} from "./slack-events";
import {
  requireSlackId,
  requireSlackTimestamp,
  type SlackPostMessageInput,
  type SlackUpdateMessageInput,
} from "./slack-api";

export interface ManagedSlackPeerEnv extends ManagedSlackPairingEnv {
  GATEWAY: Fetcher & AdapterGatewayBinding & ManagedSlackPairingEnv["GATEWAY"];
  MANAGED_SLACK_WORKSPACE: DurableObjectNamespace;
  MANAGED_SLACK_PAIRING: DurableObjectNamespace;
}

export type ManagedSlackAcceptedEvent = {
  accountId: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  workspaceGeneration: string;
  inbound: SlackInbound;
};

type InboundPayload = {
  inbound: SlackInbound;
  workspaceGeneration: string;
  routeGeneration?: string;
};

type ResponseContext =
  | { kind: "platform"; workspaceGeneration: string; claimId?: string }
  | {
      kind: "installation";
      installationId: string;
      generation: string;
      workspaceGeneration: string;
    };

type PairingIssue = { code: string; claimId: string; expiresAt: number };
type ManagedPairingStub = {
  initialize(input: ManagedSlackPairingRecord): Promise<{ created: boolean }>;
};
type ManagedWorkspaceStub = {
  admitEvent(teamId: string): Promise<ManagedSlackWorkspaceAdmission>;
  openDm(actorId: string, expectedGeneration: string): Promise<{ channelId: string }>;
  postMessage(
    expectedGeneration: string,
    input: SlackPostMessageInput,
  ): Promise<ManagedSlackWorkspacePostResult>;
  updateMessage(
    expectedGeneration: string,
    input: SlackUpdateMessageInput,
  ): Promise<ManagedSlackWorkspacePostResult>;
  downloadFile(
    expectedGeneration: string,
    fileId: string,
    maxBytes: number,
  ): Promise<ManagedSlackWorkspaceDownloadResult>;
  uploadFiles(
    expectedGeneration: string,
    input: {
      channel: string;
      text: string;
      threadTs?: string;
      files: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
    },
  ): Promise<ManagedSlackWorkspaceUploadResult>;
  getTargetAuthorization(
    actorId: string,
    expectedGeneration: string,
  ): Promise<ManagedSlackTargetAuthorization>;
  executeTarget(
    actorId: string,
    expectedGeneration: string,
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec">>;
  cancelTarget(
    actorId: string,
    expectedGeneration: string,
    requestId: string,
  ): Promise<{ cancelled: boolean }>;
};

type ManagedWorkspaceClient = Omit<
  ManagedWorkspaceStub,
  "getTargetAuthorization" | "executeTarget" | "cancelTarget"
> & {
  getTargetAuthorization(
    actorId: string,
    expectedGeneration: string,
  ): Promise<ManagedSlackTargetAuthorization & Disposable>;
  executeTarget(
    actorId: string,
    expectedGeneration: string,
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec"> & Disposable>;
  cancelTarget(
    actorId: string,
    expectedGeneration: string,
    requestId: string,
  ): Promise<{ cancelled: boolean } & Disposable>;
};

type ActiveManagedSlackTargetCall = {
  installationId: string;
  routeGeneration: string;
  workspaceGeneration: string;
  requestId: string;
};

const STATE_KEY = "managed_slack_peer:v1:state";
const INBOUND_PREFIX = "managed_slack_peer:v1:inbound:";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const INBOUND_WAKE_DELAY_MS = 25;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;
const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_MAX_RECORDS = 4_096;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CHARACTERS = 12;
const SLACK_TARGET_ID = "workspace";

export class ManagedSlackPeer extends DurableObject<ManagedSlackPeerEnv> {
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<InboundPayload, ResponseContext>;
  private readonly targetCalls = new Map<string, ActiveManagedSlackTargetCall>();
  private drainPromise?: Promise<void>;

  constructor(ctx: DurableObjectState, env: ManagedSlackPeerEnv) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
      {
        completedRetentionMs: INBOUND_RETENTION_MS,
        maxRecords: INBOUND_MAX_RECORDS,
        pendingOrder: "created",
      },
    );
  }

  async acceptEvent(input: ManagedSlackAcceptedEvent): Promise<{ accepted: true }> {
    const routeGeneration = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      const next = bindManagedSlackPeer(current, input);
      this.assertObjectIdentity(next);
      await txn.put(STATE_KEY, next);
      return next.activeRoute?.generation;
    });
    await this.inboundDeliveries.enqueueAndArm(
      input.inbound.deliveryId,
      {
        inbound: input.inbound,
        workspaceGeneration: input.workspaceGeneration,
        routeGeneration,
      },
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    this.ctx.waitUntil(this.drainInbound());
    return { accepted: true };
  }

  async acceptInteraction(
    input: ManagedSlackAcceptedEvent,
  ): Promise<{ accepted: boolean }> {
    const state = await this.ctx.storage.get<ManagedSlackPeerState>(STATE_KEY);
    if (!state) return { accepted: false };
    this.assertObjectIdentity(state);
    const interaction = input.inbound.interaction;
    const route = state.activeRoute;
    if (
      !interaction
      || !route
      || input.accountId !== state.accountId
      || input.teamId !== state.teamId
      || input.botUserId !== state.botUserId
      || input.workspaceGeneration !== state.workspaceGeneration
      || input.inbound.actorId !== state.actorId
      || input.inbound.surface.kind !== "dm"
      || input.inbound.surface.id !== state.dmSurfaceId
      || !interaction.expectedRouteGeneration
      || interaction.expectedRouteGeneration !== route.generation
    ) {
      return { accepted: false };
    }
    await this.inboundDeliveries.enqueueAndArm(
      input.inbound.deliveryId,
      {
        inbound: input.inbound,
        workspaceGeneration: input.workspaceGeneration,
        routeGeneration: route.generation,
      },
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    this.ctx.waitUntil(this.drainInbound());
    return { accepted: true };
  }

  async sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    let state: ManagedSlackPeerState;
    try {
      state = await this.requireState();
      this.assertDestination(state, message.surface, message.actorId);
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: "Slack destination is not authorized" };
    }
    const route = state.activeRoute;
    if (
      !route
      || route.installationId !== installationId
      || !message.routeGeneration
      || route.generation !== message.routeGeneration
    ) {
      await cancelBinaryBody(body, "Slack route changed before delivery");
      return { ok: false, error: "Slack route changed before delivery" };
    }
    return await this.deliverMessage(message, {
      kind: "installation",
      installationId,
      generation: route.generation,
      workspaceGeneration: state.workspaceGeneration,
    }, body);
  }

  async listTargets(
    installationId: string,
    routeGeneration: string,
  ): Promise<AdapterTargetDescriptor[]> {
    let state: ManagedSlackPeerState;
    try {
      state = await this.requireTargetRoute(installationId, routeGeneration);
    } catch {
      return [];
    }
    using authorization = await this.workspace(state.accountId).getTargetAuthorization(
      state.actorId,
      state.workspaceGeneration,
    );
    if (
      !authorization.available
      || authorization.actorId !== state.actorId
      || authorization.teamId !== state.teamId
    ) {
      return [];
    }
    return [{
      id: SLACK_TARGET_ID,
      label: `Slack — ${authorization.teamName ?? authorization.teamId}`,
      description: "Slack workspace: reads with the paired user's OAuth visibility; writes as the installed GSV app and labels target messages with that user's GSV. Run `slack --help` for commands.",
      platform: "slack",
      version: "web-api",
      implements: ["shell.exec"],
    }];
  }

  async executeTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec">> {
    if (targetId !== SLACK_TARGET_ID) {
      return targetError(frame.id, 404, "Slack target is unavailable");
    }
    let state: ManagedSlackPeerState;
    try {
      state = await this.requireTargetRoute(installationId, routeGeneration);
    } catch {
      return targetError(frame.id, 403, "Slack target route is unavailable");
    }
    const key = targetCallKey(routeGeneration, frame.id);
    if (this.targetCalls.has(key)) {
      return targetError(frame.id, 409, "Slack target request is already running");
    }
    const active: ActiveManagedSlackTargetCall = {
      installationId,
      routeGeneration,
      workspaceGeneration: state.workspaceGeneration,
      requestId: frame.id,
    };
    this.targetCalls.set(key, active);
    try {
      using response = await this.workspace(state.accountId).executeTarget(
        state.actorId,
        state.workspaceGeneration,
        frame,
      );
      const detachedResponse = structuredClone(response);
      try {
        const current = await this.requireTargetRoute(installationId, routeGeneration);
        if (current.workspaceGeneration !== state.workspaceGeneration) {
          return targetError(frame.id, 409, "Slack target authorization changed during execution");
        }
      } catch {
        return targetError(frame.id, 409, "Slack target route changed during execution");
      }
      return detachedResponse;
    } finally {
      if (this.targetCalls.get(key) === active) this.targetCalls.delete(key);
    }
  }

  async cancelTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    requestId: string,
  ): Promise<{ cancelled: boolean }> {
    if (targetId !== SLACK_TARGET_ID) return { cancelled: false };
    const active = this.targetCalls.get(targetCallKey(routeGeneration, requestId));
    if (
      !active
      || active.installationId !== installationId
      || active.routeGeneration !== routeGeneration
    ) {
      return { cancelled: false };
    }
    const state = await this.requireState();
    using result = await this.workspace(state.accountId).cancelTarget(
      state.actorId,
      active.workspaceGeneration,
      active.requestId,
    );
    return { cancelled: result.cancelled };
  }

  async inspectPairing(claimId: string, expiresAt: number): Promise<AdapterPairingCandidate> {
    const state = await this.requireState();
    const pairing = state.pairing;
    if (!pairing || pairing.claimId !== claimId || pairing.expiresAt !== expiresAt) {
      throw new Error("Pairing code is invalid");
    }
    if (pairing.status === "pending" && pairing.expiresAt <= Date.now()) {
      throw new Error("Pairing code expired");
    }
    return managedSlackPairingCandidate(state, pairing.expiresAt);
  }

  async preparePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation> {
    const route: ManagedSlackPeerRoute = {
      installationId: requireOpaque(input.installationId, "installationId"),
      localUid: requireLocalUid(input.localUid),
      generation: crypto.randomUUID(),
      canonicalOrigin: requireCanonicalOrigin(input.canonicalOrigin),
      linkedAt: Date.now(),
    };
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Slack peer is not initialized");
      const existing = state.pairing?.preparedRoute;
      const effectiveRoute = state.pairing?.operationId === input.operationId && existing
        ? existing
        : route;
      const prepared = prepareManagedSlackPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route: effectiveRoute,
        now: Date.now(),
      });
      await txn.put(STATE_KEY, prepared.state);
      return prepared.preparation;
    });
  }

  async activatePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const route = routeWithOrigin(input.route, input.canonicalOrigin);
    const activated = await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Slack peer is not initialized");
      const activated = activateManagedSlackPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route,
      });
      await txn.put(STATE_KEY, activated.state);
      return activated;
    });
    await this.cancelSupersededTargetCalls(activated.state);
    return activated.preparation;
  }

  async finalizePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const route = routeWithOrigin(input.route, input.canonicalOrigin);
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Slack peer is not initialized");
      const finalized = finalizeManagedSlackPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route,
      });
      if (finalized.changed) await txn.put(STATE_KEY, finalized.state);
      return finalized.preparation;
    });
  }

  async sendPairingConfirmation(operationId: string, canonicalOrigin: string): Promise<void> {
    const state = await this.requireState();
    const route = state.activeRoute;
    if (!route || state.pairing?.operationId !== operationId || !state.dmSurfaceId) return;
    const result = await this.deliverMessage({
      deliveryId: `managed-slack-paired:${operationId}`,
      surface: { kind: "dm", id: state.dmSurfaceId },
      actorId: state.actorId,
      text: `Connected to ${requireCanonicalOrigin(canonicalOrigin)}`,
    }, {
      kind: "installation",
      installationId: route.installationId,
      generation: route.generation,
      workspaceGeneration: state.workspaceGeneration,
    });
    if (!result.ok && result.retryable) throw new Error("Pairing confirmation should be retried");
  }

  async disconnect(input: AdapterPairingDisconnectInput): Promise<{ disconnected: boolean }> {
    const disconnected = await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) return { state: undefined, disconnected: false };
      if (
        state.accountId !== input.accountId
        || state.actorId !== input.actorId
        || state.dmSurfaceId !== input.surfaceId
      ) {
        throw new Error("Managed Slack peer identity mismatch");
      }
      const result = disconnectManagedSlackPeer(state, {
        operationId: requireOpaque(input.operationId, "operationId"),
        route: parseRoute(input),
      });
      if (result.state !== state) await txn.put(STATE_KEY, result.state);
      return { state: result.state, disconnected: result.disconnected };
    });
    if (disconnected.state) await this.cancelSupersededTargetCalls(disconnected.state);
    return { disconnected: disconnected.disconnected };
  }

  async alarm(): Promise<void> {
    await this.drainInbound();
    await this.inboundDeliveries.armIfPending(Date.now() + INBOUND_RETRY_DELAY_MS);
  }

  private async drainInbound(): Promise<void> {
    if (this.drainPromise) return await this.drainPromise;
    const running = (async () => {
      const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
      for (const id of ids) {
        const result = await this.inboundDeliveries.attempt(
          id,
          async (payload) => await this.forwardInbound(payload),
          async (message, context) => await this.deliverMessage(
            message,
            context ?? await this.platformContext(),
          ),
        );
        if (result.state === "pending") {
          await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
          break;
        }
      }
    })();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  private async forwardInbound(
    payload: InboundPayload,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    const state = await this.requireState();
    if (state.workspaceGeneration !== payload.workspaceGeneration) return { terminal: true };
    if (!payload.routeGeneration || isSlackPairCommand(payload.inbound)) {
      return await this.pairingResponse(payload.inbound);
    }
    const route = state.activeRoute;
    if (!route || route.generation !== payload.routeGeneration) return { terminal: true };
    const admission = await this.workspace(state.accountId).admitEvent(state.teamId);
    if (!admission.accepted || admission.generation !== payload.workspaceGeneration) {
      return { terminal: true };
    }

    const transfer = await loadSlackInboundMedia(
      payload.inbound.media ?? [],
      async (fileId, maxBytes) => {
        const result = await this.workspace(state.accountId).downloadFile(
          payload.workspaceGeneration,
          fileId,
          maxBytes,
        );
        if (result.ok) return result.file;
        if (result.kind === "permanent") return null;
        throw new Error("Slack file download should be retried");
      },
    );

    let current: ManagedSlackPeerState;
    let currentAdmission: ManagedSlackWorkspaceAdmission;
    try {
      current = await this.requireState();
      currentAdmission = await this.workspace(current.accountId).admitEvent(current.teamId);
    } catch (error) {
      await cancelBinaryBody(transfer.body, error);
      throw error;
    }
    if (
      current.workspaceGeneration !== payload.workspaceGeneration
      || current.activeRoute?.installationId !== route.installationId
      || current.activeRoute.generation !== route.generation
      || !currentAdmission.accepted
      || currentAdmission.generation !== payload.workspaceGeneration
    ) {
      await cancelBinaryBody(transfer.body, "Slack route changed before media delivery");
      return { terminal: true };
    }
    const inbound = payload.inbound;
    const skipped = (inbound.skippedMedia ?? 0) + transfer.skipped;
    const result = await callAdapterGateway(
      this.env.GATEWAY,
      { installationId: route.installationId },
      "adapter.inbound",
      {
        adapter: "slack",
        accountId: current.accountId,
        deliveryId: inbound.deliveryId,
        routeGeneration: route.generation,
        message: {
          messageId: inbound.messageId,
          surface: inbound.surface,
          actor: {
            id: inbound.actorId,
            name: current.actorName,
            handle: current.actorHandle,
          },
          text: appendSlackMediaNotice(inbound.text, skipped),
          media: transfer.media.length > 0 ? transfer.media : undefined,
          replyToId: inbound.replyToId,
          timestamp: inbound.timestamp,
          wasMentioned: true,
        },
      },
      transfer.body,
    );
    const disposition = adapterInboundResultDisposition(result, {
      surface: inbound.surface,
      providerMessageId: inbound.messageId,
      actorId: inbound.actorId,
    });
    if (inbound.interaction && disposition.terminal) {
      await this.markInteractionSubmitted(payload);
    }
    if (result.challenge) {
      if (inbound.interaction) {
        return { terminal: disposition.terminal, error: disposition.error };
      }
      return await this.pairingResponse(inbound);
    }
    return {
      terminal: disposition.terminal,
      error: disposition.error,
      responses: disposition.responses?.map((response) => ({
        ...response,
        context: {
          kind: "installation" as const,
          installationId: route.installationId,
          generation: route.generation,
          workspaceGeneration: payload.workspaceGeneration,
        },
      })),
    };
  }

  private async markInteractionSubmitted(payload: InboundPayload): Promise<void> {
    const interaction = payload.inbound.interaction;
    if (!interaction || !payload.routeGeneration) return;
    try {
      const state = await this.requireState();
      const route = state.activeRoute;
      if (
        !route
        || route.generation !== payload.routeGeneration
        || interaction.expectedRouteGeneration !== route.generation
        || state.workspaceGeneration !== payload.workspaceGeneration
        || payload.inbound.actorId !== state.actorId
        || payload.inbound.surface.kind !== "dm"
        || payload.inbound.surface.id !== state.dmSurfaceId
      ) {
        return;
      }
      const rendered = buildSlackApprovalSubmittedMessage(
        interaction.sourceText,
        interaction.action,
      );
      await this.workspace(state.accountId).updateMessage(
        state.workspaceGeneration,
        {
          channel: payload.inbound.surface.id,
          messageTs: interaction.sourceMessageId,
          ...rendered,
        },
      );
    } catch {
      // The durable approval delivery is authoritative; clearing buttons is best effort.
    }
  }

  private async pairingResponse(
    inbound: SlackInbound,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    let state = await this.ensureDm();
    const pairing = state.pairing;
    if (
      pairing
      && (pairing.status === "prepared" || pairing.status === "active")
      && pairing.expiresAt > Date.now()
    ) {
      return platformResponse(
        state,
        `managed-slack-pairing-in-progress:${pairing.claimId}:${inbound.deliveryId}`,
        "This Slack connection is still being confirmed in GSV. Finish or retry that confirmation, then mention GSV again.",
        pairing.claimId,
      );
    }
    const issue = await this.issuePairing();
    state = await this.requireState();
    return {
      terminal: true,
      responses: [{
        message: {
          deliveryId: `managed-slack-pair:${issue.claimId}:${inbound.deliveryId}`,
          surface: { kind: "dm", id: requireDmSurface(state) },
          actorId: state.actorId,
          text: [
            "Connect this Slack identity to your GSV.",
            "",
            `Pairing code: ${formatPairingCode(issue.code)}`,
            "",
            "Open GSV → Messengers → Slack, enter the code, and confirm this identity.",
            "This code expires in 10 minutes.",
          ].join("\n"),
        },
        expiresAt: issue.expiresAt,
        context: {
          kind: "platform",
          claimId: issue.claimId,
          workspaceGeneration: state.workspaceGeneration,
        },
      }],
    };
  }

  private async ensureDm(): Promise<ManagedSlackPeerState> {
    const state = await this.requireState();
    if (state.dmSurfaceId) return state;
    const opened = await this.workspace(state.accountId).openDm(
      state.actorId,
      state.workspaceGeneration,
    );
    return await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!current || current.workspaceGeneration !== state.workspaceGeneration) {
        throw new Error("Slack workspace changed while opening a direct message");
      }
      const next = bindManagedSlackDm(
        current,
        requireSlackId(opened.channelId, "Slack direct message"),
      );
      await txn.put(STATE_KEY, next);
      return next;
    });
  }

  private async issuePairing(): Promise<PairingIssue> {
    const now = Date.now();
    const state = await this.requireState();
    if (!state.dmSurfaceId) throw new Error("Slack direct message is unavailable");
    const current = state.pairing;
    if (current?.status === "pending" && current.expiresAt > now) {
      return { code: current.code, claimId: current.claimId, expiresAt: current.expiresAt };
    }

    const claimId = crypto.randomUUID();
    const expiresAt = now + PAIRING_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createPairingCode();
      const initialized = await this.pairing(code).initialize({
        version: 1,
        claimId,
        accountId: state.accountId,
        actorId: state.actorId,
        expiresAt,
      });
      if (!initialized.created) continue;
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ManagedSlackPeerState>(STATE_KEY);
        if (!latest) throw new Error("Managed Slack peer is not initialized");
        await txn.put(STATE_KEY, {
          ...latest,
          pairing: { claimId, code, expiresAt, status: "pending" },
        } satisfies ManagedSlackPeerState);
      });
      return { code, claimId, expiresAt };
    }
    throw new Error("Could not allocate a Slack pairing code");
  }

  private async deliverMessage(
    message: AdapterOutboundMessage,
    context: ResponseContext,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    let state: ManagedSlackPeerState;
    let renderedText: string;
    try {
      state = await this.requireState();
      this.assertDestination(state, message.surface, message.actorId);
      this.assertDeliveryContext(state, context);
      renderedText = renderSlackMessageText(
        message,
        message.surface.kind === "dm" ? undefined : state.actorId,
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: "Slack destination is not authorized" };
    }
    const media = message.media ?? [];
    if (!renderedText && media.length === 0) {
      await cancelBinaryBody(body, "Slack messages require text or media");
      return { ok: false, error: "Slack messages require text or media" };
    }
    if (media.length > MAX_SLACK_MEDIA_ITEMS) {
      await cancelBinaryBody(body, "Slack supports at most 20 attachments per message");
      return { ok: false, error: "Slack supports at most 20 attachments per message" };
    }
    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Slack media body is invalid",
      };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch {
      return { ok: false, error: "Could not read Slack media body", retryable: true };
    }
    let uploadFiles: ReturnType<typeof prepareSlackUploadFiles>;
    try {
      uploadFiles = prepareSlackUploadFiles(media, mediaBytes);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Slack media delivery is invalid",
      };
    }

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery(
        { ...message, text: renderedText },
        mediaBytes,
      );
    } catch {
      return { ok: false, error: "Could not fingerprint Slack delivery", retryable: true };
    }
    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, fingerprint);
    } catch {
      return { ok: false, error: "Slack delivery ledger unavailable", retryable: true };
    }
    if (!claim.claimed) return claim.result;

    const fail = async (
      kind: DeliveryFailureKind,
      error = "Slack delivery failed",
    ): Promise<AdapterSendResult> => {
      if (kind === "retryable") {
        await this.deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
        return { ok: false, error, retryable: true };
      }
      if (kind === "ambiguous") {
        await this.deliveries.failAmbiguous(message.deliveryId, claim.attemptId, error);
        return { ok: false, error, ambiguous: true };
      }
      await this.deliveries.failPermanent(message.deliveryId, claim.attemptId, error);
      return { ok: false, error };
    };

    const current = await this.requireState();
    try {
      this.assertDestination(current, message.surface, message.actorId);
      this.assertDeliveryContext(current, context);
    } catch {
      return await fail("permanent");
    }
    let providerMessageId: string | undefined;
    try {
      if (uploadFiles.length > 0) {
        const delivered = await this.workspace(current.accountId).uploadFiles(
          current.workspaceGeneration,
          {
            channel: message.surface.id,
            text: renderedText,
            threadTs: message.surface.threadId,
            files: uploadFiles,
          },
        );
        if (!delivered.ok) return await fail(delivered.kind, delivered.error);
        providerMessageId = delivered.fileIds[0];
      } else {
        const approvalBlocks = message.surface.kind === "dm"
          && context.kind === "installation"
          ? buildSlackApprovalBlocks(renderedText, context.generation)
          : undefined;
        const delivered = await this.workspace(current.accountId).postMessage(
          current.workspaceGeneration,
          {
            channel: message.surface.id,
            text: renderedText,
            threadTs: message.surface.threadId,
            blocks: approvalBlocks,
          },
        );
        if (!delivered.ok) return await fail(delivered.kind, delivered.error);
        providerMessageId = delivered.ts;
      }
    } catch {
      return await fail("ambiguous");
    }
    await this.deliveries.succeed(message.deliveryId, claim.attemptId, providerMessageId);
    return { ok: true, messageId: providerMessageId };
  }

  private assertDestination(
    state: ManagedSlackPeerState,
    surface: AdapterSurface,
    actorId: string | undefined,
  ): void {
    if (actorId !== state.actorId || !managedSlackPeerAllowsSurface(state, surface)) {
      throw new Error("Slack destination does not match this peer");
    }
    requireSlackId(surface.id, "Slack channel");
    if (surface.threadId) requireSlackTimestamp(surface.threadId);
  }

  private assertDeliveryContext(state: ManagedSlackPeerState, context: ResponseContext): void {
    if (state.workspaceGeneration !== context.workspaceGeneration) {
      throw new Error("Slack workspace changed before delivery");
    }
    if (context.kind === "installation") {
      if (
        state.activeRoute?.installationId !== context.installationId
        || state.activeRoute.generation !== context.generation
      ) {
        throw new Error("Slack route changed before delivery");
      }
      return;
    }
    if (context.claimId && state.pairing?.claimId !== context.claimId) {
      throw new Error("Slack pairing changed before delivery");
    }
  }

  private async platformContext(): Promise<ResponseContext> {
    const state = await this.requireState();
    return { kind: "platform", workspaceGeneration: state.workspaceGeneration };
  }

  private async requireState(): Promise<ManagedSlackPeerState> {
    const state = await this.ctx.storage.get<ManagedSlackPeerState>(STATE_KEY);
    if (!state) throw new Error("Managed Slack peer is not initialized");
    this.assertObjectIdentity(state);
    return state;
  }

  private async requireTargetRoute(
    installationId: string,
    routeGeneration: string,
  ): Promise<ManagedSlackPeerState> {
    const state = await this.requireState();
    const route = state.activeRoute;
    if (
      !route
      || route.installationId !== requireOpaque(installationId, "installationId")
      || route.generation !== requireOpaque(routeGeneration, "routeGeneration")
    ) {
      throw new Error("Slack target route changed");
    }
    return state;
  }

  private async cancelSupersededTargetCalls(state: ManagedSlackPeerState): Promise<void> {
    const route = state.activeRoute;
    const calls = [...this.targetCalls.values()].filter((active) => (
      !route
      || active.installationId !== route.installationId
      || active.routeGeneration !== route.generation
      || active.workspaceGeneration !== state.workspaceGeneration
    ));
    await Promise.all(calls.map(async (active) => {
      using _result = await this.workspace(state.accountId).cancelTarget(
        state.actorId,
        active.workspaceGeneration,
        active.requestId,
      ).catch(() => undefined);
    }));
  }

  private assertObjectIdentity(state: ManagedSlackPeerState): void {
    if (this.ctx.id.name !== managedSlackPeerObjectName(state.accountId, state.actorId)) {
      throw new Error("Managed Slack peer Durable Object identity mismatch");
    }
  }

  private workspace(accountId: string): ManagedWorkspaceClient & DurableObjectStub {
    const id = this.env.MANAGED_SLACK_WORKSPACE.idFromName(
      managedSlackWorkspaceObjectName(accountId),
    );
    return typedStub<ManagedWorkspaceClient>(this.env.MANAGED_SLACK_WORKSPACE.get(id));
  }

  private pairing(code: string): ManagedPairingStub {
    const id = this.env.MANAGED_SLACK_PAIRING.idFromName(`pair:${code}`);
    return typedStub<ManagedPairingStub>(this.env.MANAGED_SLACK_PAIRING.get(id));
  }
}

function typedStub<T>(value: DurableObjectStub): T & DurableObjectStub {
  // SAFETY: these namespaces are owned by this worker and expose the declared RPC contracts.
  return value as T & DurableObjectStub;
}

function targetCallKey(routeGeneration: string, requestId: string): string {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId || normalizedRequestId.length > 512 || normalizedRequestId.includes("\0")) {
    throw new Error("requestId is invalid");
  }
  return `${requireOpaque(routeGeneration, "routeGeneration")}\0${normalizedRequestId}`;
}

function targetError(
  id: string,
  code: number,
  message: string,
): AdapterTargetResponseFrame<"shell.exec"> {
  return { type: "res", id, ok: false, error: { code, message } };
}

function platformResponse(
  state: ManagedSlackPeerState,
  deliveryId: string,
  text: string,
  claimId?: string,
): InboundDeliveryDisposition<ResponseContext> {
  return {
    terminal: true,
    responses: [{
      message: {
        deliveryId,
        surface: { kind: "dm", id: requireDmSurface(state) },
        actorId: state.actorId,
        text,
      },
      context: {
        kind: "platform",
        workspaceGeneration: state.workspaceGeneration,
        claimId,
      },
    }],
  };
}

function requireDmSurface(state: ManagedSlackPeerState): string {
  return requireSlackId(state.dmSurfaceId, "Slack direct message");
}

function createPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CHARACTERS));
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
}

function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function routeWithOrigin(
  route: AdapterPairingRoute,
  canonicalOrigin: string,
): ManagedSlackPeerRoute {
  return {
    ...parseRoute(route),
    canonicalOrigin: requireCanonicalOrigin(canonicalOrigin),
    linkedAt: Date.now(),
  };
}

function parseRoute(value: AdapterPairingRoute): AdapterPairingRoute {
  return {
    installationId: requireOpaque(value?.installationId, "installationId"),
    localUid: requireLocalUid(value?.localUid),
    generation: requireOpaque(value?.generation, "generation"),
  };
}

function requireOpaque(value: string, field: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireLocalUid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("localUid is invalid");
  }
  return value;
}

function requireCanonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value.replace(/\/$/, "")
  ) {
    throw new Error("canonicalOrigin must be an HTTPS origin");
  }
  return url.origin;
}
