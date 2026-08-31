import { DurableObject } from "cloudflare:workers";
import {
  classifyNonIdempotentProviderStatus,
  DeliveryLedger,
  type DeliveryFailureKind,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import { shouldReplaceAlarm } from "../../shared/src/alarm";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
} from "../../shared/src/inbound-delivery";
import {
  ADAPTER_PEER_DELIVERY_PENDING_KEY,
  AdapterPeerDeliveryQueue,
  gatewayPeerDeliveryHandlers,
  type AdapterPeerSignalDelivery,
} from "../../shared/src/peer-delivery";
import { renderAdapterPeerSignal } from "../../shared/src/peer-render";
import { callAdapterGateway } from "../../shared/src/gateway-rpc";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  assertAdapterAccountDurableObjectIdentity,
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  resolveAdapterAccountDurableObjectIdentity,
} from "../../shared/src/installation";
import {
  bundleAdapterMedia,
  cancelBinaryBody,
  cancelResponseBody,
  readAdapterMediaBody,
  readResponseBodyBytes,
  validateAdapterMediaBody,
} from "../../shared/src/media-body";
import type { AdapterMediaPart } from "../../shared/src/media-body";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterInstallationContext,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterPeerSignalFrame,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
} from "../../shared/src/types";
import {
  extractMessageContent,
  getContentType,
  makeWASocket,
  proto,
  type AnyMessageContent,
  type BaileysEventMap,
  type LIDMapping,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { z } from "zod";
import {
  clearAuthState,
  hasRegisteredAuthState,
  useDOAuthState,
} from "./auth-store";
import { quietBaileysLogger } from "./baileys-logger";
import { GroupMetadataCache, RecentWhatsAppMessageStore } from "./caches";
import { formatWhatsAppText } from "./formatting";
import {
  quotedWhatsAppMessageText,
  whatsAppInboundText,
} from "./inbound";
import {
  actorIdFromJid,
  isSupportedWhatsAppRemoteJid,
  isWhatsAppGroupJid,
  isWhatsAppLidJid,
  isWhatsAppPnJid,
  messageTimestampMs,
  normalizeOutboundWhatsAppJid,
  normalizeWhatsAppJid,
  phoneHandleFromJid,
  preferredOutboundWhatsAppJid,
  selectInboundUpsertMessages,
  WhatsAppIdentityStore,
  whatsAppDeliverySessionEpoch,
  whatsAppInboundDeliveryIdForSession,
  whatsAppSessionScopedDeliveryId,
} from "./identity";
import {
  APPEND_CATCH_UP_LIMIT,
  APPEND_CATCH_UP_MAX_AGE_MS,
  canReplaceSupersededLifecycleAlarm,
  disconnectPolicy,
  earliestDeadline,
  enqueueThenDeliverInboundBatch,
  INBOUND_RETRY_BATCH_SIZE,
  INBOUND_RETRY_DELAY_MS,
  nextAccountAlarmDeadline,
  pairingChallengeIsCurrent,
  pairingSessionExpired,
  PAIRING_WINDOW_MS,
  reconnectDelayMs,
  restartDelayMs,
  SOCKET_RESIDENCY_ALARM_INTERVAL_MS,
  SocketOperationQueue,
} from "./lifecycle";
import { errorFields, errorMessage, logWhatsApp } from "./logging";
import {
  downloadWhatsAppMedia,
  isWhatsAppDownloadableMediaContentType,
  MAX_WHATSAPP_MEDIA_BYTES,
  MAX_WHATSAPP_MEDIA_TOTAL_BYTES,
  WhatsAppInboundMediaError,
} from "./media";
import {
  defaultWhatsAppFilename,
  isWhatsAppEncryptionPreparationFailure,
  planWhatsAppOutboundDeliveries,
} from "./outbound";
import type {
  WhatsAppAccountState,
  WhatsAppConnectResult,
} from "./types";
import {
  defaultWhatsAppAccountState,
  restoreWhatsAppAccountState,
} from "./types";

const STATE_KEY = "whatsapp_account:v2:state";
const INBOUND_DELIVERY_PREFIX = "pending_inbound:";
const MAX_MEDIA_ITEMS = 20;
const CONNECTION_OPEN_TIMEOUT_MS = 30_000;
const CONNECT_WAIT_MS = 60_000;
const SOCKET_OPEN_WAIT_MS = 25_000;
const SOCKET_CLOSE_WAIT_MS = 5_000;
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABCf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";


type PairingWaiter = {
  resolve: (result: { connected?: boolean; qr?: string; expiresAt?: number }) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type InboundIdentity = {
  remoteJid: string;
  surfaceJid: string;
  actorJid: string;
  isGroup: boolean;
};

class WhatsAppPreparationError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "WhatsAppPreparationError";
  }
}

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private readonly authenticatedSockets = new WeakSet<object>();
  private socketGeneration = 0;
  private readonly socketOperations = new SocketOperationQueue();
  private readonly sessionMutations = new SocketOperationQueue();
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<Uint8Array>;
  private readonly peerDeliveries: AdapterPeerDeliveryQueue;
  private readonly identities: WhatsAppIdentityStore;
  private readonly recentMessages: RecentWhatsAppMessageStore;
  private readonly groupMetadata = new GroupMetadataCache();
  private state: WhatsAppAccountState = defaultWhatsAppAccountState();
  private qrCode: string | null = null;
  private readonly pairingWaiters = new Set<PairingWaiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_DELIVERY_PREFIX,
    );
    this.peerDeliveries = new AdapterPeerDeliveryQueue(
      this.ctx.storage,
      INBOUND_RETRY_DELAY_MS,
    );
    this.identities = new WhatsAppIdentityStore(this.ctx.storage);
    this.recentMessages = new RecentWhatsAppMessageStore(this.ctx.storage);
    this.ctx.blockConcurrencyWhile(async () => this.loadState());
  }

  async connectAccount(
    accountId: string,
    options: { force?: boolean } = {},
  ): Promise<WhatsAppConnectResult> {
    await this.ensureAccount(accountId);
    await this.socketOperations.run(async () => {
      if (options.force) {
        await this.forceNewPairingLocked();
      }
      if (pairingSessionExpired(
        this.state.authenticated,
        this.state.pairingExpiresAt,
      )) {
        await this.expirePairingLocked();
      }
      if (this.state.connected && this.sock) return;

      this.state.desired = "connected";
      this.state.lastError = undefined;
      this.state.disconnectReason = undefined;
      await this.persistStateAndSchedule();
      if (!this.sock) {
        await this.startSocket("connect");
      }
    });

    const result = await this.waitForQrOrConnection(CONNECT_WAIT_MS);
    if (result.connected) {
      return { ok: true, connected: true, message: "Connected" };
    }
    if (result.qr && result.expiresAt) {
      return {
        ok: true,
        connected: false,
        qr: result.qr,
        expiresAt: result.expiresAt,
        message: "Scan this QR code in WhatsApp Linked devices",
      };
    }
    return {
      ok: false,
      error: this.state.lastError ?? "WhatsApp did not connect or provide a QR code in time",
    };
  }

  async disconnectAccount(accountId: string): Promise<void> {
    await this.ensureAccount(accountId);
    try {
      await this.socketOperations.run(async () => this.logoutLocked());
    } finally {
      await this.replaceLifecycleAlarmWithInboundRetry();
      this.own("gateway_status", this.notifyGatewayStatus());
    }
  }

  async getAccountStatus(accountId: string): Promise<AdapterAccountStatus> {
    await this.ensureAccount(accountId);
    await this.scheduleNextAlarm();
    return this.adapterStatus();
  }

  async setAccountActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<void> {
    await this.ensureAccount(accountId);
    await this.socketOperations.run(async () => {
      const socket = this.requireConnectedSocket();
      const jid = await this.resolveOutboundProviderJid(surface.id, socket);
      const presence = activity.active
        ? activity.kind === "recording"
          ? "recording"
          : "composing"
        : "paused";
      await socket.sendPresenceUpdate(presence, jid);
      this.state.lastActivity = Date.now();
      await this.persistStateAndSchedule();
    });
  }

  async sendAccountMessage(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    expectedSessionEpoch = this.state.sessionEpoch,
  ): Promise<AdapterSendResult> {
    const preparedSessionEpoch = expectedSessionEpoch;
    const preparedSocketGeneration = this.socketGeneration;
    try {
      await this.ensureAccount(accountId);
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: errorMessage(error) };
    }
    if (preparedSessionEpoch !== this.state.sessionEpoch) {
      await cancelBinaryBody(body, "WhatsApp account session changed");
      return {
        ok: false,
        error: "WhatsApp account session changed before delivery preparation",
      };
    }
    if (!this.sock || !this.state.connected) {
      await cancelBinaryBody(body, "WhatsApp account is not connected");
      return {
        ok: false,
        error: "WhatsApp account is not connected",
        retryable: true,
      };
    }

    const media = message.media ?? [];
    if (!message.text.trim() && media.length === 0) {
      await cancelBinaryBody(body, "WhatsApp requires text or media");
      return { ok: false, error: "WhatsApp requires text or media" };
    }
    if (media.length > MAX_MEDIA_ITEMS) {
      await cancelBinaryBody(body, "WhatsApp accepts at most 20 media attachments");
      return { ok: false, error: "WhatsApp accepts at most 20 media attachments" };
    }
    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: MAX_WHATSAPP_MEDIA_TOTAL_BYTES,
        maxPartBytes: MAX_WHATSAPP_MEDIA_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: errorMessage(error) };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: MAX_WHATSAPP_MEDIA_TOTAL_BYTES,
        maxPartBytes: MAX_WHATSAPP_MEDIA_BYTES,
      });
      let totalBytes = mediaBytes.reduce(
        (sum, bytes) => sum + (bytes?.byteLength ?? 0),
        0,
      );
      for (const [index, item] of media.entries()) {
        if (!item.url) continue;
        const remaining = MAX_WHATSAPP_MEDIA_TOTAL_BYTES - totalBytes;
        const downloaded = await this.downloadOutboundMedia(item, remaining);
        mediaBytes[index] = downloaded;
        totalBytes += downloaded.byteLength;
      }
    } catch (error) {
      return {
        ok: false,
        error: `Could not read WhatsApp media: ${errorMessage(error)}`,
        retryable: error instanceof WhatsAppPreparationError
          ? error.retryable
          : true,
      };
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintOutboundDelivery(message, mediaBytes);
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint WhatsApp delivery: ${errorMessage(error)}`,
        retryable: true,
      };
    }

    const ledgerDeliveryId = await whatsAppSessionScopedDeliveryId(
      preparedSessionEpoch,
      message.deliveryId,
    );
    let claim;
    try {
      claim = await this.deliveries.claim(ledgerDeliveryId, requestFingerprint);
    } catch (error) {
      return {
        ok: false,
        error: `WhatsApp delivery ledger unavailable: ${errorMessage(error)}`,
        retryable: true,
      };
    }
    if (!claim.claimed) return claim.result;

    const { attemptId } = claim;
    let acceptedDeliveries = 0;
    const fail = async (
      kind: DeliveryFailureKind,
      error: string,
    ): Promise<AdapterSendResult> => {
      try {
        if (kind === "retryable") {
          await this.deliveries.releaseRetryable(ledgerDeliveryId, attemptId);
        } else if (kind === "ambiguous") {
          await this.deliveries.failAmbiguous(ledgerDeliveryId, attemptId, error);
        } else {
          await this.deliveries.failPermanent(ledgerDeliveryId, attemptId, error);
        }
      } catch (ledgerError) {
        logWhatsApp("error", "delivery_outcome_persist_failed", errorFields(ledgerError));
      }
      if (preparedSessionEpoch === this.state.sessionEpoch) {
        this.state.lastError = error;
        await this.persistStateAndSchedule().catch((stateError) => {
          logWhatsApp("error", "state_persist_failed", errorFields(stateError));
        });
      }
      const result: AdapterSendResult = {
        ok: false,
        error,
      };
      if (kind === "retryable") result.retryable = true;
      if (kind === "ambiguous") result.ambiguous = true;
      return result;
    };

    try {
      const providerMessageId = await this.socketOperations.run(async () => {
        if (preparedSessionEpoch !== this.state.sessionEpoch) {
          throw new WhatsAppPreparationError(
            "WhatsApp account session changed while preparing the delivery",
            false,
          );
        }
        if (preparedSocketGeneration !== this.socketGeneration) {
          throw new WhatsAppPreparationError(
            "WhatsApp transport changed while preparing the delivery",
            true,
          );
        }
        const socket = this.requireConnectedSocket();
        const jid = await this.resolveOutboundProviderJid(message.surface.id, socket);
        const quoted = await this.buildQuotedMessage(jid, message, socket);
        const plan = planWhatsAppOutboundDeliveries(message.text, media);
        let firstMessageId: string | undefined;

        for (const [index, delivery] of plan.entries()) {
          const content = delivery.kind === "text"
            ? { text: formatWhatsAppText(delivery.text) }
            : this.buildMediaContent(
                media[delivery.mediaIndex],
                mediaBytes[delivery.mediaIndex],
                delivery.caption,
              );
          const sent = await socket.sendMessage(
            jid,
            content,
            index === 0 && quoted ? { quoted } : undefined,
          );
          acceptedDeliveries += 1;
          if (sent) {
            firstMessageId ??= sent.key.id ?? undefined;
            await this.recentMessages.put(sent);
          }
        }
        return firstMessageId;
      });

      try {
        await this.deliveries.succeed(ledgerDeliveryId, attemptId, providerMessageId);
      } catch {
        return {
          ok: false,
          error: "WhatsApp accepted the delivery but its durable outcome could not be recorded",
          ambiguous: true,
        };
      }
      if (preparedSessionEpoch === this.state.sessionEpoch) {
        this.state.lastActivity = Date.now();
        this.state.lastError = undefined;
        await this.persistStateAndSchedule();
      }
      logWhatsApp("info", "delivery_succeeded", {
        attachmentCount: media.length,
        providerSendCount: acceptedDeliveries,
      });
      return { ok: true, messageId: providerMessageId };
    } catch (error) {
      logWhatsApp("warn", "provider_send_failed", {
        acceptedDeliveries,
        ...errorFields(error),
      });
      const providerFailure = providerFailureSchema.parse(error);
      const kind = acceptedDeliveries > 0
        ? "ambiguous"
        : error instanceof WhatsAppPreparationError
          ? error.retryable ? "retryable" : "permanent"
        : classifyWhatsAppSendFailure(providerFailure);
      return await fail(kind, errorMessage(error));
    }
  }

  async acceptPeerSignal(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: AdapterPeerSignalFrame,
    body?: BinaryBody,
  ): Promise<void> {
    try {
      await this.ensureAccount(context.accountId);
      await this.peerDeliveries.enqueueAndArm(
        { installation, context, frame },
        body,
        Date.now() + 25,
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    this.ctx.waitUntil(this.drainPeerDeliveries());
  }

  private async drainPeerDeliveries(): Promise<void> {
    await this.peerDeliveries.drain(gatewayPeerDeliveryHandlers({
      adapter: "whatsapp",
      gateway: this.gatewayBinding(),
      deliver: async (delivery, body) => await this.deliverPeerSignal(delivery, body),
    }));
  }

  private async deliverPeerSignal(
    delivery: AdapterPeerSignalDelivery,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    return await this.sendAccountMessage(
      delivery.context.accountId,
      renderAdapterPeerSignal(delivery.context, delivery.frame).message,
      body,
    );
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.peerDeliveries.armIfPending(now + INBOUND_RETRY_DELAY_MS);
    await this.drainPeerDeliveries();
    await this.inboundDeliveries.armIfPending(now + INBOUND_RETRY_DELAY_MS);
    try {
      if (pairingSessionExpired(
        this.state.authenticated,
        this.state.pairingExpiresAt,
        now,
      )) {
        await this.socketOperations.run(async () => {
          if (!pairingSessionExpired(
            this.state.authenticated,
            this.state.pairingExpiresAt,
            now,
          )) return;
          await this.expirePairingLocked();
        });
      }
      if (
        this.state.connectionDeadlineAt !== undefined
        && this.state.connectionDeadlineAt <= now
        && !this.state.connected
      ) {
        await this.socketOperations.run(async () => {
          if (
            this.state.connectionDeadlineAt === undefined
            || this.state.connectionDeadlineAt > now
            || this.state.connected
          ) return;
          await this.failConnectionAttemptLocked("connection_timeout");
        });
      }
      if (
        this.state.desired === "connected"
        && this.state.connected
        && this.sock
        && (
          !this.socketIsHealthy()
          || this.state.residencyAlarmAt === undefined
          || this.state.residencyAlarmAt <= now
        )
      ) {
        await this.socketOperations.run(async () => {
          if (
            this.state.desired !== "connected"
            || !this.state.connected
            || !this.sock
          ) return;
          if (!this.socketIsHealthy()) {
            await this.failConnectionAttemptLocked("transport_unhealthy");
            return;
          }
          const supersededResidencyAlarm = this.state.residencyAlarmAt;
          this.state.residencyAlarmAt = Date.now()
            + SOCKET_RESIDENCY_ALARM_INTERVAL_MS;
          await this.persistStateAndSchedule(supersededResidencyAlarm);
        });
      } else if (
        this.state.desired === "connected"
        && !this.sock
        && (this.state.reconnectAt === undefined || this.state.reconnectAt <= now)
      ) {
        await this.socketOperations.run(async () => {
          if (
            this.state.desired !== "connected"
            || this.sock
            || (this.state.reconnectAt !== undefined && this.state.reconnectAt > now)
          ) return;
          await this.startSocket("alarm");
        });
      }
    } catch (error) {
      logWhatsApp("error", "alarm_lifecycle_failed", errorFields(error));
      // SAFETY: Lifecycle errors are normalized to the status-bearing provider contract.
      await this.scheduleReconnectAfterFailure(error as ProviderFailure);
    }

    await this.retryPendingInbound();
    await this.scheduleNextAlarm();
  }

  private async loadState(): Promise<void> {
    const now = Date.now();
    const [stored, legacyAccountId, registeredAuth] = await Promise.all([
      this.ctx.storage.get<WhatsAppAccountState>(STATE_KEY),
      this.ctx.storage.get<string>("accountId"),
      hasRegisteredAuthState(this.ctx.storage),
    ]);
    this.state = restoreWhatsAppAccountState(
      stored,
      legacyAccountId,
      !stored && registeredAuth,
      now,
    );
    if (stored?.version === 2 && this.state.authenticated && !registeredAuth) {
      await this.advanceProviderSessionLocked();
      this.state.authenticated = false;
      this.clearSelfIdentity();
    }

    if (this.state.desired === "connected") {
      const reconnectAt = now + 1_000;
      this.state.connected = false;
      this.state.status = "reconnecting";
      this.state.residencyAlarmAt = undefined;
      this.state.connectionDeadlineAt = undefined;
      const reconnectDeadline = Math.min(
        this.state.reconnectAt ?? reconnectAt,
        reconnectAt,
      );
      this.state.reconnectAt = reconnectDeadline;
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(STATE_KEY, this.state);
        const currentAlarm = await txn.getAlarm();
        if (shouldReplaceAlarm(currentAlarm, reconnectDeadline, now)) {
          await txn.setAlarm(reconnectDeadline);
        }
      });
    } else if (!stored) {
      await this.ctx.storage.put(STATE_KEY, this.state);
    }
    await this.scheduleNextAlarm();
  }

  private getInstallationContext(): AdapterInstallationContext {
    const identity = resolveAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      {
        installationId: this.ctx.id.name
          ? undefined
          : LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
        accountId: this.state.accountId,
      },
    );
    return { installationId: identity.installationId };
  }

  private async ensureAccount(accountId: string): Promise<void> {
    const normalized = accountId.trim();
    if (!normalized) throw new Error("WhatsApp account ID is required");
    assertAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      normalized,
      {
        installationId: this.ctx.id.name
          ? undefined
          : LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
        accountId: this.state.accountId,
      },
    );
    if (this.state.accountId && this.state.accountId !== normalized) {
      throw new Error("WhatsApp account ID mismatch");
    }
    if (!this.state.accountId) {
      this.state.accountId = normalized;
      await this.persistStateAndSchedule();
    }
  }

  private async persistStateAndSchedule(
    supersededDeadline?: number,
  ): Promise<void> {
    const now = Date.now();
    const deadline = this.lifecycleDeadline();
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(STATE_KEY, this.state);
      const currentAlarm = await txn.getAlarm();
      const pendingInbound = await txn.list({
        prefix: INBOUND_DELIVERY_PREFIX,
        limit: 1,
      });
      const pendingPeerDelivery = await txn.get<boolean>(ADAPTER_PEER_DELIVERY_PENDING_KEY);
      const hasPendingDelivery = pendingInbound.size > 0 || pendingPeerDelivery === true;
      if (currentAlarm === supersededDeadline) {
        if (canReplaceSupersededLifecycleAlarm(
          currentAlarm,
          supersededDeadline,
          hasPendingDelivery,
        )) {
          if (deadline === undefined) {
            await txn.deleteAlarm();
          } else {
            await txn.setAlarm(deadline);
          }
          return;
        }
      }
      const nextDeadline = nextAccountAlarmDeadline(
        deadline,
        hasPendingDelivery,
        now,
      );
      if (nextDeadline === undefined) return;
      if (shouldReplaceAlarm(currentAlarm, nextDeadline, now)) {
        await txn.setAlarm(nextDeadline);
      }
    });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const lifecycleDeadline = this.lifecycleDeadline();
    await this.ctx.storage.transaction(async (txn) => {
      const currentAlarm = await txn.getAlarm();
      const pendingInbound = await txn.list({
        prefix: INBOUND_DELIVERY_PREFIX,
        limit: 1,
      });
      const pendingPeerDelivery = await txn.get<boolean>(ADAPTER_PEER_DELIVERY_PENDING_KEY);
      const nextDeadline = nextAccountAlarmDeadline(
        lifecycleDeadline,
        pendingInbound.size > 0 || pendingPeerDelivery === true,
        now,
      );
      if (
        nextDeadline !== undefined
        && shouldReplaceAlarm(currentAlarm, nextDeadline, now)
      ) {
        await txn.setAlarm(nextDeadline);
      }
    });
  }

  private lifecycleDeadline(): number | undefined {
    return earliestDeadline(
      this.state.residencyAlarmAt,
      this.state.reconnectAt,
      this.state.connectionDeadlineAt,
      this.state.pairingExpiresAt,
    );
  }

  private async replaceLifecycleAlarmWithInboundRetry(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const deadline = Date.now() + INBOUND_RETRY_DELAY_MS;
    await this.inboundDeliveries.armIfPending(deadline);
    await this.peerDeliveries.armIfPending(deadline);
  }

  private async startSocket(source: string): Promise<void> {
    if (this.sock) return;
    const { state: authState, saveCreds, authReset } = await useDOAuthState(
      this.ctx.storage,
    );
    if (authReset && this.state.authenticated) {
      await this.advanceProviderSessionLocked();
      this.clearSelfIdentity();
    }
    const sessionEpoch = this.state.sessionEpoch;
    const generation = ++this.socketGeneration;
    const now = Date.now();
    this.qrCode = null;
    this.state.connected = false;
    this.state.authenticated = authState.creds.registered;
    this.state.status = this.state.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.state.reconnectAt = undefined;
    this.state.residencyAlarmAt = undefined;
    this.state.connectionDeadlineAt = now + CONNECTION_OPEN_TIMEOUT_MS;
    this.state.pairingExpiresAt = authState.creds.registered
      ? undefined
      : now + PAIRING_WINDOW_MS;
    await this.persistStateAndSchedule();

    let socket: WASocket;
    try {
      socket = makeWASocket({
        auth: {
          creds: authState.creds,
          keys: authState.keys,
        },
        logger: quietBaileysLogger,
        browser: ["GSV", "Desktop", "1.0.0"],
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: ({ syncType }) =>
          syncType !== proto.HistorySync.HistorySyncType.FULL,
        shouldIgnoreJid: (jid) => !isSupportedWhatsAppRemoteJid(normalizeWhatsAppJid(jid)),
        qrTimeout: PAIRING_WINDOW_MS,
        getMessage: async (key) => this.recentMessages.get(key),
        cachedGroupMetadata: async (jid) => this.groupMetadata.get(jid),
      });
    } catch (error) {
      this.state.connectionDeadlineAt = undefined;
      if (this.state.desired === "connected") {
        this.state.status = "reconnecting";
        this.state.reconnectAt = Date.now()
          + reconnectDelayMs(this.state.reconnectAttempt++);
      } else {
        this.state.status = "error";
        this.state.reconnectAt = undefined;
        this.state.pairingExpiresAt = undefined;
      }
      this.state.lastError = errorMessage(error);
      await this.persistStateAndSchedule();
      throw error;
    }
    this.sock = socket;

    socket.ev.on("creds.update", () => {
      this.handleCredentialsUpdate(generation, socket, saveCreds);
    });
    socket.ev.on("connection.update", (update) => {
      if (update.connection === "open") this.authenticatedSockets.add(socket);
      if (update.connection === "close") this.authenticatedSockets.delete(socket);
      this.own(
        "connection_update",
        this.socketOperations.run(() =>
          this.handleConnectionUpdate(generation, socket, update)
        ),
      );
    });
    socket.ev.on("lid-mapping.update", (mapping) => {
      this.own(
        "lid_mapping",
        this.rememberLidPnMappings(
          sessionEpoch,
          generation,
          socket,
          [mapping],
        ),
      );
    });
    socket.ev.on("messaging-history.set", ({ lidPnMappings }) => {
      this.own(
        "history_mappings",
        this.rememberLidPnMappings(
          sessionEpoch,
          generation,
          socket,
          lidPnMappings,
        ),
      );
    });
    socket.ev.on("messages.upsert", (event) => {
      const receivedAt = Date.now();
      logWhatsApp("info", "inbound_upsert_received", {
        generation,
        messageCount: event.messages.length,
        upsertType: event.type,
      });
      this.own(
        "messages_upsert",
        this.handleMessagesUpsert(sessionEpoch, event, receivedAt),
      );
    });
    logWhatsApp("info", "socket_started", { generation, source });
    try {
      await withTimeout(
        socket.waitForSocketOpen(),
        SOCKET_OPEN_WAIT_MS,
        "WhatsApp WebSocket upgrade timed out",
      );
    } catch (error) {
      const failure = toError(String(error), "WhatsApp WebSocket upgrade failed");
      const supersededConnectionDeadline = this.state.connectionDeadlineAt;
      if (this.isCurrentSocket(generation, socket)) {
        ++this.socketGeneration;
        this.sock = null;
        this.authenticatedSockets.delete(socket);
        this.state.connected = false;
        this.state.status = this.state.desired === "connected" ? "reconnecting" : "error";
        this.state.connectionDeadlineAt = undefined;
        this.state.residencyAlarmAt = undefined;
        this.state.reconnectAt = this.state.desired === "connected"
          ? Date.now() + reconnectDelayMs(this.state.reconnectAttempt++)
          : undefined;
        this.state.lastError = failure.message;
        await this.persistStateAndSchedule(supersededConnectionDeadline);
      }
      await withTimeout(
        socket.end(failure),
        SOCKET_CLOSE_WAIT_MS,
        "WhatsApp failed-upgrade cleanup timed out",
      ).catch(() => undefined);
      throw failure;
    }
    logWhatsApp("info", "socket_transport_open", { generation, source });
  }

  private async handleConnectionUpdate(
    generation: number,
    socket: WASocket,
    update: Partial<BaileysEventMap["connection.update"]>,
  ): Promise<void> {
    if (!this.isCurrentSocket(generation, socket)) return;
    const statusCode = providerStatusCode(update.lastDisconnect?.error);

    if (update.qr) {
      if (pairingSessionExpired(
        this.state.authenticated,
        this.state.pairingExpiresAt,
      )) {
        await this.expirePairingLocked();
        return;
      }
      const supersededConnectionDeadline = this.state.connectionDeadlineAt;
      this.qrCode = update.qr;
      this.state.status = "awaiting_qr";
      this.state.authenticated = false;
      this.state.pairingExpiresAt ??= Date.now() + PAIRING_WINDOW_MS;
      this.state.connectionDeadlineAt = undefined;
      await this.persistStateAndSchedule(supersededConnectionDeadline);
      this.resolvePairingWaiters({
        qr: update.qr,
        expiresAt: this.state.pairingExpiresAt,
      });
      logWhatsApp("info", "pairing_qr_ready", { generation });
    }

    if (update.connection === "open") {
      if (
        !this.authenticatedSockets.has(socket)
        || socket.ws.isOpen !== true
      ) return;
      if (this.state.desired === "disconnected") {
        const supersededLifecycleDeadline = this.lifecycleDeadline();
        ++this.socketGeneration;
        this.sock = null;
        this.state.connected = false;
        this.state.status = "idle";
        this.state.residencyAlarmAt = undefined;
        this.state.reconnectAt = undefined;
        this.state.connectionDeadlineAt = undefined;
        this.state.pairingExpiresAt = undefined;
        await this.persistStateAndSchedule(supersededLifecycleDeadline);
        await withTimeout(
          socket.end(new Error("WhatsApp connection is no longer desired")),
          SOCKET_CLOSE_WAIT_MS,
          "WhatsApp socket close timed out",
        ).catch(() => undefined);
        return;
      }
      const now = Date.now();
      const supersededConnectionDeadline = this.state.connectionDeadlineAt;
      this.state.connected = true;
      this.state.authenticated = true;
      this.state.status = "connected";
      this.state.desired = "connected";
      this.state.lastConnectedAt = now;
      this.state.lastActivity = now;
      this.state.lastError = undefined;
      this.state.disconnectReason = undefined;
      this.state.reconnectAttempt = 0;
      this.state.reconnectAt = undefined;
      this.state.connectionDeadlineAt = undefined;
      this.state.pairingExpiresAt = undefined;
      this.state.residencyAlarmAt = now + SOCKET_RESIDENCY_ALARM_INTERVAL_MS;
      this.qrCode = null;

      this.state.selfJid = normalizeWhatsAppJid(socket.user?.id) ?? undefined;
      this.state.selfLid = normalizeWhatsAppJid(socket.user?.lid) ?? undefined;
      this.state.selfE164 = phoneHandleFromJid(
        socket.user?.phoneNumber ?? socket.user?.id,
      );
      if (this.state.selfLid && this.state.selfJid && isWhatsAppPnJid(this.state.selfJid)) {
        await this.identities.bindLidPn(this.state.selfLid, this.state.selfJid);
      }
      if (!this.isCurrentSocket(generation, socket)) return;
      await this.persistStateAndSchedule(supersededConnectionDeadline);
      this.resolvePairingWaiters({ connected: true });
      this.own("gateway_status", this.notifyGatewayStatus());
      logWhatsApp("info", "socket_open", {
        generation,
        residencyAlarmInMs: SOCKET_RESIDENCY_ALARM_INTERVAL_MS,
      });
    }

    if (update.connection !== "close") return;
    const supersededLifecycleDeadline = this.lifecycleDeadline();
    this.sock = null;
    this.groupMetadata.clear();
    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();
    this.state.residencyAlarmAt = undefined;
    this.state.connectionDeadlineAt = undefined;
    this.qrCode = null;

    const policy = disconnectPolicy(statusCode);
    this.state.disconnectReason = disconnectReasonName(statusCode);
    if (this.state.desired === "disconnected") {
      this.state.status = "idle";
      this.state.reconnectAt = undefined;
    } else if (policy.action === "logged_out") {
      this.state.desired = "disconnected";
      this.state.status = "logged_out";
      this.state.authenticated = false;
      this.state.selfJid = undefined;
      this.state.selfLid = undefined;
      this.state.selfE164 = undefined;
      this.state.reconnectAt = undefined;
    } else if (policy.action === "stop") {
      this.state.desired = "disconnected";
      this.state.status = "error";
      this.state.reconnectAt = undefined;
      this.state.lastError = `WhatsApp disconnected: ${this.state.disconnectReason}`;
      if (policy.clearAuth) this.state.authenticated = false;
    } else {
      this.state.status = "reconnecting";
      const attempt = this.state.reconnectAttempt++;
      const delay = policy.action === "restart"
        ? restartDelayMs(attempt)
        : reconnectDelayMs(attempt);
      this.state.reconnectAt = Date.now() + delay;
    }
    if (policy.clearAuth) {
      await this.advanceProviderSessionLocked();
      await clearAuthState(this.ctx.storage);
      this.state.authenticated = false;
      this.clearSelfIdentity();
    }
    await this.persistStateAndSchedule(supersededLifecycleDeadline);
    if (this.state.desired === "disconnected") this.resolvePairingWaiters({});
    this.own("gateway_status", this.notifyGatewayStatus());
    logWhatsApp("warn", "socket_closed", {
      generation,
      statusCode,
      action: policy.action,
    });
  }

  private socketIsHealthy(): boolean {
    const socket = this.sock;
    return socket !== null
      && this.state.connected
      && this.authenticatedSockets.has(socket)
      && socket.ws.isOpen === true;
  }

  private async failConnectionAttemptLocked(reason: string): Promise<void> {
    const oldSocket = this.sock;
    const now = Date.now();
    ++this.socketGeneration;
    this.sock = null;
    if (oldSocket) this.authenticatedSockets.delete(oldSocket);
    this.state.connected = false;
    this.state.lastDisconnectedAt = now;
    this.state.residencyAlarmAt = undefined;
    this.state.connectionDeadlineAt = undefined;
    if (this.state.desired === "connected") {
      this.state.status = "reconnecting";
      this.state.reconnectAt = now
        + reconnectDelayMs(this.state.reconnectAttempt++);
    } else {
      this.state.status = "error";
      this.state.reconnectAt = undefined;
    }
    this.state.disconnectReason = reason;
    await this.persistStateAndSchedule();
    if (oldSocket) {
      await withTimeout(
        oldSocket.end(new Error("WhatsApp transport is unhealthy")),
        SOCKET_CLOSE_WAIT_MS,
        "WhatsApp unhealthy-transport close timed out",
      ).catch(() => undefined);
    }
  }

  private async expirePairingLocked(): Promise<void> {
    const supersededLifecycleDeadline = this.lifecycleDeadline();
    const oldSocket = this.sock;
    ++this.socketGeneration;
    this.sock = null;
    this.state.desired = "disconnected";
    this.state.connected = false;
    this.state.authenticated = false;
    this.state.status = "error";
    this.state.lastError = "WhatsApp QR pairing expired";
    this.state.disconnectReason = "pairing_expired";
    this.state.residencyAlarmAt = undefined;
    this.state.reconnectAt = undefined;
    this.state.connectionDeadlineAt = undefined;
    this.state.pairingExpiresAt = undefined;
    this.qrCode = null;
    await clearAuthState(this.ctx.storage);
    await this.persistStateAndSchedule(supersededLifecycleDeadline);
    if (oldSocket) {
      await withTimeout(
        oldSocket.end(new Error("WhatsApp pairing expired")),
        SOCKET_CLOSE_WAIT_MS,
        "WhatsApp pairing close timed out",
      ).catch(() => undefined);
    }
    this.resolvePairingWaiters({});
  }

  private async scheduleReconnectAfterFailure(error: ProviderFailure): Promise<void> {
    if (this.state.desired !== "connected") return;
    if (this.sock) {
      this.state.lastError = errorMessage(error);
      await this.failConnectionAttemptLocked("lifecycle_failure");
      return;
    }
    if (
      this.state.status === "reconnecting"
      && this.state.reconnectAt !== undefined
      && this.state.reconnectAt > Date.now()
    ) {
      this.state.lastError = errorMessage(error);
      await this.persistStateAndSchedule();
      return;
    }
    this.state.connected = false;
    this.state.status = "reconnecting";
    this.state.connectionDeadlineAt = undefined;
    this.state.residencyAlarmAt = undefined;
    this.state.reconnectAt = Date.now() + reconnectDelayMs(this.state.reconnectAttempt++);
    this.state.lastError = errorMessage(error);
    await this.persistStateAndSchedule();
  }

  private async forceNewPairingLocked(): Promise<void> {
    this.state.desired = "disconnected";
    const providerError = await this.detachProviderSessionLocked(
      "force_logout",
      "Replacing WhatsApp linked-device session",
    );
    if (providerError) {
      logWhatsApp("warn", "force_logout_provider_failed", errorFields(providerError));
    }
    await this.advanceProviderSessionLocked();
    await clearAuthState(this.ctx.storage);
    this.qrCode = null;
    this.resolvePairingWaiters({});
    const accountId = this.state.accountId;
    const sessionEpoch = this.state.sessionEpoch;
    this.state = {
      ...defaultWhatsAppAccountState(),
      accountId,
      desired: "connected",
      sessionEpoch,
      lastDisconnectedAt: Date.now(),
      disconnectReason: "session_replaced",
    };
    await this.persistStateAndSchedule();
  }

  private async logoutLocked(): Promise<void> {
    const supersededLifecycleDeadline = this.lifecycleDeadline();
    this.state.desired = "disconnected";
    this.state.residencyAlarmAt = undefined;
    this.state.reconnectAt = undefined;
    this.state.connectionDeadlineAt = undefined;
    this.state.pairingExpiresAt = undefined;
    await this.persistStateAndSchedule(supersededLifecycleDeadline);

    const providerError = await this.detachProviderSessionLocked(
      "logout",
      "GSV adapter disconnected",
    );
    await this.advanceProviderSessionLocked();
    await clearAuthState(this.ctx.storage);
    const accountId = this.state.accountId;
    const sessionEpoch = this.state.sessionEpoch;
    const lastDisconnectedAt = Date.now();
    this.state = {
      ...defaultWhatsAppAccountState(),
      accountId,
      sessionEpoch,
      status: providerError ? "error" : "logged_out",
      disconnectReason: "user_logout",
      lastDisconnectedAt,
      lastError: providerError
        ? `WhatsApp logout failed: ${errorMessage(providerError)}`
        : undefined,
    };
    this.qrCode = null;
    this.groupMetadata.clear();
    this.resolvePairingWaiters({});
    await this.persistStateAndSchedule();
    if (providerError) throw providerError;
  }

  private async detachProviderSessionLocked(
    source: string,
    logoutMessage: string,
  ): Promise<Error | undefined> {
    const registered = await hasRegisteredAuthState(this.ctx.storage);
    let socket = this.sock;
    let authenticated = Boolean(
      socket && (this.state.connected || this.authenticatedSockets.has(socket)),
    );
    let failure: Error | undefined;

    if (!socket && registered) {
      try {
        await this.startSocket(source);
        socket = this.sock;
      } catch (error) {
        failure = toError(String(error), "WhatsApp logout connection failed");
      }
    }
    if (socket && !authenticated && !failure) {
      try {
        await socket.waitForConnectionUpdate(
          async (update) => update.connection === "open",
          SOCKET_OPEN_WAIT_MS,
        );
        authenticated = true;
      } catch (error) {
        failure = toError(String(error), "WhatsApp logout connection timed out");
      }
    }

    if (socket) {
      ++this.socketGeneration;
      if (this.sock === socket) this.sock = null;
      this.authenticatedSockets.delete(socket);
      if (authenticated && !failure) {
        try {
          await withTimeout(
            socket.logout(logoutMessage),
            SOCKET_OPEN_WAIT_MS,
            "WhatsApp provider logout timed out",
          );
        } catch (error) {
          failure = toError(String(error), "WhatsApp provider logout failed");
        }
      }
      if (!authenticated || failure) {
        await withTimeout(
          socket.end(failure),
          SOCKET_CLOSE_WAIT_MS,
          "WhatsApp logout cleanup timed out",
        ).catch(() => undefined);
      }
    }

    const supersededLifecycleDeadline = this.lifecycleDeadline();
    this.state.connected = false;
    this.state.residencyAlarmAt = undefined;
    this.state.reconnectAt = undefined;
    this.state.connectionDeadlineAt = undefined;
    this.state.pairingExpiresAt = undefined;
    await this.persistStateAndSchedule(supersededLifecycleDeadline);
    return failure;
  }

  private async advanceProviderSessionLocked(): Promise<void> {
    this.state.sessionEpoch += 1;
    await this.sessionMutations.run(async () => {
      await this.inboundDeliveries.clear();
      await this.identities.clear();
      await this.recentMessages.clear();
      this.groupMetadata.clear();
    });
  }

  private clearSelfIdentity(): void {
    this.state.selfJid = undefined;
    this.state.selfLid = undefined;
    this.state.selfE164 = undefined;
  }

  private async handleMessagesUpsert(
    expectedSessionEpoch: number,
    event: BaileysEventMap["messages.upsert"],
    receivedAt: number,
  ): Promise<void> {
    if (expectedSessionEpoch !== this.state.sessionEpoch) return;
    if (event.type !== "notify" && event.type !== "append") return;
    const messages = selectInboundUpsertMessages(
      event.type,
      event.messages,
      APPEND_CATCH_UP_LIMIT,
      Date.now() - APPEND_CATCH_UP_MAX_AGE_MS,
    );
    await enqueueThenDeliverInboundBatch(
      async () => {
        const accepted = await this.sessionMutations.run(async () => {
          if (expectedSessionEpoch !== this.state.sessionEpoch) return [];
          const batch: Array<{ deliveryId: string; sessionEpoch: number }> = [];
          for (const message of messages) {
            if (expectedSessionEpoch !== this.state.sessionEpoch) break;
            if (message.key.fromMe || !message.key.id) continue;
            const identity = await this.inboundIdentity(message);
            if (expectedSessionEpoch !== this.state.sessionEpoch) break;
            if (!identity) continue;
            const deliveryId = await whatsAppInboundDeliveryIdForSession(
              expectedSessionEpoch,
              {
                remoteCanonicalJid: identity.surfaceJid,
                senderCanonicalJid: identity.isGroup ? identity.actorJid : undefined,
                legacyRemoteJid: message.key.remoteJid,
                legacyParticipantJid: message.key.participant,
                providerMessageId: message.key.id,
              },
            );
            if (expectedSessionEpoch !== this.state.sessionEpoch) break;
            await this.recentMessages.put(message);
            if (expectedSessionEpoch !== this.state.sessionEpoch) break;
            await this.inboundDeliveries.enqueueAndArm(
              deliveryId,
              proto.WebMessageInfo.encode(message).finish(),
              Date.now() + INBOUND_RETRY_DELAY_MS,
            );
            batch.push({
              deliveryId,
              sessionEpoch: expectedSessionEpoch,
            });
          }
          return batch;
        });
        logWhatsApp("info", "inbound_batch_persisted", {
          acceptedCount: accepted.length,
          persistenceDelayMs: Date.now() - receivedAt,
          selectedCount: messages.length,
        });
        return accepted;
      },
      async (accepted) => this.deliverPendingInbound(
        accepted.deliveryId,
        accepted.sessionEpoch,
      ),
    );
  }

  private async deliverPendingInbound(
    deliveryId: string,
    expectedSessionEpoch = whatsAppDeliverySessionEpoch(deliveryId),
  ): Promise<void> {
    const attempt = await this.inboundDeliveries.attempt(
      deliveryId,
      async (encoded) => {
        // SAFETY: Baileys protobuf decoding returns the WebMessageInfo shape persisted by this adapter.
        const decoded = proto.WebMessageInfo.decode(encoded) as WAMessage;
        if (!decoded.key) return { terminal: true };
        return this.forwardInboundMessage(
          decoded,
          deliveryId,
          expectedSessionEpoch,
        );
      },
      async (response) => this.sendAccountMessage(
        this.state.accountId,
        response,
        undefined,
        expectedSessionEpoch,
      ),
    );
    if (attempt.state !== "pending") return;
    logWhatsApp("warn", "inbound_pending", {
      hasError: attempt.error !== undefined,
    });
    await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
  }

  private async retryPendingInbound(): Promise<void> {
    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const deliveryId of ids) {
      try {
        await this.deliverPendingInbound(deliveryId);
      } catch (error) {
        logWhatsApp("error", "inbound_retry_failed", errorFields(error));
        await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
      }
    }
  }

  private async forwardInboundMessage(
    message: WAMessage,
    deliveryId: string,
    expectedSessionEpoch: number,
  ): Promise<{ terminal: boolean; error?: string }> {
    if (expectedSessionEpoch !== this.state.sessionEpoch) {
      return { terminal: true };
    }
    const sessionContext = await this.sessionMutations.run(async () => {
      if (expectedSessionEpoch !== this.state.sessionEpoch) return null;
      const identity = await this.inboundIdentity(message);
      if (!identity || expectedSessionEpoch !== this.state.sessionEpoch) return null;
      const actorHandle = await this.actorHandle(identity.actorJid);
      if (expectedSessionEpoch !== this.state.sessionEpoch) return null;
      return {
        identity,
        actorHandle,
        socket: this.sock,
      };
    });
    if (!sessionContext || !message.key.id) return { terminal: true };
    const { identity, actorHandle, socket: sessionSocket } = sessionContext;
    const extracted = extractMessageContent(message.message);
    const contentType = extracted ? getContentType(extracted) : undefined;
    const contextInfo = messageContextInfo(extracted, contentType);
    const hasMedia = !!contentType
      && isWhatsAppDownloadableMediaContentType(contentType);
    const text = whatsAppInboundText(message, extracted, contentType);
    if (text === undefined && !hasMedia) return { terminal: true };
    const actorId = actorIdFromJid(identity.actorJid);
    const groupName = identity.isGroup
      ? await this.groupName(
          identity.remoteJid,
          sessionSocket,
          expectedSessionEpoch,
        )
      : undefined;

    const mediaParts: AdapterMediaPart[] = [];
    let unavailableMedia = false;
    if (hasMedia) {
      if (!sessionSocket) {
        return { terminal: false, error: "WhatsApp media is waiting for reconnection" };
      }
      try {
        const media = await downloadWhatsAppMedia(sessionSocket, message);
        if (media) mediaParts.push(media);
      } catch (error) {
        if (error instanceof WhatsAppInboundMediaError && error.retryable) {
          return { terminal: false, error: errorMessage(error) };
        }
        unavailableMedia = true;
        logWhatsApp("warn", "inbound_media_rejected", errorFields(error));
      }
    }
    const media = await bundleAdapterMedia(mediaParts);
    const inbound: AdapterInboundMessage = {
      messageId: message.key.id,
      surface: {
        kind: identity.isGroup ? "group" : "dm",
        id: identity.surfaceJid,
        name: identity.isGroup ? groupName : message.pushName ?? undefined,
        handle: !identity.isGroup && actorHandle ? actorHandle : undefined,
      },
      actor: {
        id: actorId,
        name: message.pushName ?? undefined,
        handle: actorHandle ?? undefined,
      },
      text: text || (
        media.media.length > 0
          ? "[Media]"
          : unavailableMedia
            ? "[Media unavailable]"
            : ""
      ),
      media: media.media.length > 0 ? media.media : undefined,
      replyToId: contextInfo?.stanzaId ?? undefined,
      replyToText: quotedWhatsAppMessageText(contextInfo?.quotedMessage),
      timestamp: messageTimestampMs(message.messageTimestamp),
      wasMentioned: !identity.isGroup || this.isGroupMessageAddressedToSelf(contextInfo),
    };

    const forward = async (): Promise<{ terminal: boolean; error?: string }> => {
      if (expectedSessionEpoch !== this.state.sessionEpoch) {
        await cancelBinaryBody(media.body, "Stale WhatsApp account session");
        return { terminal: true };
      }
      const gatewayStartedAt = Date.now();
      let result: AdapterInboundResult;
      try {
        result = await callAdapterGateway(
          this.gatewayBinding(),
          this.getInstallationContext(),
          "adapter.inbound",
          {
            adapter: "whatsapp",
            accountId: this.state.accountId,
            deliveryId,
            message: inbound,
          },
          media.body,
        );
      } catch (error) {
        logWhatsApp("warn", "inbound_gateway_failed", {
          durationMs: Date.now() - gatewayStartedAt,
          ...errorFields(error),
        });
        throw error;
      }
      if (expectedSessionEpoch !== this.state.sessionEpoch) {
        return { terminal: true };
      }
      const disposition = adapterInboundResultDisposition(result, {
        surface: inbound.surface,
        providerMessageId: inbound.messageId,
        actorId: inbound.actor?.id,
      });
      logWhatsApp("info", "inbound_gateway_completed", {
        durationMs: Date.now() - gatewayStartedAt,
        ok: result.ok,
        terminal: disposition.terminal,
      });
      if (!disposition.terminal) return disposition;
      this.state.lastActivity = Date.now();
      if (!result.ok) {
        this.state.lastError = result.error
          ? errorMessage(result.error)
          : "Gateway rejected WhatsApp ingress";
      }
      await this.persistStateAndSchedule();
      return disposition;
    };
    return forward();
  }

  private async inboundIdentity(message: WAMessage): Promise<InboundIdentity | null> {
    const remote = normalizeWhatsAppJid(message.key.remoteJid);
    const remoteAlt = normalizeWhatsAppJid(message.key.remoteJidAlt);
    const supportedRemote = isSupportedWhatsAppRemoteJid(remote)
      ? remote
      : isSupportedWhatsAppRemoteJid(remoteAlt)
        ? remoteAlt
        : null;
    if (!supportedRemote) return null;
    const isGroup = isWhatsAppGroupJid(supportedRemote);
    if (isGroup) {
      const actorJid = await this.identities.canonicalJid(
        message.key.participant,
        message.key.participantAlt,
      );
      if (!actorJid) return null;
      return {
        remoteJid: supportedRemote,
        surfaceJid: supportedRemote,
        actorJid,
        isGroup: true,
      };
    }
    const canonical = await this.identities.canonicalJid(remote, remoteAlt);
    if (!canonical) return null;
    return {
      remoteJid: supportedRemote,
      surfaceJid: canonical,
      actorJid: canonical,
      isGroup: false,
    };
  }

  private isGroupMessageAddressedToSelf(
    contextInfo: proto.IContextInfo | undefined,
  ): boolean {
    if (!contextInfo) return false;
    const ownJids = new Set<string>();
    for (const value of [
      this.state.selfJid,
      this.state.selfLid,
      this.sock?.user?.id,
      this.sock?.user?.lid,
      this.sock?.user?.phoneNumber,
    ]) {
      const jid = normalizeWhatsAppJid(value);
      if (jid) ownJids.add(jid);
    }
    const matches = (value: string | null | undefined): boolean => {
      const jid = normalizeWhatsAppJid(value);
      return jid ? ownJids.has(jid) : false;
    };
    return contextInfo.mentionedJid?.some(matches) === true
      || Boolean(contextInfo.quotedMessage && matches(contextInfo.participant));
  }

  private async resolveOutboundProviderJid(
    input: string,
    socket: WASocket,
  ): Promise<string> {
    const jid = normalizeOutboundWhatsAppJid(input);
    let mappedPhoneJid = isWhatsAppLidJid(jid)
      ? await this.identities.pnForLid(jid)
      : null;
    if (isWhatsAppLidJid(jid) && !mappedPhoneJid) {
      try {
        const providerPhoneJid = normalizeWhatsAppJid(
          await socket.signalRepository.lidMapping.getPNForLID(jid),
        );
        if (isWhatsAppPnJid(providerPhoneJid)) {
          mappedPhoneJid = providerPhoneJid;
          try {
            await this.identities.bindLidPn(jid, providerPhoneJid);
          } catch (error) {
            logWhatsApp("warn", "lid_mapping_persist_failed", errorFields(error));
          }
        }
      } catch (error) {
        logWhatsApp("warn", "pn_lookup_failed", errorFields(error));
      }
    }
    try {
      return preferredOutboundWhatsAppJid(jid, mappedPhoneJid);
    } catch {
      throw new WhatsAppPreparationError("Unsupported WhatsApp destination", false);
    }
  }

  private async lookupLidForPn(
    pnJid: string,
    socket = this.sock,
  ): Promise<string | null> {
    const stored = await this.identities.lidForPn(pnJid);
    if (stored) return stored;
    if (!socket) return null;
    try {
      const lid = normalizeWhatsAppJid(
        await socket.signalRepository.lidMapping.getLIDForPN(pnJid),
      );
      if (!isWhatsAppLidJid(lid)) return null;
      await this.identities.bindLidPn(lid, pnJid);
      return lid;
    } catch (error) {
      logWhatsApp("warn", "lid_lookup_failed", errorFields(error));
      return null;
    }
  }

  private async buildQuotedMessage(
    remoteJid: string,
    message: AdapterOutboundMessage,
    socket: WASocket,
  ): Promise<WAMessage | undefined> {
    const replyToId = message.replyToId?.trim();
    if (!replyToId) return undefined;
    let participant: string | undefined;
    let participantAlt: string | undefined;
    if (isWhatsAppGroupJid(remoteJid) && message.actorId) {
      const actorJid = normalizeOutboundWhatsAppJid(message.actorId);
      if (isWhatsAppPnJid(actorJid)) {
        const lid = await this.lookupLidForPn(actorJid, socket);
        participant = lid ?? actorJid;
        if (lid) participantAlt = actorJid;
      } else if (isWhatsAppLidJid(actorJid)) {
        participant = actorJid;
        participantAlt = await this.identities.pnForLid(actorJid) ?? undefined;
      }
    }
    return {
      key: {
        id: replyToId,
        remoteJid,
        fromMe: false,
        participant,
        participantAlt,
      },
      participant,
      message: { conversation: "" },
    };
  }

  private buildMediaContent(
    media: AdapterMedia,
    bytes: Uint8Array | undefined,
    captionText: string,
  ): AnyMessageContent {
    if (!bytes) {
      throw new WhatsAppPreparationError(
        "WhatsApp media attachment is missing bytes",
        false,
      );
    }
    const upload = Buffer.from(bytes);
    const caption = formatWhatsAppText(captionText.trim()) || undefined;
    switch (media.type) {
      case "image":
        return {
          image: upload,
          mimetype: media.mimeType,
          jpegThumbnail: TINY_JPEG_BASE64,
          caption,
        };
      case "video":
        return {
          video: upload,
          mimetype: media.mimeType,
          jpegThumbnail: TINY_JPEG_BASE64,
          caption,
        };
      case "audio":
        return {
          audio: upload,
          mimetype: media.mimeType,
          seconds: Math.max(0, Math.round(media.duration ?? 0)),
        };
      case "document":
        return {
          document: upload,
          mimetype: media.mimeType || "application/octet-stream",
          fileName: defaultWhatsAppFilename(media),
          caption,
        };
    }
  }

  private async downloadOutboundMedia(
    media: AdapterMedia,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (!media.url || maxBytes < 0) {
      throw new WhatsAppPreparationError("WhatsApp media exceeds the total limit", false);
    }
    if (media.size !== undefined && media.size > maxBytes) {
      throw new WhatsAppPreparationError("WhatsApp media exceeds the total limit", false);
    }
    let url: URL;
    try {
      url = new URL(media.url);
    } catch {
      throw new WhatsAppPreparationError("WhatsApp media URL is invalid", false);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new WhatsAppPreparationError("WhatsApp media URL must use HTTP or HTTPS", false);
    }

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(url, { redirect: "manual" });
      } catch (error) {
        throw new WhatsAppPreparationError(
          `WhatsApp media transport failed: ${errorMessage(error)}`,
          true,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response, "Following WhatsApp media redirect");
        if (!location || redirects === 3) {
          throw new WhatsAppPreparationError("WhatsApp media redirect is invalid", false);
        }
        url = new URL(location, url);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new WhatsAppPreparationError("WhatsApp media redirect is unsafe", false);
        }
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response, "WhatsApp media download failed");
        throw new WhatsAppPreparationError(
          `WhatsApp media HTTP ${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      try {
        return await readResponseBodyBytes(response, {
          maxBytes,
          expectedBytes: media.size,
          label: "WhatsApp outbound media",
        });
      } catch (error) {
        throw new WhatsAppPreparationError(errorMessage(error), false);
      }
    }
    throw new WhatsAppPreparationError("WhatsApp media redirect limit exceeded", false);
  }

  private async rememberLidPnMappings(
    expectedSessionEpoch: number,
    generation: number,
    socket: WASocket,
    mappings: LIDMapping[] | undefined,
  ): Promise<void> {
    if (!mappings) return;
    const batchSize = 128;
    for (let index = 0; index < mappings.length; index += batchSize) {
      const batch = mappings.slice(index, index + batchSize);
      const current = await this.sessionMutations.run(async () => {
        if (
          expectedSessionEpoch !== this.state.sessionEpoch
          || !this.isCurrentSocket(generation, socket)
        ) {
          return false;
        }
        await this.identities.bindLidPnMappings(batch);
        return expectedSessionEpoch === this.state.sessionEpoch
          && this.isCurrentSocket(generation, socket);
      });
      if (!current) return;
    }
  }

  private async actorHandle(actorJid: string): Promise<string | undefined> {
    const direct = phoneHandleFromJid(actorJid);
    if (direct) return direct;
    const pn = await this.identities.pnForLid(actorJid);
    return phoneHandleFromJid(pn);
  }

  private async groupName(
    jid: string,
    socket: WASocket | null,
    expectedSessionEpoch: number,
  ): Promise<string | undefined> {
    const cached = this.groupMetadata.get(jid);
    if (cached) return cached.subject || undefined;
    if (!socket) return undefined;
    try {
      const metadata = await socket.groupMetadata(jid);
      if (expectedSessionEpoch === this.state.sessionEpoch) {
        this.groupMetadata.set(jid, metadata);
      }
      return metadata.subject || undefined;
    } catch (error) {
      logWhatsApp("warn", "group_metadata_failed", errorFields(error));
      return undefined;
    }
  }

  private requireConnectedSocket(): WASocket {
    if (!this.sock || !this.state.connected) {
      throw new WhatsAppPreparationError("WhatsApp account is not connected", true);
    }
    return this.sock;
  }

  private isCurrentSocket(generation: number, socket: WASocket): boolean {
    return generation === this.socketGeneration && socket === this.sock;
  }

  private handleCredentialsUpdate(
    generation: number,
    socket: WASocket,
    saveCreds: () => Promise<void>,
  ): void {
    if (!this.isCurrentSocket(generation, socket)) return;
    this.own("credentials_update", this.sessionMutations.run(saveCreds));
  }

  private waitForQrOrConnection(
    timeoutMs: number,
  ): Promise<{ connected?: boolean; qr?: string; expiresAt?: number }> {
    if (this.state.connected) return Promise.resolve({ connected: true });
    if (pairingChallengeIsCurrent(this.qrCode, this.state.pairingExpiresAt)) {
      return Promise.resolve({
        qr: this.qrCode,
        expiresAt: this.state.pairingExpiresAt,
      });
    }
    return new Promise((resolve) => {
      const waiter: PairingWaiter = {
        resolve,
        timeout: setTimeout(() => {
          this.pairingWaiters.delete(waiter);
          resolve({});
        }, timeoutMs),
      };
      this.pairingWaiters.add(waiter);
    });
  }

  private resolvePairingWaiters(
    result: { connected?: boolean; qr?: string; expiresAt?: number },
  ): void {
    for (const waiter of this.pairingWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(result);
    }
    this.pairingWaiters.clear();
  }

  private adapterStatus(): AdapterAccountStatus {
    const extra: NonNullable<AdapterAccountStatus["extra"]> = {
      connectionStatus: this.state.status,
    };
    if (this.state.selfE164 !== undefined) extra.selfE164 = this.state.selfE164;
    if (this.state.lastConnectedAt !== undefined) {
      extra.lastConnectedAt = this.state.lastConnectedAt;
    }
    if (this.state.lastDisconnectedAt !== undefined) {
      extra.lastDisconnectedAt = this.state.lastDisconnectedAt;
    }
    if (this.state.disconnectReason !== undefined) {
      extra.disconnectReason = this.state.disconnectReason;
    }
    return {
      accountId: this.state.accountId,
      connected: this.socketIsHealthy(),
      authenticated: this.state.authenticated,
      mode: "websocket",
      lastActivity: this.state.lastActivity,
      error: this.state.lastError,
      extra,
    };
  }

  private async notifyGatewayStatus(): Promise<void> {
    if (!this.state.accountId) return;
    await callAdapterGateway(
      this.gatewayBinding(),
      this.getInstallationContext(),
      "adapter.state.update",
      {
        adapter: "whatsapp",
        accountId: this.state.accountId,
        status: this.adapterStatus(),
      },
    );
  }

  private gatewayBinding(): AdapterGatewayBinding {
    return gatewayBinding(this.env.GATEWAY);
  }

  private own(event: string, promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise.catch((error) => {
      logWhatsApp("error", `${event}_failed`, errorFields(error));
    }));
  }
}

function gatewayBinding<T>(value: T): AdapterGatewayBinding {
  // SAFETY: the worker environment declares GATEWAY as the adapter RPC binding.
  return value as AdapterGatewayBinding;
}

function messageContextInfo(
  message: proto.IMessage | undefined,
  contentType: keyof proto.IMessage | undefined,
): proto.IContextInfo | undefined {
  if (!message || !contentType) return undefined;
  const content = message[contentType];
  if (!content) return undefined;
  const parsed = messageContextSchema.safeParse(content);
  return parsed.success ? parsed.data.contextInfo ?? undefined : undefined;
}

type ProviderNode = {
  output?: ProviderNode;
  statusCode?: number;
  status?: number;
};
type ProviderFailure = Error | ProviderNode | null | undefined;
const providerNodeSchema: z.ZodType<ProviderNode> = z.lazy(() => z.object({
  output: providerNodeSchema.optional(),
  statusCode: z.number().optional(),
  status: z.number().optional(),
}).passthrough());
const providerFailureSchema = z.union([z.instanceof(Error), providerNodeSchema, z.null(), z.undefined()]);
const messageContextSchema = z.object({ contextInfo: z.any().nullable().optional() }).passthrough();

function providerStatusCode(error: ProviderFailure): number | undefined {
  return nestedNumber(error, ["output", "statusCode"])
    ?? nestedNumber(error, ["statusCode"])
    ?? nestedNumber(error, ["status"]);
}

function classifyWhatsAppSendFailure(error: ProviderFailure): DeliveryFailureKind {
  if (error instanceof Error && isWhatsAppEncryptionPreparationFailure(error)) return "retryable";
  const status = providerStatusCode(error);
  return status === undefined
    ? "ambiguous"
    : classifyNonIdempotentProviderStatus(status);
}

function nestedNumber(value: ProviderFailure, path: string[]): number | undefined {
  let current: ProviderNode | number | undefined = value instanceof Error ? undefined : value ?? undefined;
  for (const key of path) {
    if (!current || Number(current) === current) return undefined;
    const node = providerNodeSchema.parse(current);
    current = key === "output" ? node.output : key === "statusCode" ? node.statusCode : node.status;
  }
  if (!Number.isFinite(current) || Number(current) !== current) return undefined;
  const status = Number(current);
  return Number.isFinite(status) && status === current ? status : undefined;
}

function disconnectReasonName(statusCode: number | undefined): string {
  switch (statusCode) {
    case 401:
      return "logged_out";
    case 403:
      return "forbidden";
    case 408:
      return "connection_lost";
    case 411:
      return "multidevice_mismatch";
    case 428:
      return "connection_closed";
    case 440:
      return "connection_replaced";
    case 500:
      return "bad_session";
    case 503:
      return "service_unavailable";
    case 515:
      return "restart_required";
    default:
      return "unknown";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function toError(error: Error | string | null | undefined, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
