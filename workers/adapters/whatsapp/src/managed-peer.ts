import {
  AdapterRetirement,
  type AdapterDataOwner,
  type AdapterDataScope,
} from "../../shared/src/retirement";
import { AdapterPeerRetirement } from "../../shared/src/peer-retirement";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { InstallationDirectoryService } from "../../../../packages/gsv/src/services/directory.js";
import type { ManagedWhatsAppPairing } from "./managed-pairing";
import { DurableObject } from "cloudflare:workers";
import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
  type DeliveryClaim,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
  type InboundDeliveryDisposition,
} from "../../shared/src/inbound-delivery";
import { runAdapterHilSqlMigrations } from "../../shared/src/schema/migrations";
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
  AdapterDeliveryContext,
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
import {
  attachWhatsAppApprovalMessage,
  buildWhatsAppInteractivePayload,
  describeWhatsAppApproval,
  handleWhatsAppApprovalReply,
  prepareWhatsAppApproval,
  WHATSAPP_INTERACTIVE_BODY_LIMIT,
  type WhatsAppApprovalControls,
  type WhatsAppApprovalSource,
} from "./whatsapp-approval";
import { managedWhatsAppTemplate, type ManagedWhatsAppTemplateEnv } from "./managed-config";
import {
  buildWhatsAppTemplatePayload,
  flattenWhatsAppTemplateParameter,
  WHATSAPP_HELD_FULL_ERROR,
  WHATSAPP_HELD_TOO_LONG_ERROR,
  WHATSAPP_NO_TEMPLATE_ERROR,
  WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR,
} from "./whatsapp-template";
import {
  WhatsAppHeldOutbound,
  type HeldOutboundInput,
  type HeldOutboundRecord,
} from "./whatsapp-held-outbound";
import type {
  ManagedWhatsAppPairingEnv,
  ManagedWhatsAppPairingRecord,
} from "./managed-pairing";
import {
  activateManagedWhatsAppPairing,
  bindManagedWhatsAppPeerIdentity,
  disconnectManagedWhatsAppPeer,
  finalizeManagedWhatsAppPairing,
  MANAGED_WHATSAPP_ACCOUNT_ID,
  pairingCandidate,
  prepareManagedWhatsAppPairing,
  whatsAppTemplatePending,
  whatsAppWindowOpen,
  withPendingWhatsAppTemplate,
  type ManagedWhatsAppPeerRoute,
  type ManagedWhatsAppPeerState,
} from "./managed-peer-state";
import {
  downloadWhatsAppMedia,
  lookupWhatsAppMedia,
  ManagedWhatsAppDeliveryError,
  markWhatsAppMessageRead,
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  WHATSAPP_WINDOW_CLOSED_ERROR,
  type ManagedWhatsAppFetch,
  type WhatsAppOutboundPayload,
  type WhatsAppSentMessage,
} from "./whatsapp-api";
import {
  renderWhatsAppText,
  whatsAppPromptMessages,
  whatsAppTextMessages,
} from "./whatsapp-formatting";
import { loadWhatsAppInboundMedia } from "./whatsapp-inbound-media";
import {
  sendWhatsAppMediaMessage,
  whatsAppCaptionFits,
  whatsAppMediaSupportsCaption,
} from "./whatsapp-outbound-media";
import {
  isManagedWhatsAppPairCommand,
  whatsAppDeliveryToken,
  type ManagedWhatsAppInbound,
  type ManagedWhatsAppPeerEvent,
  type WhatsAppTemplateTap,
} from "./whatsapp-webhook";

export interface ManagedWhatsAppPeerEnv extends ManagedWhatsAppPairingEnv, ManagedWhatsAppTemplateEnv {
  GATEWAY: Fetcher & AdapterGatewayBinding & ManagedWhatsAppPairingEnv["GATEWAY"];
  MANAGED_WHATSAPP_PAIRING: DurableObjectNamespace<ManagedWhatsAppPairing>;
  ACCOUNTS: InstallationDirectoryService;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_API?: Fetcher;
}

type InboundPayload =
  | {
      kind: "message";
      inbound: ManagedWhatsAppInbound;
      routeGeneration?: string;
    }
  | {
      kind: "approval";
      reply: Extract<ManagedWhatsAppPeerEvent, { kind: "approval" }>["reply"];
      routeGeneration?: string;
    }
  | {
      kind: "release";
      tap: WhatsAppTemplateTap;
      routeGeneration?: string;
    };

type ResponseContext =
  | { kind: "platform"; claimId?: string }
  | { kind: "installation"; installationId: string; generation: string };

type DeliveryOptions = {
  controls?: WhatsAppApprovalControls;
  /** What to keep when an approval prompt has to wait for the person's reply. */
  approval?: WhatsAppApprovalSource;
  /** False while releasing held messages, so a closed window never holds them again. */
  templateFallback?: boolean;
};
/** One provider message of a delivery; resolves to the WhatsApp message id it produced. */
type DeliveryPart = () => Promise<string | undefined>;
type ClaimedDelivery = Extract<DeliveryClaim, { claimed: true }>;
type FailDelivery = (kind: DeliveryFailureKind, detail?: string) => Promise<AdapterSendResult>;
type PairingIssue = { code: string; claimId: string; expiresAt: number };
type ManagedPairingStub = { initialize(input: ManagedWhatsAppPairingRecord): Promise<{ created: boolean }> };

const STATE_KEY = "managed_whatsapp_peer:v1:state";
const INBOUND_PREFIX = "managed_whatsapp_peer:v1:inbound:";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const INBOUND_WAKE_DELAY_MS = 25;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;
const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_MAX_RECORDS = 4_096;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CHARACTERS = 12;
const UNSUPPORTED_TEXT =
  "GSV WhatsApp could not receive that message type. Please send text, a photo, a document, a voice note or a location.";
const MEDIA_UNAVAILABLE_TEXT =
  "GSV WhatsApp could not receive that attachment. Please send a smaller file or try again.";

export class ManagedWhatsAppPeer extends DurableObject<ManagedWhatsAppPeerEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly lifecycle: AdapterPeerRetirement<ManagedWhatsAppPeerState>;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<InboundPayload, ResponseContext>;
  private readonly held: WhatsAppHeldOutbound;
  private drainPromise?: Promise<void>;

  constructor(ctx: DurableObjectState, env: ManagedWhatsAppPeerEnv) {
    super(ctx, env);
    runAdapterHilSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage, { retirement: this.retirement });
    this.held = new WhatsAppHeldOutbound(this.ctx.storage, { retirement: this.retirement });
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
      {
        retirement: this.retirement,
        completedRetentionMs: INBOUND_RETENTION_MS,
        maxRecords: INBOUND_MAX_RECORDS,
      },
    );
    this.lifecycle = new AdapterPeerRetirement(ctx.storage, this.retirement, {
      stateKey: STATE_KEY, inboundPrefix: INBOUND_PREFIX, inbound: this.inboundDeliveries,
      outbound: this.deliveries, hil: true, stores: [this.held],
      identity: (state) => ({ name: `managed:${state.surfaceId}`, understood: state.version === 1 && Boolean(state.actorId && state.surfaceId) }),
    });
  }

  async inspectInstallationResource(installationId: string) { return await this.lifecycle.inspect(installationId); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.quiesce(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.erase(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.lifecycle.status(input); }

  async handleWebhook(event: ManagedWhatsAppPeerEvent): Promise<{ ok: true }> {
    const identity = event.kind === "message"
      ? event.inbound
      : event.kind === "approval"
        ? { ...event.reply, messageId: event.reply.interactionId }
        : { ...event.tap, messageId: event.tap.interactionId };
    const route = await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      // A stray button from a number that never messaged has nothing to resolve.
      if (!state && event.kind !== "message") return { skip: true as const };
      const next = bindManagedWhatsAppPeerIdentity(state, identity, Date.now());
      await txn.put(STATE_KEY, next);
      return { skip: false as const, route: next.activeRoute };
    });
    if (route.skip || this.retirement.retired(route.route)) return { ok: true };
    const routeGeneration = route.route?.generation;
    let deliveryId: string;
    let payload: InboundPayload;
    if (event.kind === "message") {
      deliveryId = event.inbound.deliveryId;
      payload = { kind: "message", inbound: event.inbound, routeGeneration };
    } else if (event.kind === "approval") {
      deliveryId = `interactive:${whatsAppDeliveryToken(event.reply.interactionId)}`;
      payload = { kind: "approval", reply: event.reply, routeGeneration };
    } else {
      deliveryId = `release:${whatsAppDeliveryToken(event.tap.interactionId)}`;
      payload = { kind: "release", tap: event.tap, routeGeneration };
    }
    await this.inboundDeliveries.enqueueAndArm(
      deliveryId,
      payload,
      Date.now() + INBOUND_WAKE_DELAY_MS,
      route.route ?? null,
    );
    if (event.kind === "message" && isManagedWhatsAppPairCommand(event.inbound.text)) {
      await this.attemptInbound(deliveryId);
    }
    this.ctx.waitUntil(this.drainInbound());
    return { ok: true };
  }

  async sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    context?: AdapterDeliveryContext,
  ): Promise<AdapterSendResult> {
    let state: ManagedWhatsAppPeerState;
    try {
      state = await this.requireState();
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    const route = state.activeRoute;
    if (
      !route
      || route.installationId !== installationId
      || !message.routeGeneration
      || route.generation !== message.routeGeneration
    ) {
      await cancelBinaryBody(body, "WhatsApp route changed before delivery");
      return { ok: false, error: "WhatsApp route changed before delivery" };
    }
    try {
      this.retirement.requireLive(route);
      const approval = context?.hil ? describeWhatsAppApproval(context, context.hil) : null;
      const controls = approval ? await prepareWhatsAppApproval(this.ctx.storage, approval, route) : null;
      const renderedMessage = controls ? { ...message, text: controls.text } : message;
      const options: DeliveryOptions = {};
      if (approval && controls) {
        options.controls = controls;
        options.approval = approval;
      }
      const result = await this.deliverMessage(renderedMessage, {
        kind: "installation",
        installationId,
        generation: message.routeGeneration,
      }, body, options);
      // A prompt held behind a template reports no message id; the interactive
      // message is attached when the person's reply releases it.
      if (result.ok && controls) {
        await attachWhatsAppApprovalMessage(this.ctx.storage, controls.token, result.messageId);
      }
      return result;
    } catch (error) { await cancelBinaryBody(body, error); throw error; }
  }

  /** WhatsApp shows typing only as a companion to a read receipt for the person's last message. */
  async setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    routeGeneration: string,
    active: boolean,
  ): Promise<{ accepted: boolean }> {
    if (!active) return { accepted: true };
    const state = await this.requireState();
    this.assertPeerDestination(state, surface, actorId);
    if (
      state.activeRoute?.installationId !== installationId
      || state.activeRoute.generation !== routeGeneration
    ) {
      return { accepted: false };
    }
    if (!state.lastInboundMessageId) return { accepted: true };
    const owner = { installationId, generation: routeGeneration };
    const release = this.retirement.start(owner);
    try {
      await markWhatsAppMessageRead(
        this.accessToken(),
        this.phoneNumberId(),
        state.lastInboundMessageId,
        this.whatsAppFetch(owner),
        { typing: true },
      );
    } catch {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "typing_delivery_failed",
      }));
    }
    finally { release(); }
    return { accepted: true };
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
    return pairingCandidate(state, pairing.expiresAt);
  }

  async preparePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation> {
    const route: ManagedWhatsAppPeerRoute = {
      installationId: requireOpaque(input.installationId, "installationId"),
      localUid: requireLocalUid(input.localUid),
      generation: crypto.randomUUID(),
      canonicalOrigin: requireCanonicalOrigin(input.canonicalOrigin),
      linkedAt: Date.now(),
    };
    const current = await this.requireState();
    this.retirement.requireLive(route);
    await this.env.WHATSAPP_INSTALLATIONS.getByName(route.installationId).registerResource({ kind: "adapter-peer", name: `managed:${current.surfaceId}`, objectId: this.ctx.id.toString(), generation: route.generation });
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const existing = state.pairing?.preparedRoute;
      if (state.pairing?.operationId === input.operationId && existing && (existing.installationId !== route.installationId || existing.localUid !== route.localUid)) throw new Error("Pairing operation identity changed");
      const effectiveRoute = state.pairing?.operationId === input.operationId && existing
        ? existing
        : route;
      const prepared = prepareManagedWhatsAppPairing(state, {
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
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const activated = activateManagedWhatsAppPairing(state, {
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
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const finalized = finalizeManagedWhatsAppPairing(state, {
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
    if (!route || state.pairing?.operationId !== operationId) return;
    const result = await this.deliverMessage({
      deliveryId: `managed-paired:${operationId}`,
      surface: { kind: "dm", id: state.surfaceId },
      actorId: state.actorId,
      text: `Connected to ${requireCanonicalOrigin(canonicalOrigin)}`,
    }, {
      kind: "installation",
      installationId: route.installationId,
      generation: route.generation,
    });
    if (!result.ok && result.retryable) throw new Error("Pairing confirmation should be retried");
  }

  async disconnect(input: AdapterPairingDisconnectInput): Promise<{ disconnected: boolean }> {
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(input);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) return { disconnected: false };
      if (state.actorId !== input.actorId || state.surfaceId !== input.surfaceId) {
        throw new Error("Managed WhatsApp peer identity mismatch");
      }
      const result = disconnectManagedWhatsAppPeer(state, {
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
      for (const deliveryId of ids) {
        if (!await this.attemptInbound(deliveryId)) break;
      }
    })();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  private async attemptInbound(deliveryId: string): Promise<boolean> {
    const result = await this.inboundDeliveries.attempt(
      deliveryId,
      async (payload) => await this.forwardInbound(payload),
      async (message, context) => await this.deliverMessage(
        message,
        context ?? { kind: "platform" },
      ),
    );
    if (result.state !== "pending") return true;
    await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
    return false;
  }

  private async forwardInbound(
    payload: InboundPayload,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    if (payload.kind === "release") {
      const state = await this.requireState();
      const route = state.activeRoute;
      if (!route || this.retirement.retired(route) || !payload.routeGeneration || route.generation !== payload.routeGeneration) {
        return { terminal: true };
      }
      // The tap only reopens the window; the person hears nothing but the held messages.
      await this.markRead(payload.tap.interactionId, route);
      await this.releaseHeld(route);
      return { terminal: true };
    }
    if (payload.kind === "approval") {
      const state = await this.requireState();
      const route = state.activeRoute;
      if (!route || this.retirement.retired(route) || !payload.routeGeneration || route.generation !== payload.routeGeneration) {
        return { terminal: true };
      }
      await this.releaseHeld(route);
      const status = await handleWhatsAppApprovalReply(
        this.ctx.storage,
        this.env.GATEWAY,
        { installationId: route.installationId },
        payload.reply,
      );
      if (!status) return { terminal: true };
      return {
        terminal: true,
        responses: [{
          message: {
            deliveryId: `managed-approval:${whatsAppDeliveryToken(payload.reply.interactionId)}`,
            surface: { kind: "dm", id: payload.reply.surfaceId },
            actorId: payload.reply.actorId,
            text: status,
            replyToId: payload.reply.providerMessageId,
          },
          context: { kind: "installation", installationId: route.installationId, generation: route.generation },
        }],
      };
    }
    const { inbound } = payload;
    const state = await this.requireState();
    if (inbound.unsupportedContent) {
      return platformResponse(inbound, `managed-unsupported:${inbound.deliveryId}`, UNSUPPORTED_TEXT);
    }
    if (!payload.routeGeneration || isManagedWhatsAppPairCommand(inbound.text)) {
      return await this.pairingResponse(inbound);
    }
    const route = state.activeRoute;
    if (!route || this.retirement.retired(route) || route.generation !== payload.routeGeneration) {
      return { terminal: true };
    }
    await this.markRead(inbound.messageId, route);
    // The person's message reopened the window: held replies go out first, then theirs is relayed.
    await this.releaseHeld(route);

    const transfer = await loadWhatsAppInboundMedia(inbound.media ?? [], {
      lookupMedia: async (mediaId) => await lookupWhatsAppMedia(
        this.accessToken(),
        mediaId,
        this.phoneNumberId(),
        this.whatsAppFetch(route),
      ),
      downloadMedia: async (url, expectedSize, maxBytes) => await downloadWhatsAppMedia(
        this.accessToken(),
        url,
        expectedSize,
        maxBytes,
        this.whatsAppFetch(route),
      ),
    });
    if (inbound.media?.length && transfer.media.length === 0) {
      return platformResponse(
        inbound,
        `managed-media-unavailable:${inbound.deliveryId}`,
        MEDIA_UNAVAILABLE_TEXT,
      );
    }

    const current = await this.requireState();
    const currentRoute = current.activeRoute;
    if (
      !currentRoute
      || this.retirement.retired(route)
      || currentRoute.installationId !== route.installationId
      || currentRoute.generation !== route.generation
    ) {
      await cancelBinaryBody(transfer.body, "WhatsApp route changed before media delivery");
      return { terminal: true };
    }

    const result = await callAdapterGateway(
      this.env.GATEWAY,
      { installationId: route.installationId },
      "adapter.inbound",
      {
        adapter: "whatsapp",
        accountId: MANAGED_WHATSAPP_ACCOUNT_ID,
        deliveryId: inbound.deliveryId,
        routeGeneration: route.generation,
        message: {
          messageId: inbound.messageId,
          surface: {
            kind: "dm",
            id: inbound.surfaceId,
            name: current.actorName,
            handle: current.actorHandle,
          },
          actor: {
            id: inbound.actorId,
            name: current.actorName,
            handle: current.actorHandle,
          },
          text: inbound.text,
          media: transfer.media.length > 0 ? transfer.media : undefined,
          replyToId: inbound.replyToId,
          timestamp: inbound.timestamp,
          wasMentioned: true,
        },
      },
      transfer.body,
    );
    if (this.retirement.retired(route)) return { terminal: true };
    if (result.challenge) return await this.pairingResponse(inbound);
    const disposition = adapterInboundResultDisposition(result, {
      surface: { kind: "dm", id: inbound.surfaceId },
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
          },
        })),
    };
  }

  private async pairingResponse(
    inbound: ManagedWhatsAppInbound,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    const state = await this.requireState();
    if (
      state.pairing
      && (state.pairing.status === "prepared" || state.pairing.status === "active")
      && state.pairing.expiresAt > Date.now()
    ) {
      return platformResponse(
        inbound,
        `managed-pairing-in-progress:${state.pairing.claimId}:${inbound.deliveryId}`,
        "This WhatsApp connection is still being confirmed in GSV. Finish or retry that confirmation, then send your message again.",
        state.pairing.claimId,
      );
    }
    const issue = await this.issuePairing();
    return {
      terminal: true,
      responses: [{
        message: {
          deliveryId: `managed-pair:${issue.claimId}:${inbound.deliveryId}`,
          surface: { kind: "dm", id: inbound.surfaceId },
          actorId: inbound.actorId,
          text: [
            "Connect this WhatsApp number to your GSV.",
            "",
            `Pairing code: ${formatPairingCode(issue.code)}`,
            "",
            "Open GSV → Settings → Messengers → WhatsApp, enter the code, and confirm the identity shown there.",
            "This code expires in 10 minutes.",
          ].join("\n"),
          replyToId: inbound.messageId,
        },
        expiresAt: issue.expiresAt,
        context: { kind: "platform", claimId: issue.claimId },
      }],
    };
  }

  private async issuePairing(): Promise<PairingIssue> {
    const now = Date.now();
    const state = await this.requireState();
    const current = state.pairing;
    if (current?.status === "pending" && current.expiresAt > now) {
      return { code: current.code, claimId: current.claimId, expiresAt: current.expiresAt };
    }

    const claimId = crypto.randomUUID();
    const expiresAt = now + PAIRING_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createPairingCode();
      const pairing = this.pairing(code);
      const initialized = await pairing.initialize({
        version: 1,
        claimId,
        surfaceId: state.surfaceId,
        expiresAt,
      } satisfies ManagedWhatsAppPairingRecord);
      if (!initialized.created) continue;
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
        if (!latest) throw new Error("Managed WhatsApp peer is not initialized");
        await txn.put(STATE_KEY, {
          ...latest,
          pairing: {
            claimId,
            code,
            expiresAt,
            status: "pending",
          },
        } satisfies ManagedWhatsAppPeerState);
      });
      return { code, claimId, expiresAt };
    }
    throw new Error("Could not allocate a WhatsApp pairing code");
  }

  private async deliverMessage(
    message: AdapterOutboundMessage,
    context: ResponseContext,
    body?: BinaryBody,
    options: DeliveryOptions = {},
  ): Promise<AdapterSendResult> {
    const owner = context.kind === "installation" ? context : null;
    let release: () => void;
    try { release = this.retirement.start(owner); }
    catch (error) { await cancelBinaryBody(body, error); throw error; }
    try { return await this.deliverOwnedMessage(message, context, owner, body, options); }
    finally { release(); }
  }

  private async deliverOwnedMessage(
    message: AdapterOutboundMessage, context: ResponseContext, owner: AdapterDataScope,
    body?: BinaryBody, options: DeliveryOptions = {},
  ): Promise<AdapterSendResult> {
    try {
      const state = await this.requireState();
      this.assertPeerDestination(state, message.surface, message.actorId);
      this.assertDeliveryContext(state, context);
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    const text = message.text.trim();
    const media = message.media ?? [];
    if (!text && media.length === 0) {
      await cancelBinaryBody(body, "Managed WhatsApp requires text or media");
      return { ok: false, error: "Managed WhatsApp requires text or media" };
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
        error: error instanceof Error ? error.message : "WhatsApp media body is invalid",
      };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        signal: owner ? this.retirement.signal(owner) : undefined,
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch {
      return { ok: false, error: "Could not read WhatsApp media body", retryable: true };
    }

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery(
        whatsAppFingerprintMessage(message, options),
        mediaBytes,
      );
    } catch {
      return { ok: false, error: "Could not fingerprint WhatsApp delivery", retryable: true };
    }
    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, fingerprint, owner);
    } catch {
      return { ok: false, error: "WhatsApp delivery ledger unavailable", retryable: true };
    }
    if (!claim.claimed) return claim.result;

    const fail = async (kind: DeliveryFailureKind, detail?: string): Promise<AdapterSendResult> => {
      const error = detail ?? `WhatsApp delivery failed (${kind})`;
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

    // Outside the customer service window Meta accepts only the template. The
    // Kernel's own deliveries take that path; released held messages and
    // platform responses do not, so a closed window never holds them again.
    const fallbackOwner = owner !== null && options.templateFallback !== false ? owner : null;
    let sentInAttempt = 0;
    try {
      const current = await this.requireState();
      this.assertPeerDestination(current, message.surface, message.actorId);
      this.assertDeliveryContext(current, context);
      if (!whatsAppWindowOpen(current, Date.now())) {
        if (!fallbackOwner) return await fail("permanent", WHATSAPP_WINDOW_CLOSED_ERROR);
        return await this.deliverOutsideWindow(message, fallbackOwner, claim, options, fail);
      }
      // Replies still held behind a template go out first so the person reads them in order.
      if (fallbackOwner) await this.releaseHeld(fallbackOwner);
      const token = this.accessToken();
      const phoneNumberId = this.phoneNumberId();
      const fetcher = this.whatsAppFetch(owner);
      const to = current.surfaceId;
      const replyToId = whatsAppMessageId(message.replyToId);
      // Only the first provider message quotes the inbound message.
      const send = async (payload: WhatsAppOutboundPayload, index: number): Promise<WhatsAppSentMessage> => {
        const quoted = index === 0 && replyToId ? { ...payload, context: { message_id: replyToId } } : payload;
        return await sendWhatsAppMessage(token, phoneNumberId, quoted, fetcher);
      };
      const parts: DeliveryPart[] = [];
      const addPart = (part: (index: number) => Promise<WhatsAppSentMessage>): void => {
        const index = parts.length;
        parts.push(async () => (await part(index)).messageId);
      };
      const addText = (body: string): void => {
        addPart((index) => send({ to, type: "text", text: { preview_url: false, body } }, index));
      };
      // The provider id reported for the delivery: the message that carries
      // the approval buttons when there are any, otherwise the first message.
      let anchor = 0;
      if (options.controls) {
        const controls = options.controls;
        const prompts = whatsAppPromptMessages(controls.text, WHATSAPP_INTERACTIVE_BODY_LIMIT);
        for (const prompt of prompts.slice(0, -1)) addText(prompt);
        const last = prompts.at(-1) ?? controls.text;
        addPart((index) => send(buildWhatsAppInteractivePayload(to, { ...controls, text: last }), index));
        anchor = parts.length - 1;
      } else if (media.length === 0) {
        for (const body of whatsAppTextMessages(text)) addText(body);
      } else {
        const rendered = renderWhatsAppText(text);
        const captionOnFirst = Boolean(rendered)
          && whatsAppMediaSupportsCaption(media[0]!.type)
          && whatsAppCaptionFits(rendered);
        if (rendered && !captionOnFirst) {
          for (const body of whatsAppTextMessages(text)) addText(body);
        }
        const upload = (bytes: Uint8Array, mimeType: string, filename: string) =>
          uploadWhatsAppMedia(token, phoneNumberId, bytes, mimeType, filename, fetcher);
        for (const [mediaIndex, item] of media.entries()) {
          addPart((index) => sendWhatsAppMediaMessage(
            { upload, send: (payload) => send(payload, index) },
            to,
            item,
            mediaBytes[mediaIndex],
            mediaIndex === 0 && captionOnFirst ? rendered : undefined,
          ));
        }
      }

      // Every accepted part is recorded before the next provider call, so a
      // retry of this delivery resumes after the parts the person already has.
      let anchorMessageId = claim.progress.messageId;
      for (let index = claim.progress.sent; index < parts.length; index += 1) {
        if (sentInAttempt > 0) await this.typingBetweenParts(current, fetcher);
        const messageId = await parts[index]!();
        sentInAttempt += 1;
        if (index === anchor) anchorMessageId = messageId;
        await this.deliveries.recordProgress(message.deliveryId, claim.attemptId, {
          sent: index + 1,
          messageId: anchorMessageId,
        });
      }
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, anchorMessageId);
      return { ok: true, messageId: anchorMessageId };
    } catch (error) {
      if (error instanceof ManagedWhatsAppDeliveryError) {
        // Meta knows the window better than the local receipt: when it refuses
        // the first part, the template path takes the whole message.
        if (error.windowClosed && fallbackOwner && sentInAttempt === 0 && claim.progress.sent === 0) {
          return await this.deliverOutsideWindow(message, fallbackOwner, claim, options, fail);
        }
        // A definite rejection resumes at the first unsent part on retry; an
        // unknown provider outcome stays ambiguous and is never replayed.
        return await fail(error.kind, error.message);
      }
      return await fail("permanent");
    }
  }

  /**
   * Meta accepts only a pre-approved template outside the customer service
   * window. A message that fits the template's parameter travels inside it; a
   * longer one, or an approval prompt whose buttons the template cannot carry,
   * waits until the person's reply reopens the window. One template at a
   * time: while one is pending, further messages wait behind it instead of
   * each sending a template.
   */
  private async deliverOutsideWindow(
    message: AdapterOutboundMessage,
    owner: AdapterDataOwner,
    claim: ClaimedDelivery,
    options: DeliveryOptions,
    fail: FailDelivery,
  ): Promise<AdapterSendResult> {
    const template = managedWhatsAppTemplate(this.env);
    if (!template) return await fail("permanent", WHATSAPP_NO_TEMPLATE_ERROR);
    if (message.media?.length) return await fail("permanent", WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR);
    const now = Date.now();
    const state = await this.requireState();
    const pending = whatsAppTemplatePending(state, now);
    const parameter = flattenWhatsAppTemplateParameter(message.text);
    // An approval prompt always waits: the template cannot carry its buttons.
    const complete = parameter.complete && !options.approval;
    if (!complete || pending) {
      const input: HeldOutboundInput = { deliveryId: message.deliveryId, owner, markdown: message.text };
      if (message.replyToId) input.replyToId = message.replyToId;
      if (options.approval) input.approval = options.approval;
      const held = await this.held.hold(input);
      if (!held.held && held.reason === "full") return await fail("permanent", WHATSAPP_HELD_FULL_ERROR);
      if (!held.held && held.reason === "too-long") return await fail("permanent", WHATSAPP_HELD_TOO_LONG_ERROR);
    }
    if (pending) {
      await this.deliveries.succeed(message.deliveryId, claim.attemptId);
      return { ok: true };
    }
    let sent: WhatsAppSentMessage;
    try {
      sent = await sendWhatsAppMessage(
        this.accessToken(),
        this.phoneNumberId(),
        buildWhatsAppTemplatePayload(state.surfaceId, template, parameter.text),
        this.whatsAppFetch(owner),
      );
    } catch (error) {
      const kind = error instanceof ManagedWhatsAppDeliveryError ? error.kind : "permanent";
      // A template Meta refuses for good fails on retry too; its held copy goes with it.
      if (kind === "permanent" && !complete) await this.held.remove(message.deliveryId);
      return await fail(kind, error instanceof ManagedWhatsAppDeliveryError ? error.message : undefined);
    }
    await this.ctx.storage.transaction(async (txn) => {
      const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      // A message from the person that arrived meanwhile already answered this template.
      if (!latest || latest.lastInboundMessageId !== state.lastInboundMessageId) return;
      await txn.put(STATE_KEY, withPendingWhatsAppTemplate(latest, now, sent.messageId));
    });
    // A held prompt reports no id: its approval attaches to the interactive
    // message that the person's reply releases.
    const messageId = options.approval ? undefined : sent.messageId;
    await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
    return messageId ? { ok: true, messageId } : { ok: true };
  }

  /** Sends the messages held behind a template once the person's reply reopened the window. */
  private async releaseHeld(owner: AdapterDataOwner): Promise<void> {
    let held: HeldOutboundRecord[];
    try {
      held = await this.held.list(owner);
    } catch {
      return;
    }
    for (const record of held) {
      let result: AdapterSendResult;
      try {
        result = await this.deliverHeld(record, owner);
      } catch {
        console.warn(JSON.stringify({
          component: "managed_whatsapp",
          event: "held_release_failed",
        }));
        return;
      }
      // A retryable failure keeps this message and the ones after it for the next reply.
      if (!result.ok && result.retryable) return;
      if (!result.ok) {
        console.warn(JSON.stringify({
          component: "managed_whatsapp",
          event: "held_release_rejected",
        }));
      }
      await this.held.remove(record.deliveryId);
    }
  }

  private async deliverHeld(record: HeldOutboundRecord, owner: AdapterDataOwner): Promise<AdapterSendResult> {
    const state = await this.requireState();
    const message: AdapterOutboundMessage = {
      deliveryId: `${record.deliveryId}:held`,
      surface: { kind: "dm", id: state.surfaceId },
      actorId: state.actorId,
      routeGeneration: owner.generation,
      text: record.markdown,
    };
    if (record.replyToId) message.replyToId = record.replyToId;
    const controls = record.approval
      ? await prepareWhatsAppApproval(this.ctx.storage, record.approval, owner)
      : null;
    const options: DeliveryOptions = { templateFallback: false };
    if (controls) options.controls = controls;
    const result = await this.deliverMessage(
      controls ? { ...message, text: controls.text } : message,
      { kind: "installation", installationId: owner.installationId, generation: owner.generation },
      undefined,
      options,
    );
    if (result.ok && controls) {
      await attachWhatsAppApprovalMessage(this.ctx.storage, controls.token, result.messageId);
    }
    return result;
  }

  /** WhatsApp shows typing only as a companion to the read receipt of the person's last message. */
  private async typingBetweenParts(state: ManagedWhatsAppPeerState, fetcher: ManagedWhatsAppFetch): Promise<void> {
    if (!state.lastInboundMessageId) return;
    try {
      await markWhatsAppMessageRead(
        this.accessToken(),
        this.phoneNumberId(),
        state.lastInboundMessageId,
        fetcher,
        { typing: true },
      );
    } catch {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "typing_delivery_failed",
      }));
    }
  }

  private async markRead(messageId: string, route: ManagedWhatsAppPeerRoute): Promise<void> {
    try {
      await markWhatsAppMessageRead(this.accessToken(), this.phoneNumberId(), messageId, this.whatsAppFetch(route));
    } catch {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "read_receipt_failed",
      }));
    }
  }

  private assertDeliveryContext(state: ManagedWhatsAppPeerState, context: ResponseContext): void {
    if (context.kind === "installation") {
      this.retirement.requireLive(context);
      if (
        state.activeRoute?.installationId !== context.installationId
        || state.activeRoute.generation !== context.generation
      ) {
        throw new Error("WhatsApp route changed before delivery");
      }
      return;
    }
    if (context.claimId && state.pairing?.claimId !== context.claimId) {
      throw new Error("WhatsApp pairing changed before delivery");
    }
  }

  private assertPeerDestination(
    state: ManagedWhatsAppPeerState,
    surface: AdapterSurface,
    actorId: string | undefined,
  ): void {
    if (surface.kind !== "dm" || surface.id !== state.surfaceId || actorId !== state.actorId) {
      throw new Error("WhatsApp destination does not match this peer");
    }
  }

  private async requireState(): Promise<ManagedWhatsAppPeerState> {
    const state = await this.ctx.storage.get<ManagedWhatsAppPeerState>(STATE_KEY);
    if (!state) throw new Error("Managed WhatsApp peer is not initialized");
    return state;
  }

  private pairing(code: string): ManagedPairingStub {
    const id = this.env.MANAGED_WHATSAPP_PAIRING.idFromName(`pair:${code}`);
    return typedStub<ManagedPairingStub, DurableObjectStub<undefined>>(this.env.MANAGED_WHATSAPP_PAIRING.get(id));
  }

  private accessToken(): string {
    const value = this.env.WHATSAPP_ACCESS_TOKEN?.trim();
    if (!value) throw new Error("Managed WhatsApp access token is not configured");
    return value;
  }

  private phoneNumberId(): string {
    const value = this.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!value || !/^[0-9]{1,32}$/.test(value)) {
      throw new Error("Managed WhatsApp phone number id is not configured");
    }
    return value;
  }

  private whatsAppFetch(owner: AdapterDataScope = null): ManagedWhatsAppFetch {
    return (input, init) => {
      this.retirement.requireLive(owner);
      const signal = owner ? this.retirement.signal(owner) : undefined;
      const request = { ...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal };
      return this.env.WHATSAPP_API ? this.env.WHATSAPP_API.fetch(input, request) : fetch(input, request);
    };
  }
}

function whatsAppFingerprintMessage(
  message: AdapterOutboundMessage,
  options: DeliveryOptions,
): AdapterOutboundMessage {
  if (!options.controls) return message;
  return {
    ...message,
    text: `${message.text}\n\n[gsv-whatsapp-controls:${JSON.stringify(options.controls.buttons)}]`,
  };
}

function typedStub<T, V = T>(value: V): T {
  // SAFETY: The Durable Object namespace binding owns the declared RPC contract.
  return value as T & V;
}

function platformResponse(
  inbound: ManagedWhatsAppInbound,
  deliveryId: string,
  text: string,
  claimId?: string,
): InboundDeliveryDisposition<ResponseContext> {
  return {
    terminal: true,
    responses: [{
      message: {
        deliveryId,
        surface: { kind: "dm", id: inbound.surfaceId },
        actorId: inbound.actorId,
        text,
        replyToId: inbound.messageId,
      },
      context: { kind: "platform", claimId },
    }],
  };
}

function createPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CHARACTERS));
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
}

function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function whatsAppMessageId(value: string | undefined): string | undefined {
  return value && whatsAppDeliveryToken(value) ? value : undefined;
}

function routeWithOrigin(
  route: AdapterPairingRoute,
  canonicalOrigin: string,
): ManagedWhatsAppPeerRoute {
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
