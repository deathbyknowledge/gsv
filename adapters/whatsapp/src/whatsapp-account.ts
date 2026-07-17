/**
 * WhatsApp Account Durable Object
 * 
 * Manages a single WhatsApp account connection:
 * - Stores auth credentials in DO storage
 * - Maintains WebSocket connection to WhatsApp via Baileys
 * - Sends messages to Gateway via Service Binding RPC
 * - Receives outbound messages via HTTP endpoint
 */

import { DurableObject } from "cloudflare:workers";
import {
  classifyNonIdempotentProviderStatus,
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import {
  deliverAdapterInboundResponses,
  InboundDeliveryLedger,
} from "../../shared/src/inbound-delivery";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
  type AnyMessageContent,
  type LIDMapping,
  proto,
} from "@whiskeysockets/baileys";
import {
  getMediaKeys,
  getUrlFromDirectPath,
} from "@whiskeysockets/baileys/lib/Utils/messages-media";
import {
  binaryBodyFromOwnedBytes,
  bundleAdapterMedia,
  cancelResponseBody,
  cancelBinaryBody,
  readResponseBodyBytes,
  readAdapterMediaBody,
  validateAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
} from "../../shared/src/media-body";
import type { AdapterMediaPart } from "../../shared/src/media-body";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import type { WhatsAppAccountState } from "./types";
import type {
  AdapterAccountStatus,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
  GatewayFrame,
  GatewayRequestFrame,
} from "../../shared/src/types";

type GatewayChannelBinding = Fetcher & {
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
};

interface Env {
  // Direct service binding to Gateway entrypoint.
  GATEWAY: GatewayChannelBinding;
}

// Quiet logger for Baileys - suppresses verbose output
const noopLogger = {
  level: "silent",
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as any;

const MEDIA_CONTENT_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
]);
const MAX_MEDIA_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_PART_BYTES;
const MAX_ENCRYPTED_MEDIA_BODY_BYTES = MAX_MEDIA_BODY_BYTES + 32;
const INBOUND_DELIVERY_PREFIX = "pending_inbound:";
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;

function normalizeByteLength(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  let serialized: string;
  try {
    if (typeof value === "bigint" || typeof value === "string") {
      serialized = String(value);
    } else if (
      value
      && typeof value === "object"
      && typeof (value as { toString?: unknown }).toString === "function"
    ) {
      serialized = (value as { toString(): string }).toString();
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!/^\d+$/.test(serialized)) {
    return null;
  }
  const parsed = Number(serialized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeWhatsAppJid(jid: string | null | undefined): string | null {
  let normalized = (jid ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("wa:jid:")) {
    normalized = normalized.slice("wa:jid:".length);
  }
  return jidNormalizedUser(normalized) || normalized;
}

function isPnWhatsAppJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && isPnUser(jid) === true;
}

function isLidWhatsAppJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && isLidUser(jid) === true;
}

function preferredLidJid(
  primary: string | null | undefined,
  alternate: string | null | undefined,
): string | null {
  const normalizedPrimary = normalizeWhatsAppJid(primary);
  const normalizedAlternate = normalizeWhatsAppJid(alternate);
  if (isLidWhatsAppJid(normalizedPrimary)) return normalizedPrimary;
  if (isLidWhatsAppJid(normalizedAlternate)) return normalizedAlternate;
  return normalizedPrimary ?? normalizedAlternate;
}

function preferredPnJid(
  primary: string | null | undefined,
  alternate: string | null | undefined,
): string | undefined {
  const normalizedPrimary = normalizeWhatsAppJid(primary);
  const normalizedAlternate = normalizeWhatsAppJid(alternate);
  if (isPnWhatsAppJid(normalizedPrimary)) return normalizedPrimary;
  if (isPnWhatsAppJid(normalizedAlternate)) return normalizedAlternate;
  return undefined;
}

function normalizeOutboundWhatsAppJid(jid: string | null | undefined): string {
  let normalized = (jid ?? "").trim();
  if (!normalized) {
    throw new Error("WhatsApp JID is required");
  }
  if (normalized.startsWith("wa:jid:")) {
    normalized = normalized.slice("wa:jid:".length);
  }
  if (normalized.startsWith("+") && !normalized.includes("@")) {
    const digits = normalized.slice(1).replace(/\D/g, "");
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  if (/^\d+$/.test(normalized)) {
    return `${normalized}@s.whatsapp.net`;
  }
  return normalizeWhatsAppJid(normalized) ?? normalized.toLowerCase();
}

function phoneDigitsFromJid(jid: string | null | undefined): string | null {
  const normalized = normalizeWhatsAppJid(jid);
  const match = normalized?.match(/^(\d+)@s\.whatsapp\.net$/);
  return match?.[1] ?? null;
}

function phoneActorId(phoneDigits: string): string {
  return `wa:jid:${phoneDigits}@s.whatsapp.net`;
}

function jidActorId(jid: string): string {
  return `wa:jid:${jid}`;
}

function getMessageContextInfo(
  message: proto.IMessage | null | undefined,
  contentType: keyof proto.IMessage | undefined,
): proto.IContextInfo | undefined {
  if (!message || !contentType) return undefined;
  const content = message[contentType];
  if (!content || typeof content !== "object") return undefined;
  return (content as { contextInfo?: proto.IContextInfo | null }).contextInfo ?? undefined;
}

class WhatsAppPreparationError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyWhatsAppSendFailure(
  error: unknown,
): "retryable" | "permanent" | "ambiguous" {
  const status = nestedNumber(error, ["output", "statusCode"])
    ?? nestedNumber(error, ["statusCode"])
    ?? nestedNumber(error, ["status"]);
  if (status === undefined) {
    return "ambiguous";
  }
  return classifyNonIdempotentProviderStatus(status);
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : undefined;
}

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<Uint8Array>;
  private state: WhatsAppAccountState = {
    accountId: "",
    connected: false,
  };
  private qrCode: string | null = null;
  private waitResolvers: Array<(result: { connected?: boolean; qr?: string }) => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_DELIVERY_PREFIX,
    );
    // accountId is set from X-Account-Id header on first request
    // and persisted in storage.kv for subsequent requests
    const storedAccountId = this.ctx.storage.kv.get<string>("accountId");
    this.state.accountId = storedAccountId || "";
  }

  /**
   * HTTP fetch handler - internal API for WhatsAppChannel entrypoint
   */
  async fetch(request: Request): Promise<Response> {
    // Ensure accountId is set from header (required on all requests)
    const headerAccountId = request.headers.get("X-Account-Id");
    const traceId = request.headers.get("X-Trace-Id")?.trim() || "no-trace";
    if (headerAccountId && !this.state.accountId) {
      this.state.accountId = headerAccountId;
      this.ctx.storage.kv.put("accountId", headerAccountId);
      console.log(`[WA] Set accountId from header: ${headerAccountId}`);
    }
    
    if (!this.state.accountId) {
      return Response.json({ error: "Missing X-Account-Id header" }, { status: 400 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    console.log(
      `[whatsapp.do:${traceId}] fetch accountId=${this.state.accountId} method=${request.method} path=${path}${url.search}`,
    );

    try {
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url, request.method === "POST", traceId);
        case "/logout":
          return await this.handleLogout();
        case "/typing":
          return await this.handleTyping(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      console.error(`[WhatsAppAccount] Error handling ${path}:`, e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private handleStatus(): Response {
    return Response.json({
      accountId: this.state.accountId,
      connected: this.state.connected,
      selfJid: this.state.selfJid,
      selfE164: this.state.selfE164,
      lastConnectedAt: this.state.lastConnectedAt,
      lastMessageAt: this.state.lastMessageAt,
      hasSocket: this.sock !== null,
    });
  }

  private async handleLogin(url: URL, isPost: boolean, traceId: string): Promise<Response> {
    const force = url.searchParams.get("force") === "true";
    console.log(
      `[whatsapp.do:${traceId}] handleLogin accountId=${this.state.accountId} force=${force ? "true" : "false"} isPost=${isPost ? "true" : "false"} connected=${this.state.connected ? "true" : "false"} hasSocket=${this.sock ? "true" : "false"}`,
    );
    
    // If already connected, return success
    if (this.state.connected && this.sock) {
      console.log(`[whatsapp.do:${traceId}] handleLogin already connected`);
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Only clear auth if explicitly requested with force=true
    // This prevents rate-limiting issues from repeated new device pairing attempts
    const hasAuth = await hasAuthState(this.ctx.storage);
    console.log(`[whatsapp.do:${traceId}] handleLogin hasAuth=${hasAuth ? "true" : "false"}`);
    if (force && hasAuth) {
      console.log(`[WA] Force login: clearing existing auth state`);
      await clearAuthState(this.ctx.storage);
    }

    // Mark login as pending BEFORE starting socket
    // This prevents alarm from interfering with the login flow
    await this.ctx.storage.put("login_pending", Date.now());
    
    // Start the socket
    if (!this.sock) {
      console.log(`[whatsapp.do:${traceId}] handleLogin starting socket`);
      await this.startSocket();
    }

    // Wait for QR code to be generated (60s to allow time for scanning)
    const result = await this.waitForQrOrConnection(60000);
    console.log(
      `[whatsapp.do:${traceId}] handleLogin wait result connected=${result.connected ? "true" : "false"} qr=${result.qr ? "true" : "false"}`,
    );
    
    if (result.connected) {
      // Login succeeded - clear pending flag and schedule keep-alive
      await this.ctx.storage.delete("login_pending");
      await this.inboundDeliveries.arm(Date.now() + 10000);
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      // Schedule alarm to keep DO alive during QR scan window
      await this.inboundDeliveries.arm(Date.now() + 5000);
      
      return Response.json({ 
        connected: false, 
        qr: result.qr,
        message: "Scan QR code with WhatsApp" 
      });
    }

    // Login failed - clear pending flag
    await this.ctx.storage.delete("login_pending");
    return Response.json({ 
      connected: false, 
      message: "Failed to get QR code" 
    }, { status: 500 });
  }

  private async handleLogout(): Promise<Response> {
    console.log(`[WA] Logout requested`);
    
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    await clearAuthState(this.ctx.storage);
    await this.ctx.storage.delete("login_pending");
    
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    console.log(`[WA] Logged out successfully`);
    return Response.json({ success: true, message: "Logged out" });
  }

  async sendMessage(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    if (this.state.accountId && this.state.accountId !== accountId) {
      await cancelBinaryBody(body, "WhatsApp account ID mismatch");
      return { ok: false, error: "WhatsApp account ID mismatch" };
    }
    if (!this.state.accountId) {
      this.state.accountId = accountId;
      this.ctx.storage.kv.put("accountId", accountId);
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
    if (media.length > 1) {
      await cancelBinaryBody(body, "WhatsApp supports one media attachment per message");
      return {
        ok: false,
        error: "WhatsApp supports one media attachment per message",
      };
    }

    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: toErrorMessage(error) };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Could not read WhatsApp media body: ${toErrorMessage(error)}`,
        retryable: true,
      };
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintOutboundDelivery(message, mediaBytes);
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint WhatsApp delivery: ${toErrorMessage(error)}`,
        retryable: true,
      };
    }

    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, requestFingerprint);
    } catch (error) {
      return {
        ok: false,
        error: `WhatsApp delivery ledger unavailable: ${toErrorMessage(error)}`,
        retryable: true,
      };
    }
    if (!claim.claimed) {
      return claim.result;
    }

    const { attemptId } = claim;
    const fail = async (
      kind: "retryable" | "permanent" | "ambiguous",
      error: string,
    ): Promise<AdapterSendResult> => {
      try {
        if (kind === "retryable") {
          await this.deliveries.releaseRetryable(message.deliveryId, attemptId);
        } else if (kind === "ambiguous") {
          await this.deliveries.failAmbiguous(message.deliveryId, attemptId, error);
        } else {
          await this.deliveries.failPermanent(message.deliveryId, attemptId, error);
        }
      } catch (ledgerError) {
        console.error(`[WA:${this.state.accountId}] Failed to persist delivery outcome`, ledgerError);
      }
      return {
        ok: false,
        error,
        ...(kind === "retryable" ? { retryable: true } : {}),
        ...(kind === "ambiguous" ? { ambiguous: true } : {}),
      };
    };

    let jid: string;
    let content: AnyMessageContent;
    let quoted: WAMessage | undefined;
    try {
      const outboundMediaBytes = media[0]?.url
        ? await this.downloadOutboundMedia(media[0])
        : mediaBytes[0];
      jid = await this.resolveOutboundWhatsAppJid(message.surface.id);
      content = this.buildOutboundContent(message, outboundMediaBytes);
      quoted = this.buildQuotedMessage(jid, message);
    } catch (error) {
      const kind = error instanceof WhatsAppPreparationError && error.retryable
        ? "retryable"
        : "permanent";
      return await fail(kind, toErrorMessage(error));
    }

    const socket = this.sock;
    if (!socket || !this.state.connected) {
      return await fail("retryable", "WhatsApp account disconnected before delivery");
    }

    let sent: Awaited<ReturnType<WASocket["sendMessage"]>>;
    try {
      sent = await socket.sendMessage(jid, content, quoted ? { quoted } : undefined);
    } catch (error) {
      console.error("[WA] Send failed after provider attempt:", error);
      const kind = classifyWhatsAppSendFailure(error);
      const detail = kind === "ambiguous"
        ? "WhatsApp send outcome is unknown"
        : "WhatsApp rejected the send";
      return await fail(
        kind,
        `${detail}: ${toErrorMessage(error)}`,
      );
    }

    const messageId = sent?.key?.id ?? undefined;
    try {
      await this.deliveries.succeed(message.deliveryId, attemptId, messageId);
    } catch (error) {
      console.error(`[WA:${this.state.accountId}] Failed to persist successful delivery`, error);
      return {
        ok: false,
        error: "WhatsApp accepted the delivery but its durable outcome could not be recorded",
        ambiguous: true,
      };
    }
    console.log(`[WA] Sent to ${jid}: "${message.text.substring(0, 50)}..."`);
    return { ok: true, messageId };
  }

  /**
   * Handle typing indicator from Gateway
   */
  private async handleTyping(request: Request): Promise<Response> {
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const { peer, typing } = await request.json() as { peer: AdapterSurface; typing: boolean };
    const jid = await this.resolveOutboundWhatsAppJid(peer.id);

    try {
      const presence = typing ? "composing" : "paused";
      await this.sock.sendPresenceUpdate(presence, jid);
      return Response.json({ ok: true });
    } catch (e) {
      // Typing is best-effort
      return Response.json({ ok: true });
    }
  }

  private buildOutboundContent(
    message: AdapterOutboundMessage,
    mediaBytes?: Uint8Array,
  ): AnyMessageContent {
    const media = message.media?.[0];
    if (media) {
      return this.buildMediaContent(media, mediaBytes, message.text);
    }

    const text = message.text.trim();
    if (!text) {
      throw new Error("WhatsApp messages require text or media");
    }
    return { text };
  }

  private buildQuotedMessage(
    remoteJid: string,
    message: AdapterOutboundMessage,
  ): WAMessage | undefined {
    const replyToId = message.replyToId?.trim();
    if (!replyToId) return undefined;

    let participant: string | undefined;
    if (message.actorId) {
      try {
        participant = normalizeOutboundWhatsAppJid(message.actorId);
      } catch {
        participant = undefined;
      }
    }
    return {
      key: {
        id: replyToId,
        remoteJid,
        fromMe: false,
        ...(participant ? { participant } : {}),
      },
      participant,
      // The gateway intentionally transports only the stable provider message
      // id. Baileys still needs a message shape to construct reply context.
      message: { conversation: "" },
    };
  }

  private buildMediaContent(
    media: AdapterMedia,
    bytes: Uint8Array | undefined,
    captionText: string,
  ): AnyMessageContent {
    const upload = this.buildMediaUpload(media, bytes);
    const caption = captionText.trim() || undefined;

    switch (media.type) {
      case "image":
        return {
          image: upload,
          mimetype: media.mimeType,
          ...(caption ? { caption } : {}),
        };
      case "video":
        return {
          video: upload,
          mimetype: media.mimeType,
          ...(caption ? { caption } : {}),
        };
      case "audio":
        return {
          audio: upload,
          mimetype: media.mimeType,
        };
      case "document":
      default:
        return {
          document: upload,
          mimetype: media.mimeType || "application/octet-stream",
          fileName: media.filename || "attachment",
          ...(caption ? { caption } : {}),
        };
    }
  }

  private buildMediaUpload(
    media: AdapterMedia,
    bytes?: Uint8Array,
  ): Buffer | { url: string } {
    if (bytes) {
      return Buffer.from(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
    }
    if (media.url) {
      throw new Error("WhatsApp URL media must be downloaded before upload");
    }
    throw new Error("Media attachment must include a binary body or URL");
  }

  private async downloadOutboundMedia(media: AdapterMedia): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(media.url!);
    } catch (error) {
      throw new WhatsAppPreparationError(
        `Could not download WhatsApp media: ${toErrorMessage(error)}`,
        true,
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response, "WhatsApp media download failed");
      throw new WhatsAppPreparationError(
        `Failed to fetch WhatsApp media (${response.status} ${response.statusText})`,
        response.status === 408
          || response.status === 429
          || response.status >= 500,
      );
    }
    try {
      return await readResponseBodyBytes(response, {
        maxBytes: MAX_MEDIA_BODY_BYTES,
        expectedBytes: media.size,
        label: "WhatsApp media",
      });
    } catch (error) {
      const detail = toErrorMessage(error);
      throw new WhatsAppPreparationError(
        detail,
        !detail.includes("exceeds transfer limit"),
      );
    }
  }

  private async resolveOutboundWhatsAppJid(jidOrPhone: string): Promise<string> {
    const jid = normalizeOutboundWhatsAppJid(jidOrPhone);
    if (!isPnWhatsAppJid(jid)) {
      return jid;
    }

    const lid = await this.lookupLidForPN(jid);
    return lid ?? jid;
  }

  private async startSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useDOAuthState(this.ctx.storage);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      version,
      logger: noopLogger,
      printQRInTerminal: false,
      browser: ["GSV Channel", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on("lid-mapping.update", (mapping) => {
      this.rememberLidPnMapping(mapping).catch((e) => {
        console.error(`[WA:${this.state.accountId}] LID mapping update failed:`, e);
      });
    });
    this.sock.ev.on("messaging-history.set", ({ lidPnMappings }) => {
      this.rememberLidPnMappings(lidPnMappings).catch((e) => {
        console.error(`[WA:${this.state.accountId}] History LID mappings update failed:`, e);
      });
    });
    this.sock.ev.on("messages.upsert", (m) => {
      this.ctx.waitUntil(
        this.handleMessagesUpsert(m).catch((e) => {
          console.error(`[WA:${this.state.accountId}] Message handling error:`, e);
        }),
      );
    });
  }

  private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]>): void {
    const { connection, lastDisconnect, qr } = update;
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
    console.log(
      `[WA:${this.state.accountId}] connection.update connection=${connection ?? "none"} qr=${qr ? "true" : "false"} statusCode=${statusCode ?? "none"}`,
    );

    if (qr) {
      this.qrCode = qr;
      console.log(`[WA:${this.state.accountId}] QR received`);
      this.resolveWaiters({ qr });
    }

    if (connection === "open") {
      this.state.connected = true;
      this.state.lastConnectedAt = Date.now();
      this.state.selfJid = this.sock?.user?.id;
      
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      this.ctx.storage.delete("login_pending").catch(() => {});
      console.log(`[WA:${this.state.accountId}] Connected as ${this.state.selfE164 || this.state.selfJid}`);
      this.resolveWaiters({ connected: true });
      
      this.notifyGatewayStatus().catch(() => {});
      this.ctx.waitUntil(this.scheduleKeepAlive());
    }

    if (connection === "close") {
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isConnectionReplaced = statusCode === 515;
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();
      this.sock = null;
      this.resolveWaiters({});

      if (isLoggedOut) {
        this.state.selfJid = undefined;
        this.state.selfE164 = undefined;
        clearAuthState(this.ctx.storage);
        this.ctx.storage.delete("login_pending").catch(() => {});
      } else if (isConnectionReplaced) {
        this.ctx.storage.delete("login_pending").catch(() => {});
      } else {
        this.ctx.waitUntil(this.inboundDeliveries.arm(Date.now() + 5000));
      }

      this.notifyGatewayStatus().catch(() => {});
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      const messageId = msg.key.id;
      if (!messageId) continue;

      const deliveryId = this.whatsAppInboundDeliveryId(msg);
      const encoded = proto.WebMessageInfo.encode(msg).finish();
      await this.inboundDeliveries.enqueueAndArm(
        deliveryId,
        encoded,
        Date.now() + INBOUND_RETRY_DELAY_MS,
      );
      await this.deliverPendingInbound(deliveryId);
    }
  }

  private whatsAppInboundDeliveryId(msg: WAMessage): string {
    return [
      normalizeWhatsAppJid(msg.key.remoteJid) ?? "unknown",
      normalizeWhatsAppJid(msg.key.participant) ?? "",
      msg.key.id ?? "",
    ].join(":");
  }

  private async deliverPendingInbound(deliveryId: string): Promise<void> {
    const attempt = await this.inboundDeliveries.attempt(
      deliveryId,
      async (encoded) => {
        const decoded = proto.WebMessageInfo.decode(encoded);
        if (!decoded.key) return { terminal: true };
        return this.forwardInboundMessage(decoded as WAMessage);
      },
    );
    if (attempt.state !== "pending") return;

    console.error(
      `[WA:${this.state.accountId}] Inbound ${deliveryId} remains pending: ${attempt.error ?? "Gateway receipt is still in progress"}`,
    );
    await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
  }

  private async retryPendingInbound(): Promise<void> {
    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const deliveryId of ids) {
      await this.deliverPendingInbound(deliveryId);
    }
  }

  private async forwardInboundMessage(
    msg: WAMessage,
  ): Promise<{ terminal: boolean; error?: string }> {
    const extracted = extractMessageContent(msg.message);
    const contentType = extracted ? getContentType(extracted) : undefined;
    const contextInfo = getMessageContextInfo(extracted, contentType);
    const hasMedia = !!contentType && MEDIA_CONTENT_TYPES.has(contentType);

    const extractedMedia = (hasMedia && extracted && contentType)
      ? (extracted as Record<string, unknown>)[contentType] as
          | { caption?: string; text?: string }
          | undefined
      : undefined;

    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || extractedMedia?.caption
      || extractedMedia?.text
      || msg.message?.imageMessage?.caption
      || msg.message?.videoMessage?.caption
      || (hasMedia ? "" : undefined);

    if (text === undefined) return { terminal: true };

    const remoteJid = normalizeWhatsAppJid(msg.key.remoteJid);
    if (!remoteJid) return { terminal: true };
    const remoteJidAlt = normalizeWhatsAppJid(msg.key.remoteJidAlt);
    const isGroup = remoteJid.endsWith("@g.us");
    const dmPn = preferredPnJid(remoteJid, remoteJidAlt);
    const deliveryJid = isGroup
      ? remoteJid
      : preferredLidJid(remoteJid, remoteJidAlt) ?? remoteJid;
    const surfaceJid = isGroup ? remoteJid : dmPn ?? remoteJid;
    const participantJid = preferredLidJid(
      msg.key.participant,
      msg.key.participantAlt,
    );
    const participantPn = preferredPnJid(
      msg.key.participant,
      msg.key.participantAlt,
    );
    const actorId = isGroup
      ? await this.resolveStableWhatsAppActorId(
          participantJid,
          participantPn,
        )
      : await this.resolveStableWhatsAppActorId(
          deliveryJid,
          dmPn,
        );
    if (!actorId) return { terminal: true };
    const wasMentioned = !isGroup
      || this.isGroupMessageAddressedToSelf(contextInfo);

    const mediaParts: AdapterMediaPart[] = [];
    if (hasMedia) {
      try {
        const attachment = await this.downloadMedia(msg);
        if (attachment) {
          mediaParts.push(attachment);
        }
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Media download failed:`, e);
      }
    }
    const media = await bundleAdapterMedia(mediaParts);

    const inbound: AdapterInboundMessage = {
      messageId: msg.key.id!,
      surface: {
        kind: isGroup ? "group" : "dm",
        id: surfaceJid,
        name: msg.pushName ?? undefined,
      },
      actor: {
        id: actorId,
        name: msg.pushName ?? undefined,
        handle: actorId,
      },
      text: text || (
        media.media.length > 0
          ? "[Media]"
          : hasMedia
            ? "[Media unavailable]"
            : ""
      ),
      media: media.media.length > 0 ? media.media : undefined,
      replyToId: contextInfo?.stanzaId ?? undefined,
      timestamp: msg.messageTimestamp as number,
      wasMentioned,
    };
    console.log(
      `[WA:${this.state.accountId}] inbound actorId=${actorId} surfaceJid=${surfaceJid} deliveryJid=${deliveryJid} remoteJid=${remoteJid} remoteJidAlt=${remoteJidAlt ?? ""} participant=${participantJid ?? ""} participantPn=${participantPn ?? ""}`,
    );

    const result = await this.callGateway<AdapterInboundResult>(
      "adapter.inbound",
      {
        adapter: "whatsapp",
        accountId: this.state.accountId,
        message: inbound,
      },
      media.body,
    );
    const responseDisposition = await deliverAdapterInboundResponses(result, {
      surface: inbound.surface,
      providerMessageId: inbound.messageId,
      send: (response) => this.sendMessage(this.state.accountId!, response),
    });
    if (!responseDisposition.terminal) return responseDisposition;
    if (!result.ok) {
      console.error(
        `[WA:${this.state.accountId}] Gateway RPC inbound rejected: ${result.error || "unknown error"}`,
      );
      return { terminal: true };
    }
    this.state.lastMessageAt = Date.now();
    return { terminal: true };
  }

  private isGroupMessageAddressedToSelf(
    contextInfo: proto.IContextInfo | undefined,
  ): boolean {
    if (!contextInfo) return false;

    const ownJids = new Set<string>();
    const addOwnJid = (jid: string | null | undefined): void => {
      const normalized = normalizeWhatsAppJid(jid);
      if (normalized) ownJids.add(normalized);
    };

    addOwnJid(this.state.selfJid);
    addOwnJid(this.sock?.user?.id);
    addOwnJid(this.sock?.user?.lid);
    addOwnJid(this.sock?.user?.phoneNumber);
    const selfPhoneDigits = this.state.selfE164?.replace(/\D/g, "");
    if (selfPhoneDigits) {
      addOwnJid(`${selfPhoneDigits}@s.whatsapp.net`);
    }
    if (ownJids.size === 0) return false;

    const matchesSelf = (jid: string | null | undefined): boolean => {
      const normalized = normalizeWhatsAppJid(jid);
      return normalized ? ownJids.has(normalized) : false;
    };

    if (contextInfo.mentionedJid?.some((jid) => matchesSelf(jid))) {
      return true;
    }

    return Boolean(
      contextInfo.quotedMessage
      && matchesSelf(contextInfo.participant),
    );
  }

  private async resolveStableWhatsAppActorId(
    jid: string | null | undefined,
    alternatePnJid?: string,
  ): Promise<string | null> {
    const normalizedJid = normalizeWhatsAppJid(jid);
    if (!normalizedJid) return null;

    const phoneDigits = phoneDigitsFromJid(alternatePnJid) ?? phoneDigitsFromJid(normalizedJid);
    if (phoneDigits) {
      const canonical = phoneActorId(phoneDigits);
      await this.rememberActorAlias(jidActorId(normalizedJid), canonical);
      await this.rememberLidAliasForPhone(phoneDigits, canonical);
      return canonical;
    }

    const rawActorId = jidActorId(normalizedJid);
    const aliased = await this.lookupActorAlias(rawActorId);
    return aliased ?? rawActorId;
  }

  private async rememberLidAliasForPhone(phoneDigits: string, canonicalActorId: string): Promise<void> {
    const lid = await this.lookupLidForPN(`${phoneDigits}@s.whatsapp.net`);
    if (!lid) return;
    await this.rememberActorAlias(jidActorId(lid), canonicalActorId);
  }

  private async lookupLidForPN(pnJid: string): Promise<string | null> {
    if (!this.sock) return null;

    const normalizedPn = normalizeWhatsAppJid(pnJid);
    if (!isPnWhatsAppJid(normalizedPn)) return null;

    try {
      const lid = await this.sock.signalRepository.lidMapping.getLIDForPN(normalizedPn);
      const normalizedLid = normalizeWhatsAppJid(lid);
      if (!isLidWhatsAppJid(normalizedLid)) return null;
      await this.rememberLidPnMapping({ pn: normalizedPn, lid: normalizedLid });
      return normalizedLid;
    } catch (error) {
      console.warn(`[WA:${this.state.accountId}] Failed to resolve LID for ${normalizedPn}`, error);
      return null;
    }
  }

  private async rememberLidPnMappings(mappings: LIDMapping[] | undefined): Promise<void> {
    if (!mappings?.length) return;
    await Promise.all(mappings.map((mapping) => this.rememberLidPnMapping(mapping)));
  }

  private async rememberLidPnMapping(mapping: LIDMapping): Promise<void> {
    const pn = normalizeWhatsAppJid(mapping.pn);
    const lid = normalizeWhatsAppJid(mapping.lid);
    if (!isPnWhatsAppJid(pn) || !isLidWhatsAppJid(lid)) return;

    const phoneDigits = phoneDigitsFromJid(pn);
    const canonicalActorId = phoneDigits ? phoneActorId(phoneDigits) : jidActorId(pn);
    await this.rememberActorAlias(jidActorId(lid), canonicalActorId);
  }

  private async rememberActorAlias(aliasActorId: string, canonicalActorId: string): Promise<void> {
    if (!aliasActorId || !canonicalActorId || aliasActorId === canonicalActorId) return;
    await this.ctx.storage.put(`actor_alias:${aliasActorId}`, canonicalActorId);
  }

  private async lookupActorAlias(aliasActorId: string): Promise<string | null> {
    const alias = await this.ctx.storage.get<string>(`actor_alias:${aliasActorId}`);
    return typeof alias === "string" && alias.trim().length > 0 ? alias : null;
  }

  /**
   * Download media from a WhatsApp message
   */
  private async downloadMedia(msg: WAMessage): Promise<AdapterMediaPart | null> {
    if (!this.sock) return null;

    const mContent = extractMessageContent(msg.message);
    if (!mContent) return null;

    const contentType = getContentType(mContent);
    if (!contentType) return null;

    let mediaType: AdapterMedia["type"];
    let mimeType: string;
    let filename: string | undefined;
    let baileysMediaType: string;

    const mediaNode = (mContent as Record<string, unknown>)[contentType] as
      | {
          mimetype?: string;
          caption?: string;
          fileName?: string;
          url?: string;
          directPath?: string;
          mediaKey?: Uint8Array | Buffer;
          fileLength?: unknown;
        }
      | undefined;

    if (!mediaNode || typeof mediaNode !== "object") return null;

    if (contentType === "imageMessage") {
      mediaType = "image";
      mimeType = mediaNode.mimetype || "image/jpeg";
      filename = mediaNode.caption ?? undefined;
      baileysMediaType = "image";
    } else if (contentType === "videoMessage") {
      mediaType = "video";
      mimeType = mediaNode.mimetype || "video/mp4";
      filename = mediaNode.caption ?? undefined;
      baileysMediaType = "video";
    } else if (contentType === "audioMessage") {
      mediaType = "audio";
      mimeType = mediaNode.mimetype || "audio/ogg";
      baileysMediaType = "audio";
    } else if (contentType === "documentMessage") {
      mediaType = "document";
      mimeType = mediaNode.mimetype || "application/octet-stream";
      filename = mediaNode.fileName ?? undefined;
      baileysMediaType = "document";
    } else {
      return null;
    }

    const media = mediaNode;

    if (!media || typeof media !== "object") return null;
    if (!media.url && !media.directPath) return null;
    if (!media.mediaKey) return null;
    if (media.fileLength !== undefined) {
      const fileLength = normalizeByteLength(media.fileLength);
      if (fileLength === null || fileLength > MAX_MEDIA_BODY_BYTES) {
        return null;
      }
    }

    const isValidMediaUrl = media.url?.startsWith("https://mmg.whatsapp.net/");
    const downloadUrl = isValidMediaUrl ? media.url : getUrlFromDirectPath(media.directPath!);
    if (!downloadUrl) return null;

    const keys = await getMediaKeys(media.mediaKey, baileysMediaType as any);

    const response = await fetch(downloadUrl, {
      headers: { Origin: "https://web.whatsapp.com" },
    });

    if (!response.ok) {
      await cancelResponseBody(response, "WhatsApp media download failed");
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }

    const encryptedData = await readResponseBodyBytes(response, {
      maxBytes: MAX_ENCRYPTED_MEDIA_BODY_BYTES,
      label: "Encrypted WhatsApp media",
    });
    if (encryptedData.byteLength <= 10) {
      throw new Error("Encrypted WhatsApp media is truncated");
    }
    const ciphertext = encryptedData.subarray(0, -10);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keys.cipherKey,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: keys.iv },
      cryptoKey,
      ciphertext
    );

    const decryptedArray = new Uint8Array(decrypted);
    if (decryptedArray.byteLength > MAX_MEDIA_BODY_BYTES) {
      throw new Error("WhatsApp media exceeds transfer limit");
    }
    return {
      media: {
        type: mediaType,
        mimeType,
        filename,
        size: decryptedArray.byteLength,
      },
      body: binaryBodyFromOwnedBytes(decryptedArray),
    };
  }

  /**
   * Notify Gateway of status change via Service Binding RPC.
   */
  private async notifyGatewayStatus(): Promise<void> {
    if (!this.state.accountId) return;
    
    try {
      const status: AdapterAccountStatus = {
        accountId: this.state.accountId,
        connected: this.state.connected,
        authenticated: !!this.state.selfJid,
        mode: "websocket",
        lastActivity: this.state.lastMessageAt,
        extra: { selfJid: this.state.selfJid, selfE164: this.state.selfE164 },
      };

      await this.callGateway(
        "adapter.state.update",
        {
          adapter: "whatsapp",
          accountId: this.state.accountId,
          status,
        },
      );
    } catch (e) {
      // Status updates are best-effort.
      console.error(`[WA:${this.state.accountId}] Gateway RPC status failed:`, e);
    }
  }

  private async callGateway<T = unknown>(
    call: string,
    args: unknown,
    body?: BinaryBody,
  ): Promise<T> {
    const frame: GatewayRequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
      ...(body ? { body } : {}),
    };

    let response: GatewayFrame | null;
    try {
      response = await this.env.GATEWAY.serviceFrame(frame);
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    if (!response || response.type !== "res") {
      await cancelBinaryBody(body, "No response from gateway serviceFrame");
      throw new Error("No response from gateway serviceFrame");
    }
    if (!response.ok) {
      throw new Error(response.error?.message || `Gateway error on ${call}`);
    }

    return (response.data ?? {}) as T;
  }

  private waitForQrOrConnection(timeoutMs: number): Promise<{ connected?: boolean; qr?: string }> {
    return new Promise((resolve) => {
      if (this.state.connected) {
        resolve({ connected: true });
        return;
      }

      if (this.qrCode) {
        resolve({ qr: this.qrCode });
        return;
      }

      const timeout = setTimeout(() => {
        console.warn(`[WA:${this.state.accountId}] waitForQrOrConnection timed out after ${timeoutMs}ms`);
        resolve({});
      }, timeoutMs);

      this.waitResolvers.push((result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  private resolveWaiters(result: { connected?: boolean; qr?: string }): void {
    if (this.waitResolvers.length === 0) return;
    const waiters = this.waitResolvers;
    this.waitResolvers = [];
    for (const resolve of waiters) {
      resolve(result);
    }
  }

  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000;

  private async scheduleKeepAlive(): Promise<void> {
    await this.inboundDeliveries.arm(
      Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS,
    );
  }

  async alarm(): Promise<void> {
    const hasAuth = await hasAuthState(this.ctx.storage);
    const loginPending = await this.ctx.storage.get<number>("login_pending");
    
    // Keep alive during login flow
    if (loginPending && Date.now() - loginPending < 90000) {
      await this.inboundDeliveries.arm(Date.now() + 5000);
      return;
    }
    
    if (loginPending) {
      await this.ctx.storage.delete("login_pending");
    }

    if (!hasAuth) return;
    // The same alarm owns keep-alive, reconnect, and ingress retry.
    await this.scheduleKeepAlive();

    // Reconnect if needed
    if (!this.sock) {
      try {
        await this.startSocket();
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Reconnect failed:`, e);
      }
    }

    await this.retryPendingInbound();
  }
}
