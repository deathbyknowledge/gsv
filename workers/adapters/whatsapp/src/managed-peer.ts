import { AdapterRetirement, type AdapterDataScope } from "../../shared/src/retirement";
import { AdapterPeerRetirement } from "../../shared/src/peer-retirement";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { InstallationDirectoryService } from "../../../../packages/gsv/src/services/directory.js";
import type { ManagedWhatsAppPairing } from "./managed-pairing";
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
  handleWhatsAppApprovalReply,
  prepareWhatsAppApproval,
  type WhatsAppApprovalControls,
} from "./whatsapp-approval";
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
  whatsAppWindowOpen,
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
} from "./whatsapp-api";
import { renderWhatsAppText, splitWhatsAppText } from "./whatsapp-formatting";
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
} from "./whatsapp-webhook";

export interface ManagedWhatsAppPeerEnv extends ManagedWhatsAppPairingEnv {
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
    };

type ResponseContext =
  | { kind: "platform"; claimId?: string }
  | { kind: "installation"; installationId: string; generation: string };

type DeliveryOptions = { controls?: WhatsAppApprovalControls };
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
  private drainPromise?: Promise<void>;

  constructor(ctx: DurableObjectState, env: ManagedWhatsAppPeerEnv) {
    super(ctx, env);
    runAdapterHilSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage, { retirement: this.retirement });
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
      outbound: this.deliveries, hil: true,
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
      : { ...event.reply, messageId: event.reply.interactionId };
    const route = await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      // A stray button reply from a number that never messaged has nothing to resolve.
      if (!state && event.kind === "approval") return { skip: true as const };
      const next = bindManagedWhatsAppPeerIdentity(state, identity, Date.now());
      await txn.put(STATE_KEY, next);
      return { skip: false as const, route: next.activeRoute };
    });
    if (route.skip || this.retirement.retired(route.route)) return { ok: true };
    const routeGeneration = route.route?.generation;
    const deliveryId = event.kind === "message"
      ? event.inbound.deliveryId
      : `interactive:${whatsAppDeliveryToken(event.reply.interactionId)}`;
    await this.inboundDeliveries.enqueueAndArm(
      deliveryId,
      event.kind === "message"
        ? { kind: "message", inbound: event.inbound, routeGeneration }
        : { kind: "approval", reply: event.reply, routeGeneration },
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
      const controls = context?.hil
        ? await prepareWhatsAppApproval(this.ctx.storage, context, context.hil, route)
        : null;
      const renderedMessage = controls ? { ...message, text: controls.text } : message;
      const result = await this.deliverMessage(renderedMessage, {
        kind: "installation",
        installationId,
        generation: message.routeGeneration,
      }, body, controls ? { controls } : {});
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
    if (payload.kind === "approval") {
      const state = await this.requireState();
      const route = state.activeRoute;
      if (!route || this.retirement.retired(route) || !payload.routeGeneration || route.generation !== payload.routeGeneration) {
        return { terminal: true };
      }
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

    let acceptedProviderDeliveries = 0;
    try {
      const current = await this.requireState();
      this.assertPeerDestination(current, message.surface, message.actorId);
      this.assertDeliveryContext(current, context);
      // Free-form messages are refused by Meta outside the customer service
      // window. Fail before provider I/O so the Process receives the exact reason.
      if (!whatsAppWindowOpen(current, Date.now())) {
        return await fail("permanent", WHATSAPP_WINDOW_CLOSED_ERROR);
      }
      const token = this.accessToken();
      const phoneNumberId = this.phoneNumberId();
      const fetcher = this.whatsAppFetch(owner);
      const to = current.surfaceId;
      let replyToId = whatsAppMessageId(message.replyToId);
      let messageId: string | undefined;
      const send = async (payload: WhatsAppOutboundPayload): Promise<{ messageId?: string }> => {
        const withContext = replyToId ? { ...payload, context: { message_id: replyToId } } : payload;
        replyToId = undefined;
        const sent = await sendWhatsAppMessage(token, phoneNumberId, withContext, fetcher);
        acceptedProviderDeliveries += 1;
        messageId ??= sent.messageId;
        return sent;
      };
      const sendText = async (value: string): Promise<void> => {
        for (const chunk of splitWhatsAppText(value)) {
          await send({ to, type: "text", text: { preview_url: false, body: chunk } });
        }
      };

      if (options.controls) {
        await send(buildWhatsAppInteractivePayload(to, options.controls));
      } else if (media.length === 0) {
        await sendText(renderWhatsAppText(text));
      } else {
        const rendered = renderWhatsAppText(text);
        const captionOnFirst = Boolean(rendered)
          && whatsAppMediaSupportsCaption(media[0]!.type)
          && whatsAppCaptionFits(rendered);
        if (rendered && !captionOnFirst) await sendText(rendered);
        const graph = {
          upload: (bytes: Uint8Array, mimeType: string, filename: string) =>
            uploadWhatsAppMedia(token, phoneNumberId, bytes, mimeType, filename, fetcher),
          send,
        };
        for (const [index, item] of media.entries()) {
          await sendWhatsAppMediaMessage(
            graph,
            to,
            item,
            mediaBytes[index],
            index === 0 && captionOnFirst ? rendered : undefined,
          );
        }
      }
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
      return { ok: true, messageId };
    } catch (error) {
      if (acceptedProviderDeliveries > 0) return await fail("ambiguous");
      if (error instanceof ManagedWhatsAppDeliveryError) return await fail(error.kind, error.message);
      return await fail("permanent");
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
