import { DurableObject } from "cloudflare:workers";
import {
  MANAGED_TELEGRAM_ACCOUNT_ID,
} from "../../../packages/gsv/src/protocol/adapters.js";
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
  attachTelegramApprovalMessage,
  handleTelegramApprovalCallback,
  prepareTelegramApproval,
} from "./telegram-approval";
import type { TelegramTextMessageOptions } from "./telegram-formatting";
import type {
  ManagedTelegramPairingEnv,
  ManagedTelegramPairingRecord,
} from "./managed-pairing";
import {
  activateManagedTelegramPairing,
  bindManagedTelegramPeerIdentity,
  disconnectManagedTelegramPeer,
  finalizeManagedTelegramPairing,
  pairingCandidate,
  prepareManagedTelegramPairing,
  type ManagedTelegramPeerRoute,
  type ManagedTelegramPeerState,
} from "./managed-peer-state";
import {
  callManagedTelegramApi,
  downloadManagedTelegramFile,
  getManagedTelegramFile,
  ManagedTelegramDeliveryError,
  sendManagedTelegramText,
  setManagedTelegramTyping,
  type ManagedTelegramFetch,
} from "./managed-telegram-api";
import { loadTelegramInboundMedia } from "./telegram-inbound-media";
import { planTelegramMediaDeliveries } from "./telegram-media";
import {
  sendTelegramMediaGroupMessage,
  sendTelegramMediaMessage,
} from "./telegram-outbound-media";
import {
  isManagedTelegramPairCommand,
  type ManagedTelegramInbound,
  type ManagedTelegramPeerEvent,
} from "./managed-update";

export interface ManagedTelegramPeerEnv extends ManagedTelegramPairingEnv {
  GATEWAY: Fetcher & AdapterGatewayBinding & ManagedTelegramPairingEnv["GATEWAY"];
  MANAGED_TELEGRAM_PAIRING: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_API?: Fetcher;
}

type InboundPayload =
  | {
      kind: "message";
      inbound: ManagedTelegramInbound;
      routeGeneration?: string;
    }
  | {
      kind: "approval";
      callback: Extract<ManagedTelegramPeerEvent, { kind: "approval" }>["callback"];
      routeGeneration?: string;
    };

type ResponseContext =
  | { kind: "platform"; claimId?: string }
  | { kind: "installation"; installationId: string; generation: string };

type PairingIssue = { code: string; claimId: string; expiresAt: number };
type ManagedPairingStub = { initialize(input: ManagedTelegramPairingRecord): Promise<{ created: boolean }> };
type TelegramApiPayload = Parameters<typeof callManagedTelegramApi>[2];

const STATE_KEY = "managed_telegram_peer:v1:state";
const INBOUND_PREFIX = "managed_telegram_peer:v1:inbound:";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const INBOUND_WAKE_DELAY_MS = 25;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;
const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_MAX_RECORDS = 4_096;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CHARACTERS = 12;
const UNSUPPORTED_TEXT =
  "GSV Telegram could not receive that message type. Please send text or a supported attachment.";
const MEDIA_UNAVAILABLE_TEXT =
  "GSV Telegram could not receive that attachment. Please send a smaller file or try again.";

export class ManagedTelegramPeer extends DurableObject<ManagedTelegramPeerEnv> {
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<InboundPayload, ResponseContext>;
  private drainPromise?: Promise<void>;

  constructor(ctx: DurableObjectState, env: ManagedTelegramPeerEnv) {
    super(ctx, env);
    runAdapterHilSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
      {
        completedRetentionMs: INBOUND_RETENTION_MS,
        maxRecords: INBOUND_MAX_RECORDS,
        pendingOrder: "key",
      },
    );
  }

  async handleWebhook(event: ManagedTelegramPeerEvent): Promise<{ ok: true }> {
    const routeGeneration = event.kind === "message"
      ? await this.ctx.storage.transaction(async (txn) => {
          const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
          const next = bindManagedTelegramPeerIdentity(state, event.inbound);
          await txn.put(STATE_KEY, next);
          return next.activeRoute?.generation;
        })
      : (await this.requireState()).activeRoute?.generation;
    const deliveryId = event.kind === "message"
      ? event.inbound.deliveryId
      : `callback:${event.callback.callbackQueryId}`;
    await this.inboundDeliveries.enqueueAndArm(
      deliveryId,
      event.kind === "message"
        ? { kind: "message", inbound: event.inbound, routeGeneration }
        : { kind: "approval", callback: event.callback, routeGeneration },
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    if (event.kind === "message" && isManagedTelegramPairCommand(event.inbound.text)) {
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
    let state: ManagedTelegramPeerState;
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
      await cancelBinaryBody(body, "Telegram route changed before delivery");
      return { ok: false, error: "Telegram route changed before delivery" };
    }
    const controls = context?.hil
      ? await prepareTelegramApproval(this.ctx.storage, context, context.hil)
      : null;
    const renderedMessage = controls ? { ...message, text: controls.text } : message;
    const result = await this.deliverMessage(renderedMessage, {
      kind: "installation",
      installationId,
      generation: message.routeGeneration,
    }, body, controls ? { replyMarkup: controls.replyMarkup } : {});
    if (result.ok && controls) {
      await attachTelegramApprovalMessage(this.ctx.storage, controls.token, result.messageId);
    }
    return result;
  }

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
    try {
      await setManagedTelegramTyping(this.botToken(), state.surfaceId, this.telegramFetch());
    } catch {
      console.warn(JSON.stringify({
        component: "managed_telegram",
        event: "typing_delivery_failed",
      }));
    }
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
    const route: ManagedTelegramPeerRoute = {
      installationId: requireOpaque(input.installationId, "installationId"),
      localUid: requireLocalUid(input.localUid),
      generation: crypto.randomUUID(),
      canonicalOrigin: requireCanonicalOrigin(input.canonicalOrigin),
      linkedAt: Date.now(),
    };
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const existing = state.pairing?.preparedRoute;
      const effectiveRoute = state.pairing?.operationId === input.operationId && existing
        ? existing
        : route;
      const prepared = prepareManagedTelegramPairing(state, {
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
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const activated = activateManagedTelegramPairing(state, {
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
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const finalized = finalizeManagedTelegramPairing(state, {
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
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) return { disconnected: false };
      if (state.actorId !== input.actorId || state.surfaceId !== input.surfaceId) {
        throw new Error("Managed Telegram peer identity mismatch");
      }
      const result = disconnectManagedTelegramPeer(state, {
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
      if (!route || !payload.routeGeneration || route.generation !== payload.routeGeneration) {
        return { terminal: true };
      }
      const token = this.botToken();
      const fetcher = this.telegramFetch();
      await handleTelegramApprovalCallback(
        this.ctx.storage,
        this.env.GATEWAY,
        { installationId: route.installationId },
        payload.callback,
        {
          answerCallbackQuery: async (callbackQueryId, text) => {
            await callManagedTelegramApi<boolean>(token, "answerCallbackQuery", {
              callback_query_id: callbackQueryId,
              text,
            }, fetcher);
          },
          replaceMessage: async (surfaceId, providerMessageId, text) => {
            await callManagedTelegramApi<unknown>(token, "editMessageText", {
              chat_id: surfaceId,
              message_id: Number.parseInt(providerMessageId, 10),
              text,
              reply_markup: { inline_keyboard: [] },
            }, fetcher);
          },
        },
      );
      return { terminal: true };
    }
    const { inbound } = payload;
    const state = await this.requireState();
    if (inbound.unsupportedContent) {
      return platformResponse(inbound, `managed-unsupported:${inbound.deliveryId}`, UNSUPPORTED_TEXT);
    }
    if (!payload.routeGeneration || isManagedTelegramPairCommand(inbound.text)) {
      return await this.pairingResponse(inbound);
    }
    const route = state.activeRoute;
    if (!route || route.generation !== payload.routeGeneration) {
      return { terminal: true };
    }

    const transfer = await loadTelegramInboundMedia(inbound.media ?? [], {
      getFile: async (fileId) => await getManagedTelegramFile(
        this.botToken(),
        fileId,
        this.telegramFetch(),
      ),
      downloadFile: async (filePath, expectedSize, maxBytes) =>
        await downloadManagedTelegramFile(
          this.botToken(),
          filePath,
          expectedSize,
          maxBytes,
          this.telegramFetch(),
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
      || currentRoute.installationId !== route.installationId
      || currentRoute.generation !== route.generation
    ) {
      await cancelBinaryBody(transfer.body, "Telegram route changed before media delivery");
      return { terminal: true };
    }

    const result = await callAdapterGateway(
      this.env.GATEWAY,
      { installationId: route.installationId },
      "adapter.inbound",
      {
        adapter: "telegram",
        accountId: MANAGED_TELEGRAM_ACCOUNT_ID,
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
    inbound: ManagedTelegramInbound,
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
        "This Telegram connection is still being confirmed in GSV. Finish or retry that confirmation, then send your message again.",
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
            "Connect this Telegram identity to your GSV.",
            "",
            `Pairing code: ${formatPairingCode(issue.code)}`,
            "",
            "Open GSV → Messengers → Telegram, enter the code, and confirm the identity shown there.",
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
      } satisfies ManagedTelegramPairingRecord);
      if (!initialized.created) continue;
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
        if (!latest) throw new Error("Managed Telegram peer is not initialized");
        await txn.put(STATE_KEY, {
          ...latest,
          pairing: {
            claimId,
            code,
            expiresAt,
            status: "pending",
          },
        } satisfies ManagedTelegramPeerState);
      });
      return { code, claimId, expiresAt };
    }
    throw new Error("Could not allocate a Telegram pairing code");
  }

  private async deliverMessage(
    message: AdapterOutboundMessage,
    context: ResponseContext,
    body?: BinaryBody,
    options: TelegramTextMessageOptions = {},
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
      await cancelBinaryBody(body, "Managed Telegram requires text or media");
      return { ok: false, error: "Managed Telegram requires text or media" };
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
        error: error instanceof Error ? error.message : "Telegram media body is invalid",
      };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch {
      return { ok: false, error: "Could not read Telegram media body", retryable: true };
    }

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery(
        telegramFingerprintMessage(message, options),
        mediaBytes,
      );
    } catch {
      return { ok: false, error: "Could not fingerprint Telegram delivery", retryable: true };
    }
    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, fingerprint);
    } catch {
      return { ok: false, error: "Telegram delivery ledger unavailable", retryable: true };
    }
    if (!claim.claimed) return claim.result;

    const fail = async (kind: DeliveryFailureKind): Promise<AdapterSendResult> => {
      const error = `Telegram delivery failed (${kind})`;
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
      const token = this.botToken();
      const fetcher = this.telegramFetch();
      const replyToMessageId = parseTelegramMessageId(message.replyToId);
      let messageId: string | undefined;
      if (media.length === 0) {
        const sent = await sendManagedTelegramText(
          token,
          current.surfaceId,
          text,
          replyToMessageId,
          fetcher,
          options,
        );
        acceptedProviderDeliveries = 1;
        messageId = String(sent.message_id);
      } else {
        const callApi = <T>(method: string, payload: TelegramApiPayload) =>
          callManagedTelegramApi<T>(token, method, payload, fetcher);
        const deliveries = planTelegramMediaDeliveries(media);
        let mediaOffset = 0;
        for (const [index, delivery] of deliveries.entries()) {
          const caption = index === 0 ? text : "";
          const deliveryBytes = mediaBytes.slice(mediaOffset, mediaOffset + delivery.length);
          const firstSent = delivery.length === 1
            ? await sendTelegramMediaMessage(
                callApi,
                current.surfaceId,
                delivery[0],
                deliveryBytes[0],
                caption,
                replyToMessageId,
              )
            : (await sendTelegramMediaGroupMessage(
                callApi,
                current.surfaceId,
                delivery,
                deliveryBytes,
                caption,
                replyToMessageId,
              ))[0];
          acceptedProviderDeliveries += 1;
          mediaOffset += delivery.length;
          if (!messageId && firstSent) messageId = String(firstSent.message_id);
        }
      }
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
      return { ok: true, messageId };
    } catch (error) {
      const kind = acceptedProviderDeliveries > 0
        ? "ambiguous"
        : error instanceof ManagedTelegramDeliveryError ? error.kind : "permanent";
      return await fail(kind);
    }
  }

  private assertDeliveryContext(state: ManagedTelegramPeerState, context: ResponseContext): void {
    if (context.kind === "installation") {
      if (
        state.activeRoute?.installationId !== context.installationId
        || state.activeRoute.generation !== context.generation
      ) {
        throw new Error("Telegram route changed before delivery");
      }
      return;
    }
    if (context.claimId && state.pairing?.claimId !== context.claimId) {
      throw new Error("Telegram pairing changed before delivery");
    }
  }

  private assertPeerDestination(
    state: ManagedTelegramPeerState,
    surface: AdapterSurface,
    actorId: string | undefined,
  ): void {
    if (surface.kind !== "dm" || surface.id !== state.surfaceId || actorId !== state.actorId) {
      throw new Error("Telegram destination does not match this peer");
    }
  }

  private async requireState(): Promise<ManagedTelegramPeerState> {
    const state = await this.ctx.storage.get<ManagedTelegramPeerState>(STATE_KEY);
    if (!state) throw new Error("Managed Telegram peer is not initialized");
    return state;
  }

  private pairing(code: string): ManagedPairingStub {
    const id = this.env.MANAGED_TELEGRAM_PAIRING.idFromName(`pair:${code}`);
    return typedStub<ManagedPairingStub, DurableObjectStub<undefined>>(this.env.MANAGED_TELEGRAM_PAIRING.get(id));
  }

  private botToken(): string {
    const value = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!value) throw new Error("Managed Telegram bot token is not configured");
    return value;
  }

  private telegramFetch(): ManagedTelegramFetch {
    return this.env.TELEGRAM_API
      ? (input, init) => this.env.TELEGRAM_API!.fetch(input, init)
      : fetch;
  }
}

function telegramFingerprintMessage(
  message: AdapterOutboundMessage,
  options: TelegramTextMessageOptions,
): AdapterOutboundMessage {
  if (!options.replyMarkup) return message;
  return {
    ...message,
    text: `${message.text}\n\n[gsv-telegram-controls:${JSON.stringify(options.replyMarkup)}]`,
  };
}

function typedStub<T, V = T>(value: V): T {
  // SAFETY: The Durable Object namespace binding owns the declared RPC contract.
  return value as T & V;
}

function platformResponse(
  inbound: ManagedTelegramInbound,
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

function parseTelegramMessageId(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function routeWithOrigin(
  route: AdapterPairingRoute,
  canonicalOrigin: string,
): ManagedTelegramPeerRoute {
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
