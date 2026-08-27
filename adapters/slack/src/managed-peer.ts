import { DurableObject } from "cloudflare:workers";
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
import { cancelBinaryBody } from "../../shared/src/media-body";
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
  ManagedSlackWorkspaceAdmission,
  ManagedSlackWorkspacePostResult,
} from "./managed-workspace";
import { renderSlackMessageText } from "./slack-delivery";
import {
  isSlackPairCommand,
  type SlackInbound,
} from "./slack-events";
import {
  requireSlackId,
  requireSlackTimestamp,
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
    input: { channel: string; text: string; threadTs?: string },
  ): Promise<ManagedSlackWorkspacePostResult>;
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

export class ManagedSlackPeer extends DurableObject<ManagedSlackPeerEnv> {
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<InboundPayload, ResponseContext>;
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
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Slack peer is not initialized");
      const activated = activateManagedSlackPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route,
      });
      await txn.put(STATE_KEY, activated.state);
      return activated.preparation;
    });
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
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedSlackPeerState>(STATE_KEY);
      if (!state) return { disconnected: false };
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
      return { disconnected: result.disconnected };
    });
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

    const current = await this.requireState();
    if (
      current.workspaceGeneration !== payload.workspaceGeneration
      || current.activeRoute?.installationId !== route.installationId
      || current.activeRoute.generation !== route.generation
    ) {
      return { terminal: true };
    }
    const inbound = payload.inbound;
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
          text: inbound.text,
          replyToId: inbound.replyToId,
          timestamp: inbound.timestamp,
          wasMentioned: true,
        },
      },
    );
    if (result.challenge) return await this.pairingResponse(inbound);
    const disposition = adapterInboundResultDisposition(result, {
      surface: inbound.surface,
      providerMessageId: inbound.messageId,
      actorId: inbound.actorId,
    });
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
    if ((message.media?.length ?? 0) > 0 || body) {
      await cancelBinaryBody(body, "Slack media delivery is not supported yet");
      return { ok: false, error: "Slack media delivery is not supported yet" };
    }
    if (!renderedText) return { ok: false, error: "Slack messages require text" };

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery({ ...message, text: renderedText });
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

    const fail = async (kind: DeliveryFailureKind): Promise<AdapterSendResult> => {
      const error = "Slack delivery failed";
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
    let delivered: ManagedSlackWorkspacePostResult;
    try {
      delivered = await this.workspace(current.accountId).postMessage(
        current.workspaceGeneration,
        {
          channel: message.surface.id,
          text: renderedText,
          threadTs: message.surface.threadId,
        },
      );
    } catch {
      return await fail("ambiguous");
    }
    if (!delivered.ok) return await fail(delivered.kind);
    await this.deliveries.succeed(message.deliveryId, claim.attemptId, delivered.ts);
    return { ok: true, messageId: delivered.ts };
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

  private assertObjectIdentity(state: ManagedSlackPeerState): void {
    if (this.ctx.id.name !== managedSlackPeerObjectName(state.accountId, state.actorId)) {
      throw new Error("Managed Slack peer Durable Object identity mismatch");
    }
  }

  private workspace(accountId: string): ManagedWorkspaceStub {
    const id = this.env.MANAGED_SLACK_WORKSPACE.idFromName(
      managedSlackWorkspaceObjectName(accountId),
    );
    return typedStub<ManagedWorkspaceStub>(this.env.MANAGED_SLACK_WORKSPACE.get(id));
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
